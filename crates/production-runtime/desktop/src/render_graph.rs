//! Producer render/1 fragment ABI. Resource allocation and platform handles
//! belong to the backend. Authored programs see two read-only input textures.
use anyhow::{anyhow, ensure, Context, Result};
use naga::{back::msl, valid, ShaderStage, Statement};
use std::ffi::CString;

// This output pass opts into the existing two-axis shader input as frame
// position. Older runtimes can still compile the graph at its centered pose.
pub(crate) fn supports_frame_drag(set: &producer_production_contract::Set, layout: &str) -> bool {
    use producer_production_contract::GraphPass;
    set.output_graphs.get(layout)
        .and_then(|id| set.graphs.get(id))
        .and_then(|graph| graph.passes.last())
        .is_some_and(|pass| matches!(pass, GraphPass::Fragment { id, .. } if id == "camera-frame-motion"))
}

pub const PRELUDE: &str = r#"
struct Frame { info: vec4<f32>, params: vec4<f32>, controls: vec4<f32>, screenPan: vec2<f32>, headline: f32, dj: vec4<f32> }
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var input0: texture_2d<f32>;
@group(0) @binding(2) var input1: texture_2d<f32>;
@group(0) @binding(3) var linear_sampler: sampler;
@fragment fn render_fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = position.xy / frame.info.xy;
"#;

pub struct Program {
    pub source: CString,
    pub entry: CString,
}

/// Validate all authored passes, including those used by another layout.
pub fn inspect(set: &producer_production_contract::Set) -> Result<serde_json::Value> {
    use producer_production_contract::GraphPass;
    use sha2::{Digest, Sha256};
    let mut result = std::collections::BTreeMap::new();
    for (name, graph) in &set.graphs {
        let mut passes = Vec::new();
        for pass in &graph.passes {
            if let GraphPass::Composite { id } = pass {
                passes.push(serde_json::json!({"pass":id,"kind":"composite"}));
                continue;
            }
            if let GraphPass::Geometry { id,scene,.. } = pass {
                passes.push(serde_json::json!({"pass":id,"kind":"geometry","meshInstances":scene.objects.len()}));
                continue;
            }
            let GraphPass::Fragment {
                id, shader, inputs, ..
            } = pass else { unreachable!() };
            let program = compile(shader, inputs.len()).with_context(|| format!("{name}/{id}"))?;
            passes.push(serde_json::json!({"pass":id,"metalSha256":format!("{:x}",Sha256::digest(program.source.as_bytes()))}));
        }
        result.insert(name, passes);
    }
    Ok(serde_json::to_value(result)?)
}

fn check_block(block: &naga::Block) -> Result<()> {
    for statement in block {
        match statement {
            Statement::Block(b) => check_block(b)?,
            Statement::If { accept, reject, .. } => {
                check_block(accept)?;
                check_block(reject)?;
            }
            Statement::Switch { cases, .. } => {
                for case in cases {
                    check_block(&case.body)?;
                }
            }
            Statement::Emit(_) | Statement::Return { .. } | Statement::Store { .. } => {}
            _ => anyhow::bail!("render/1 supports bounded fragment arithmetic and branches only"),
        }
    }
    Ok(())
}

pub fn compile(body: &str, input_count: usize) -> Result<std::sync::Arc<Program>> {
    use std::sync::{Arc, Mutex, OnceLock};
    type Entry = (String, usize, Arc<Program>);
    static CACHE: OnceLock<Mutex<std::collections::VecDeque<Entry>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some((_, _, program)) = cache
        .lock()
        .unwrap()
        .iter()
        .find(|(s, n, _)| s == body && *n == input_count)
    {
        return Ok(program.clone());
    }
    let result = Arc::new(translate(body, input_count)?);
    let mut entries = cache.lock().unwrap();
    if entries.len() >= 128 {
        entries.pop_front();
    }
    entries.push_back((body.to_owned(), input_count, result.clone()));
    Ok(result)
}

