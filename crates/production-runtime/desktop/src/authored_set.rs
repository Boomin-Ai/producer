//! Assistant-side authoring format. Only the lowered production Set is played.
use crate::{engine::RoomCommand, model::RoomProject};
use anyhow::{ensure, Context, Result};
use producer_production_contract::{
    Content, GraphClock, GraphInput, GraphPass, GraphProfile, Layout, Node, Orientation, Rect,
    RenderGraph, Role, Set, Source, SurfaceStyle,
};
use producer_production_core::commands::{Command, Operation};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

pub const GUIDE: &str = r#"To create a new standalone multi-layout set in one review, return room_command {op:"authorSet",id:"set-name",looks:[...],materials:{...}}. Each look {id:"duo",layers:[...],material:"light"} becomes a named landscape and vertical pair. Supply exactly the requested number of distinct looks. Each layer {id,landscape:[x,y,width,height],vertical:[x,y,width,height],content,style?} uses fractions of its output (positive size, fully inside canvas). Layer order is back to front. content is native Node Content, e.g. {"kind":"source","source":"camera","fit":"cover"}, {"kind":"source","source":"rtc-guest","fit":"cover"}, {"kind":"group"}, or {"kind":"text","value":"LIVE","font":"0000000000000000000000000000000000000000000000000000000000000000"}. style is native SurfaceStyle. Give each visual role a stable layer ID. materials maps names to WGSL fragment function bodies. A look's optional material samples its ordered layers via textureSampleLevel(input0,linear_sampler,uv,0.). Return vec4<f32>. frame.info.xy = output pixels; frame.info.z = shared live seconds. No loops or extra functions. Materials can be shared between looks. Use purposeful motion, art-direct the two orientations independently, and preserve visible sources when shading. For other graph topologies use document transactions and the native schema."#;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Design {
    op: String,
    id: String,
    looks: Vec<Look>,
    #[serde(default)]
    materials: BTreeMap<String, String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Look {
    id: String,
    layers: Vec<Layer>,
    material: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Layer {
    id: String,
    landscape: [f64; 4],
    vertical: [f64; 4],
    content: Content,
    style: Option<SurfaceStyle>,
}
fn rect(v: [f64; 4], w: u32, h: u32) -> Result<Rect> {
    let [x, y, width, height] = v;
    ensure!(
        x >= 0.
            && y >= 0.
            && width > 0.
            && height > 0.
            && x + width <= 1.0000001
            && y + height <= 1.0000001,
        "rectangle must fit within normalized canvas"
    );
    Ok(Rect {
        x: x * f64::from(w),
        y: y * f64::from(h),
        width: width * f64::from(w),
        height: height * f64::from(h),
    })
}
pub fn command(project: &RoomProject, payload: serde_json::Value) -> Result<RoomCommand> {
    let design: Design = serde_json::from_value(payload).context("Invalid authorSet design")?;
    ensure!(
        design.op == "authorSet" && !project.production.sets.contains_key(&design.id),
        "Choose a new set ID"
    );
    ensure!(
        (1..=16).contains(&design.looks.len()),
        "Author 1 to 16 layout pairs"
    );
    let mut set: Set =
        serde_json::from_value(serde_json::json!({"layouts":{},"canvasFit":"contain"}))?;
    let mut guest = false;
    let mut materials_used = BTreeSet::new();
    for look in &design.looks {
        ensure!(
            !look.layers.is_empty() && look.layers.len() <= 63,
            "{} needs 1 to 63 layers",
            look.id
        );
        let layer_ids: Vec<_> = look.layers.iter().map(|l| l.id.clone()).collect();
        if let Some(name) = &look.material {
            let shader = design
                .materials
                .get(name)
                .with_context(|| format!("{} references missing material {name}", look.id))?;
            materials_used.insert(name);
            let graph = RenderGraph {
                profile: GraphProfile::V1,
                clock: GraphClock::Live,
                passes: vec![GraphPass::Fragment {
                    id: "surface".into(),
                    shader: shader.clone(),
                    params: [0.; 4],
                    fields: Default::default(),
                    inputs: vec![GraphInput::Layers { nodes: layer_ids }],
                }],
            };
            set.graphs.insert(look.id.clone(), graph);
        }
        for (suffix, orientation, size) in [
            (
                "landscape",
                Orientation::Landscape,
                project.canvas.landscape,
            ),
            ("vertical", Orientation::Vertical, project.canvas.vertical),
        ] {
            let id = format!("{}-{suffix}", look.id);
            ensure!(!set.layouts.contains_key(&id), "Duplicate layout {id}");
            let mut root: Node = serde_json::from_value(
                serde_json::json!({"id":"stage","content":{"kind":"group"}}),
            )?;
            for layer in &look.layers {
                let coords = if suffix == "landscape" {
                    layer.landscape
                } else {
                    layer.vertical
                };
                let bounds = rect(coords, size.width, size.height)
                    .with_context(|| format!("{id}/{}", layer.id))?;
                guest |=
                    matches!(&layer.content, Content::Source{source,..} if source=="rtc-guest");
                root.children.push(Node {
                    id: layer.id.clone(),
                    content: layer.content.clone(),
                    style: layer.style.clone(),
                    frame: Some(bounds),
                    placement: None,
                    flow: Default::default(),
                    children: vec![],
                    bindings: vec![],
                });
            }
            if look.material.is_some() {
                set.output_graphs.insert(id.clone(), look.id.clone());
            }
            set.layouts.insert(
                id,
                Layout {
                    orientation,
                    width: size.width,
                    height: size.height,
                    root,
                },
            );
        }
    }
    ensure!(
        materials_used.len() == design.materials.len(),
        "Remove unassigned materials"
    );
    let mut operations = Vec::new();
    if guest {
        match project.production.sources.get("rtc-guest") {
            None => operations.push(Operation::AddSource {
                id: "rtc-guest".into(),
                value: Source::Live { role: Role::Guest },
            }),
            Some(Source::Live { role: Role::Guest }) => (),
            Some(_) => anyhow::bail!("rtc-guest is already assigned to another role"),
        }
    }
    operations.push(Operation::AddSet {
        id: design.id,
        value: set,
    });
    Ok(RoomCommand::Document {
        command: Command::Transaction { operations },
    })
}
