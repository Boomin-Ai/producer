//! Lower editable material parameters into the existing render profiles.
//! Positions are normalized during authoring. Distances are measured in output pixels in the shader.
use super::{Layer, Look};
use anyhow::{ensure, Context, Result};
use producer_production_contract::{
    geometry::GeometryScene,
    validate::{color, valid_id},
    Content, GraphClock, GraphInput, GraphPass, GraphProfile, Orientation, RenderGraph,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub(super) enum Material {
    Wgsl(String),
    Native(Primitive),
}

// Dispatch explicitly so a typo in a native material gets its actual field diagnostic.
impl<'de> Deserialize<'de> for Material {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        match Value::deserialize(d)? {
            Value::String(s) => Ok(Self::Wgsl(s)),
            object => serde_json::from_value(object)
                .map(Self::Native)
                .map_err(serde::de::Error::custom),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Primitive {
    EmissivePath {
        from: Endpoint,
        to: Endpoint,
        color: String,
        highlight: String,
        width_px: f32,
        motion: Motion,
    },
    Perimeter {
        layer: String,
        color: String,
        highlight: String,
        width_px: f32,
        motion: Motion,
    },
    Refraction {
        layer: String,
        displacement_px: f32,
        wavelength_px: f32,
        motion: Motion,
    },
    /// The existing geometry profile supplies the native depth buffer, material lighting,
    /// unlit video textures and independent portrait camera. Look layers overlay its output.
    DimensionalDisplay {
        sources: Vec<String>,
        scene: GeometryScene,
        #[serde(default)]
        clock: GraphClock,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Endpoint {
    layer: String,
    anchor: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Attachment {
    landscape: [f64; 2],
    vertical: [f64; 2],
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Motion {
    period_seconds: f32,
    #[serde(default)]
    phase_turns: f32,
    #[serde(default)]
    clock: GraphClock,
}

pub(super) fn validate_attachments(layer: &Layer) -> Result<()> {
    ensure!(
        layer.attachments.len() <= 32,
        "{} has more than 32 attachments",
        layer.id
    );
    for (name, attachment) in &layer.attachments {
        ensure!(
            valid_id(name),
            "{} has invalid attachment name {name}",
            layer.id
        );
        ensure!(
            attachment
                .landscape
                .iter()
                .chain(&attachment.vertical)
                .all(|v| (0.0..=1.0).contains(v)),
            "{}.{} attachment coordinates must lie inside the layer",
            layer.id,
            name
        );
    }
    Ok(())
}

fn frame(layer: &Layer, orientation: Orientation) -> [f64; 4] {
    match orientation {
        Orientation::Landscape => layer.landscape,
        Orientation::Vertical => layer.vertical,
    }
}

impl Endpoint {
    fn resolve(&self, look: &Look, orientation: Orientation) -> Result<(usize, [f64; 2])> {
        let i = index(look, &self.layer)?;
        let l = &look.layers[i];
        let a = l
            .attachments
            .get(&self.anchor)
            .with_context(|| format!("unknown attachment {}.{}", self.layer, self.anchor))?;
        let [u, v] = match orientation {
            Orientation::Landscape => a.landscape,
            Orientation::Vertical => a.vertical,
        };
        let [x, y, w, h] = frame(l, orientation);
        Ok((i, [x + w * u, y + h * v]))
    }
}

fn index(look: &Look, id: &str) -> Result<usize> {
    look.layers
        .iter()
        .position(|l| l.id == id)
        .with_context(|| format!("unknown layer {id}"))
}

fn layers(layers: &[Layer]) -> GraphInput {
    GraphInput::Layers {
        nodes: layers.iter().map(|l| l.id.clone()).collect(),
    }
}

fn rgb(hex: &str) -> Result<String> {
    ensure!(color(hex), "expected a #RRGGBB color, got {hex}");
    let channel = |start| u8::from_str_radix(&hex[start..start + 2], 16).unwrap() as f32 / 255.;
    Ok(format!(
        "vec3<f32>({:?}, {:?}, {:?})",
        channel(1),
        channel(3),
        channel(5)
    ))
}

fn vec2([x, y]: [f64; 2]) -> String {
    format!("vec2<f32>({:?}, {:?})", x as f32, y as f32)
}

fn fragment(id: &str, shader: String, inputs: Vec<GraphInput>, params: [f32; 4]) -> GraphPass {
    GraphPass::Fragment {
        id: id.into(),
        shader,
        inputs,
        params,
        fields: Default::default(),
    }
}

fn check(value: f32, min: f32, max: f32, label: &str) -> Result<()> {
    ensure!(
        (min..=max).contains(&value),
        "{label} must be in [{min}, {max}]"
    );
    Ok(())
}

impl Motion {
    fn uniforms(&self, width: f32, secondary: f32) -> Result<[f32; 4]> {
        check(self.period_seconds, 0.1, 600., "periodSeconds")?;
        check(self.phase_turns, 0., 1., "phaseTurns")?;
        ensure!(
            matches!(self.clock, GraphClock::Live | GraphClock::Timeline),
            "fragment motion.clock must be live or timeline"
        );
        Ok([self.period_seconds, self.phase_turns, width, secondary])
    }
}

impl Material {
    pub(super) fn validate_source_roles(&self, project: &crate::model::RoomProject) -> Result<()> {
        if let Self::Native(Primitive::DimensionalDisplay { sources, .. }) = self {
            for id in sources {
                // A new guest source is created in the same authoring transaction.
                ensure!(
                    id == "rtc-guest" || crate::set_slots::visual_source(project, id),
                    "dimensionalDisplay requires a video source, got {id}"
                );
            }
        }
        Ok(())
    }
    pub(super) fn needs_guest(&self) -> bool {
        matches!(self, Self::Native(Primitive::DimensionalDisplay { sources, .. }) if sources.iter().any(|id| id == "rtc-guest"))
    }

    pub(super) fn graph(
        &self,
        look: &Look,
        orientation: Orientation,
        canvas: [u32; 2],
    ) -> Result<RenderGraph> {
        if let Material::Wgsl(shader) = self {
            return Ok(RenderGraph {
                profile: GraphProfile::V1,
                clock: GraphClock::Live,
                passes: vec![fragment(
                    "surface",
                    shader.clone(),
                    vec![layers(&look.layers)],
                    [0.; 4],
                )],
            });
        }
        let Material::Native(primitive) = self else {
            unreachable!()
        };
        if let Primitive::DimensionalDisplay {
            sources,
            scene,
            clock,
        } = primitive
        {
            ensure!(
                (1..=2).contains(&sources.len()) && sources.iter().all(|id| valid_id(id)),
                "dimensionalDisplay needs one or two named video sources"
            );
            ensure!(
                scene.valid(sources.len()),
                "invalid dimensionalDisplay geometry or camera"
            );
            for i in 0..sources.len() {
                ensure!(
                    scene.objects.iter().any(|o| o.input == Some(i as u8)),
                    "dimensionalDisplay source {} is unused",
                    sources[i]
                );
            }
            let surface = GraphPass::Geometry {
                id: "display".into(),
                inputs: sources
                    .iter()
                    .map(|id| GraphInput::Source { id: id.clone() })
                    .collect(),
                scene: scene.clone(),
            };
            let shader = format!(
                "let surface = textureSampleLevel(input0, linear_sampler, uv, 0.0);\n{}",
                compose(true)
            );
            return Ok(RenderGraph {
                profile: GraphProfile::Geometry,
                clock: *clock,
                passes: vec![
                    surface,
                    fragment(
                        "out",
                        shader,
                        vec![
                            GraphInput::Pass {
                                id: "display".into(),
                            },
                            layers(&look.layers),
                        ],
                        [0.; 4],
                    ),
                ],
            });
        }
        let (split, motion, params, body) = match primitive {
            Primitive::EmissivePath {
                from,
                to,
                color,
                highlight,
                width_px,
                motion,
            } => {
                check(*width_px, 0.25, 64., "widthPx")?;
                let (a, start) = from.resolve(look, orientation)?;
                let (b, end) = to.resolve(look, orientation)?;
                ensure!(
                    (start[0] - end[0]).hypot(start[1] - end[1]) > 1.0e-6,
                    "emissivePath endpoints coincide"
                );
                let body = format!("let startPt = canvasOrigin + {} * canvasExtent;\nlet endPt = canvasOrigin + {} * canvasExtent;\nlet ink = {};\nlet glint = {};\n{}",
                    vec2(start),vec2(end),rgb(color)?,rgb(highlight)?,include_str!("emissive_path.wgsl"));
                (a.max(b) + 1, motion, motion.uniforms(*width_px, 0.)?, body)
            }
            Primitive::Perimeter {
                layer,
                color,
                highlight,
                width_px,
                motion,
            } => {
                check(*width_px, 0.25, 64., "widthPx")?;
                let i = index(look, layer)?;
                let body = format!(
                    "{}\nlet ink = {};\nlet glint = {};\n{}",
                    extent(&look.layers[i], orientation),
                    rgb(color)?,
                    rgb(highlight)?,
                    include_str!("perimeter.wgsl")
                );
                (i + 1, motion, motion.uniforms(*width_px, 0.)?, body)
            }
            Primitive::Refraction {
                layer,
                displacement_px,
                wavelength_px,
                motion,
            } => {
                check(*displacement_px, 0., 64., "displacementPx")?;
                check(*wavelength_px, 4., 2048., "wavelengthPx")?;
                let i = index(look, layer)?;
                ensure!(
                    matches!(look.layers[i].content, Content::Source { .. }),
                    "refraction layer {layer} must contain a video source"
                );
                let body = format!(
                    "{}\n{}",
                    extent(&look.layers[i], orientation),
                    include_str!("refraction.wgsl")
                );
                (
                    i + 1,
                    motion,
                    motion.uniforms(*displacement_px, *wavelength_px)?,
                    body,
                )
            }
            Primitive::DimensionalDisplay { .. } => unreachable!(),
        };
        let mut inputs = vec![layers(&look.layers[..split])];
        let has_front = split < look.layers.len();
        if has_front {
            inputs.push(layers(&look.layers[split..]));
        }
        let authored_size = vec2([canvas[0] as f64, canvas[1] as f64]);
        // Mirror CanvasSettings::transform for a contained layout on a resized output.
        let shader = format!("let authoredSize = {authored_size};\nlet canvasExtent = authoredSize * min(frame.info.x / authoredSize.x, frame.info.y / authoredSize.y);\nlet canvasOrigin = (frame.info.xy - canvasExtent) * 0.5;\nlet base = textureSampleLevel(input0, linear_sampler, uv, 0.0);\nlet phase = fract(frame.info.z / frame.params.x + frame.params.y);\n{body}\n{}",compose(has_front));
        Ok(RenderGraph {
            profile: GraphProfile::V1,
            clock: motion.clock,
            passes: vec![fragment("surface", shader, inputs, params)],
        })
    }
}

fn extent(layer: &Layer, orientation: Orientation) -> String {
    let [x, y, w, h] = frame(layer, orientation);
    format!("let origin = canvasOrigin + {} * canvasExtent;\nlet extent = {} * canvasExtent;\nlet local = position.xy - origin;",
        vec2([x,y]),vec2([w,h]))
}

// Layer textures are premultiplied. Keep alpha in that convention until returning
// straight RGBA at the terminal fragment. Upper authored layers always stay clean.
fn compose(front: bool) -> &'static str {
    if front {
        "let front = textureSampleLevel(input1, linear_sampler, uv, 0.0);\nlet result = front + surface * (1.0 - front.a);\nreturn vec4<f32>(result.rgb / max(result.a, 1.0e-6), result.a);"
    } else {
        "return vec4<f32>(surface.rgb / max(surface.a, 1.0e-6), surface.a);"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pair() -> Look {
        serde_json::from_value(json!({"id":"duo","layers":[
            {"id":"host","content":{"kind":"source","source":"camera","fit":"cover"},
             "landscape":[0.1,0.25,0.3,0.5],"vertical":[0.25,0.1,0.5,0.3],
             "attachments":{"handoff":{"landscape":[1.0,0.5],"vertical":[0.5,1.0]}}},
            {"id":"guest","content":{"kind":"source","source":"rtc-guest","fit":"cover"},
             "landscape":[0.6,0.25,0.3,0.5],"vertical":[0.25,0.6,0.5,0.3],
             "attachments":{"handoff":{"landscape":[0.0,0.5],"vertical":[0.5,0.0]}}},
            {"id":"caption","content":{"kind":"group"},"landscape":[0.1,0.1,0.1,0.1],"vertical":[0.1,0.1,0.1,0.1]}
        ]})).unwrap()
    }

    fn path() -> Value {
        json!({"kind":"emissivePath","from":{"layer":"host","anchor":"handoff"},
            "to":{"layer":"guest","anchor":"handoff"},"color":"#2F50CB","highlight":"#FFFAE1",
            "widthPx":3,"motion":{"periodSeconds":4}})
    }

    fn graph(value: Value, look: &Look, orientation: Orientation) -> Result<RenderGraph> {
        let m: Material = serde_json::from_value(value)?;
        let size = if orientation == Orientation::Landscape {
            [1280, 720]
        } else {
            [720, 1280]
        };
        m.graph(look, orientation, size)
    }

    #[test]
    fn connector_tracks_named_anchors_and_reuses_the_pipeline_on_speed_edits() {
        let mut look = pair();
        let mut material = path();
        let horizontal = graph(material.clone(), &look, Orientation::Landscape).unwrap();
        let vertical = graph(material.clone(), &look, Orientation::Vertical).unwrap();
        look.layers[1].vertical[1] = 0.67;
        assert_eq!(
            horizontal,
            graph(material.clone(), &look, Orientation::Landscape).unwrap()
        );
        assert_ne!(
            vertical,
            graph(material.clone(), &look, Orientation::Vertical).unwrap()
        );
        let GraphPass::Fragment { inputs, shader, .. } = &horizontal.passes[0] else {
            panic!()
        };
        assert_eq!(
            inputs[1],
            GraphInput::Layers {
                nodes: vec!["caption".into()]
            }
        );
        let before = crate::render_graph::compile(shader, 2).unwrap();
        material["motion"]["periodSeconds"] = json!(8);
        let slower = graph(material, &look, Orientation::Landscape).unwrap();
        let GraphPass::Fragment { shader, params, .. } = &slower.passes[0] else {
            panic!()
        };
        assert_eq!(params[0], 8.);
        assert!(std::sync::Arc::ptr_eq(
            &before,
            &crate::render_graph::compile(shader, 2).unwrap()
        ));
    }

    #[test]
    fn invalid_material_parameters_and_unresolved_anchors_fail_before_render() {
        let look = pair();
        let mut material = path();
        material["from"]["anchor"] = json!("missing");
        assert!(graph(material, &look, Orientation::Landscape)
            .unwrap_err()
            .to_string()
            .contains("host.missing"));
        let mut material = path();
        material["motion"]["periodSeconds"] = json!(0);
        assert!(graph(material, &look, Orientation::Landscape)
            .unwrap_err()
            .to_string()
            .contains("periodSeconds"));
        let mut material = path();
        material["unknown"] = json!(true);
        assert!(serde_json::from_value::<Material>(material).is_err());
        let mut look = look;
        look.layers[1]
            .attachments
            .get_mut("handoff")
            .unwrap()
            .landscape = [1.1, 0.5];
        assert!(validate_attachments(&look.layers[1]).is_err());
    }

    #[test]
    fn native_fragments_compile_for_both_orientations_and_preserve_layer_order() {
        let look = pair();
        for m in [
            path(),
            json!({"kind":"refraction","layer":"host","displacementPx":14,"wavelengthPx":96,"motion":{"periodSeconds":3}}),
            json!({"kind":"perimeter","layer":"guest","color":"#882244","highlight":"#FACF90","widthPx":8,"motion":{"periodSeconds":2,"clock":"timeline"}}),
        ] {
            for o in [Orientation::Landscape, Orientation::Vertical] {
                let g = graph(m.clone(), &look, o).unwrap();
                let GraphPass::Fragment { shader, inputs, .. } = &g.passes[0] else {
                    panic!()
                };
                crate::render_graph::compile(shader, inputs.len()).unwrap();
                assert!(
                    matches!(&inputs[1], GraphInput::Layers{nodes} if nodes.last().unwrap()=="caption")
                );
            }
        }
    }
}