fn translate(body: &str, input_count: usize) -> Result<Program> {
    ensure!(
        body.len() <= 8192 && input_count <= 2,
        "fragment exceeds render/1 limits"
    );
    let source = format!("{PRELUDE}{body}\n}}");
    let module = naga::front::wgsl::parse_str(&source)
        .map_err(|e| anyhow!("{}", e.emit_to_string(&source)))?;
    ensure!(
        module.entry_points.len() == 1
            && module.functions.is_empty()
            && module.global_variables.len() == 4
            && module.overrides.is_empty(),
        "unexpected shader declarations"
    );
    let ep = &module.entry_points[0];
    ensure!(
        ep.stage == ShaderStage::Fragment && ep.function.expressions.len() <= 512,
        "fragment instruction budget exceeded"
    );
    for (_, ty) in module.types.iter() {
        ensure!(
            !matches!(
                ty.inner,
                naga::TypeInner::Array { .. } | naga::TypeInner::BindingArray { .. }
            ),
            "array resources require another graph profile"
        );
    }
    check_block(&ep.function.body)?;
    let info = valid::Validator::new(valid::ValidationFlags::all(), valid::Capabilities::empty())
        .validate(&module)
        .map_err(|e| anyhow!("{}", e.emit_to_string(&source)))?;
    let used = info.get_entry_point(0);
    let mut resources = msl::EntryPointResources::default();
    for (handle, var) in module.global_variables.iter() {
        let b = var.binding.ok_or_else(|| anyhow!("unbound resource"))?;
        let mut target = msl::BindTarget::default();
        match b.binding {
            0 => target.buffer = Some(0),
            slot @ (1 | 2) => {
                ensure!(
                    used[handle].is_empty() || slot as usize <= input_count,
                    "shader samples undeclared input {}",
                    slot - 1
                );
                target.texture = Some((slot - 1) as u8);
            }
            3 => target.sampler = Some(msl::BindSamplerTarget::Resource(0)),
            _ => anyhow::bail!("unsupported resource binding"),
        }
        resources.resources.insert(b, target);
    }
    let mut options = msl::Options {
        lang_version: (2, 3),
        fake_missing_bindings: false,
        ..Default::default()
    };
    options
        .per_entry_point_map
        .insert(ep.name.clone(), resources);
    let (source, translation) = msl::write_string(&module, &info, &options, &Default::default())
        .context("translating WGSL to Metal")?;
    let entry = translation
        .entry_point_names
        .into_iter()
        .next()
        .context("missing fragment entry")?
        .map_err(|e| anyhow!("fragment binding: {e:?}"))?;
    Ok(Program {
        source: CString::new(source)?,
        entry: CString::new(entry)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atmosphere_edit_reuses_the_pressure_pass_and_replaces_the_color_program() {
        use producer_production_contract::{GraphPass, RenderGraph};
        let g: RenderGraph =
            serde_json::from_str(include_str!("../../examples/atmosphere/pressure-map.json"))
                .unwrap();
        let GraphPass::Fragment { shader: field, .. } = &g.passes[0] else { panic!("expected fragment") };
        let GraphPass::Fragment { shader: ink, .. } = &g.passes[1] else { panic!("expected fragment") };
        let first = compile(field, 0).unwrap();
        let original = compile(ink, 1).unwrap();
        let edited = compile(include_str!("../../examples/atmosphere/aurora.wgsl"), 1).unwrap();
        assert!(std::sync::Arc::ptr_eq(&first, &compile(field, 0).unwrap()));
        assert_ne!(original.source, edited.source);
        assert!(compile("return unknown_name;", 1).is_err());
        assert!(std::sync::Arc::ptr_eq(&original, &compile(ink, 1).unwrap()));
    }

    #[test]
    fn validates_each_declared_input_and_rejects_loops() {
        let sample = "return textureSample(input0,linear_sampler,uv);";
        assert!(compile(sample, 1).is_ok());
        assert!(compile(sample, 0).is_err());
        assert!(compile("loop {} return vec4<f32>(0.);", 0).is_err());
        assert!(compile("return frame.params;", 0).is_ok());
        assert!(compile("return vec4<f32>(frame.screenPan, 0., 1.);", 0).is_ok());
    }
}
