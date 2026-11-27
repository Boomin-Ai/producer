//! Assistant-side authoring format. Only the lowered production Set is played.
mod materials;
pub(crate) mod package;
mod revision;
use crate::model::RoomProject;
use anyhow::{ensure, Context, Result};
use producer_production_contract::{
    Asset, AssetKind, Content, Layout, Node, Orientation, Ratio, Rect, Role, Set, Source, SurfaceStyle,
};
use producer_production_core::commands::{Command, Operation};
pub(crate) use revision::{prepare, Prepared, SavedDesign, EDIT_GUIDE};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

pub const GUIDE: &str = r##"For a new standalone set, submit_set takes an authorSet candidate {op:"authorSet",id:"set-name",looks:[...],materials:{...}}. Name the set with id; use title text in its layouts. The command has no title property. Each look {id:"duo",layers:[...],material:"light"} becomes a named landscape and vertical pair. Supply exactly the requested number of distinct looks. For a new visual design, inspect mode:"overview" in preview_set to judge the full sequence and both orientations together. Inspect one crop or a second moment to resolve a visible problem. Give each look a distinct purpose and carry an identifiable event through the cut. Each layer {id,landscape:[x,y,width,height],vertical:[x,y,width,height],content,style?} uses fractions of its output (positive size, fully inside canvas). For a square slot add aspect:{width:1,height:1}. Native fits that pixel ratio centered inside each frame and attaches materials to the resulting edges. Layer order is back to front. content is native Node Content, e.g. {"kind":"source","source":"camera","fit":"cover"}, {"kind":"source","source":"rtc-guest","fit":"cover"}, {"kind":"group"}, or {"kind":"text","value":"LIVE"}. Text defaults to the room system font; supply font for an explicit asset digest. Define repeated SurfaceStyles once in the set-level styles dictionary, e.g. styles:{headline:{text:{...}}}, then give each matching layer styleRef:"headline". Use a local style for a one-off. Common forms are {fill:{kind:"solid",ink:{color:"#RRGGBB",opacity:1}}} and {text:{fontSize:36,weight:600,align:"left",ink:{color:"#RRGGBB",opacity:1}}}. Use the authorSet guide directly. The document commands schema describes the lower-level playback contract. Stable IDs begin with a lowercase ASCII letter, then lowercase ASCII letters, digits or hyphens, at most 64 characters. constructor and prototype are reserved. Keep look IDs to 54 characters so the generated -landscape suffix fits. Use guest-accent, never guestAccent. Give each visual role a stable layer ID. materials maps names to native material objects or raw WGSL fragment bodies. Native forms: {kind:"emissivePath",from:{layer,anchor},to:{layer,anchor},widthPx,color,highlight,motion}; {kind:"perimeter",layer,widthPx,color,highlight,motion}; {kind:"refraction",layer,displacementPx,wavelengthPx,motion}; {kind:"dimensionalDisplay",sources:["camera"],scene:<GeometryScene>,clock?} draws the lit video geometry behind the look layers, use transparent overlays. Colors are #RRGGBB, widthPx 0.25..64, displacementPx 0..64, wavelengthPx 4..2048; motion:{periodSeconds:0.1..600,phaseTurns?:0..1,clock?:"live"|"timeline"}. Paths connect anchors declared on each layer, e.g. attachments:{exit:{landscape:[1,0.5],vertical:[0.5,1]}} in local normalized coordinates. For a moving frame flare prefer the typed perimeter material. Reuse its period, phase and clock across looks for a synchronized cycle. Optional set fields layoutTransitionMs (1..5000) and reversibleLooks (animated look ID mapped to resting look ID) carry partial progress through interrupted changes. For dimensionalDisplay with clock:"layout", geometry camera keys at seconds 0 and 1 define the two endpoints. Refraction samples actual video in the named source layer; layers above the material remain clear. Choose materials to suit the brief. A look's optional material samples its ordered layers via textureSampleLevel(input0,linear_sampler,uv,0.). Return vec4<f32>. frame.info.xy = output pixels; frame.info.z = shared live seconds. No loops or extra functions. Custom WGSL is limited to 8,192 bytes and 512 compiled expressions. Reuse the typed effects when they fit. Avoid WGSL reserved identifiers such as loop. Materials can be shared between looks. Use purposeful motion, art-direct the two orientations independently, and preserve visible sources when shading. For other graph topologies use document transactions and the native schema."##;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Design {
    op: String,
    id: String,
    looks: Vec<Look>,
    #[serde(default)]
    styles: BTreeMap<String, SurfaceStyle>,
    #[serde(default)]
    materials: BTreeMap<String, materials::Material>,
    #[serde(default, rename = "layoutTransitionMs")]
    layout_transition_ms: Option<u16>,
    #[serde(default, rename = "reversibleLooks")]
    reversible_looks: BTreeMap<String, String>,
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
    #[serde(rename = "styleRef")]
    style_ref: Option<String>,
    aspect: Option<Ratio>,
    #[serde(default)]
    attachments: BTreeMap<String, materials::Attachment>,
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
fn lower(project: &RoomProject, mut payload: serde_json::Value, replace: bool) -> Result<Command> {
    // Keep explicit playback font identities while saving the original authoring shorthand.
    let mut system_fonts = BTreeMap::<String, String>::new();
    for look in payload.get_mut("looks").and_then(|v| v.as_array_mut()).into_iter().flatten() {
        for layer in look.get_mut("layers").and_then(|v| v.as_array_mut()).into_iter().flatten() {
            let Some(content) = layer.get_mut("content").and_then(|v| v.as_object_mut()) else { continue };
            if content.get("kind").and_then(|v| v.as_str()) != Some("text") {
                continue;
            }
            if !content.contains_key("font") {
                let font = match project.production.assets.get("system-font") {
                    Some(asset) => {
                        ensure!(asset.kind == AssetKind::Font && crate::visuals::is_system_font(&asset.hash),
                            "The system-font asset conflicts with the native system font");
                        asset.hash.as_str()
                    }
                    None => crate::visuals::DEFAULT_SYSTEM_FONT,
                };
                content.insert("font".into(), serde_json::Value::String(font.into()));
            }
            let Some(font) = content.get("font").and_then(|v| v.as_str()).filter(|font| crate::visuals::is_system_font(font)) else { continue };
            if project.production.assets.values().any(|a| a.kind == AssetKind::Font && a.hash == font) {
                continue;
            }
            let id = if font == crate::visuals::DEFAULT_SYSTEM_FONT && !project.production.assets.contains_key("system-font") {
                "system-font".to_owned()
            } else {
                format!("native-font-{}", &font[..12])
            };
            ensure!(!project.production.assets.contains_key(&id), "Asset '{id}' conflicts with the native font descriptor");
            system_fonts.insert(id, font.to_owned());
        }
    }
    let mut design: Design = serde_json::from_value(payload).context("Invalid authorSet design")?;
    ensure!(
        design.op == "authorSet" && project.production.sets.contains_key(&design.id) == replace,
        "Set ID does not match the design operation"
    );
    ensure!(
        (1..=16).contains(&design.looks.len()),
        "Author 1 to 16 layout pairs"
    );
    let mut set: Set =
        serde_json::from_value(serde_json::json!({"layouts":{},"canvasFit":"contain"}))?;
    set.layout_transition_ms = design.layout_transition_ms;
    for (animated, resting) in &design.reversible_looks {
        for view in ["landscape", "vertical"] {
            set.reversible_layout_transitions
                .insert(format!("{animated}-{view}"), format!("{resting}-{view}"));
        }
    }
    let mut guest = false;
    let mut materials_used = BTreeSet::new();
    let mut styles_used = BTreeSet::new();
    for name in design.styles.keys() {
        ensure!(producer_production_contract::validate::valid_id(name), "Invalid shared style ID '{name}'");
    }
    for look in &mut design.looks {
        ensure!(
            !look.layers.is_empty() && look.layers.len() <= 63,
            "{} needs 1 to 63 layers",
            look.id
        );
        for layer in &mut look.layers {
            if let Some(name) = &layer.style_ref {
                ensure!(layer.style.is_none(), "{}/{} specifies both style and styleRef", look.id, layer.id);
                let style = design.styles.get(name)
                    .with_context(|| format!("{}/{} references missing style '{name}'", look.id, layer.id))?;
                layer.style = Some(style.clone());
                styles_used.insert(name.clone());
            }
            materials::validate_attachments(layer)?;
            if let Some(aspect) = layer.aspect {
                ensure!(producer_production_contract::layout::ratio_valid(aspect), "{}/{} aspect dimensions must be in 1..=65536", look.id, layer.id);
                for (name, bounds, size) in [
                    ("landscape", &mut layer.landscape, project.canvas.landscape),
                    ("vertical", &mut layer.vertical, project.canvas.vertical),
                ] {
                    let allocation = rect(*bounds, size.width, size.height)
                        .with_context(|| format!("{}-{name}/{}", look.id, layer.id))?;
                    let (w, h) = producer_production_core::layout::contained_dimensions(allocation.width, allocation.height, aspect);
                    let cw = f64::from(size.width);
                    let ch = f64::from(size.height);
                    *bounds = [(allocation.x + (allocation.width - w) * 0.5) / cw,
                               (allocation.y + (allocation.height - h) * 0.5) / ch, w / cw, h / ch];
                }
            }
        }
        let material = look
            .material
            .as_ref()
            .map(|name| {
                materials_used.insert(name);
                design
                    .materials
                    .get(name)
                    .with_context(|| format!("{} references missing material {name}", look.id))
            })
            .transpose()?;
        if let Some(material) = material {
            material.validate_source_roles(project)?;
        }
        let mut shared_graph: Option<String> = None;
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
            root.frame = Some(rect([0., 0., 1., 1.], size.width, size.height)?);
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
            if let Some(material) = material {
                guest |= material.needs_guest();
                let graph = material
                    .graph(look, orientation, [size.width, size.height])
                    .with_context(|| {
                        format!("{id}/material/{}", look.material.as_deref().unwrap())
                    })?;
                let graph_id = match &shared_graph {
                    Some(key) if set.graphs.get(key) == Some(&graph) => key.clone(),
                    _ => {
                        set.graphs.insert(id.clone(), graph);
                        shared_graph = Some(id.clone());
                        id.clone()
                    }
                };
                set.output_graphs.insert(id.clone(), graph_id);
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
    for name in design.styles.keys() {
        ensure!(styles_used.contains(name), "Shared style '{name}' needs a layer reference");
    }
    let mut operations = Vec::new();
    for (id, hash) in system_fonts {
        operations.push(Operation::AddAsset {
            id,
            value: Asset { hash, kind: AssetKind::Font, available: None },
        });
    }
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
    let set = set.with_output_graphs();
    operations.push(if replace {
        Operation::ReplaceSet {
            id: design.id,
            value: set,
        }
    } else {
        Operation::AddSet {
            id: design.id,
            value: set,
        }
    });
    Ok(Command::Transaction { operations })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn omitted_text_font_bootstraps_a_fresh_room_without_overwriting_a_collision() {
        let design = json!({"op":"authorSet","id":"opening","looks":[{"id":"title","layers":[{
            "id":"name","landscape":[0,0,1,1],"vertical":[0,0,1,1],"content":{"kind":"text","value":"On air"}}]}]});
        let mut room = RoomProject::demo();
        let mut empty = room.clone();
        *empty.production = producer_production_contract::Document::empty("empty", "Empty");
        let command = lower(&empty, design.clone(), false).unwrap();
        let applied = producer_production_core::commands::apply(&empty.production, &command).unwrap();
        assert_eq!(applied.assets.len(), 1);
        assert_eq!(applied.assets["system-font"].hash, crate::visuals::DEFAULT_SYSTEM_FONT);

        room.production.assets.remove("system-font");
        let mut clash = room.clone();
        let image = Asset { hash: "f".repeat(64), kind: AssetKind::Image, available: None };
        clash.production.assets.insert("system-font".into(), image.clone());
        assert!(prepare(&clash, design.clone()).is_err());
        assert_eq!(&clash.production.assets["system-font"], &image);
        prepare(&room, design).unwrap().install(&mut room).unwrap();
        let asset = &room.production.assets["system-font"];
        assert_eq!(asset.kind, AssetKind::Font);
        for view in room.production.sets["opening"].layouts.values() {
            assert!(matches!(&view.root.children[0].content, Content::Text { font, .. } if font == &asset.hash));
        }
    }

    #[test]
    fn square_slots_fit_both_canvases_and_retain_the_authored_envelope() {
        let mut room = RoomProject::demo();
        let design = json!({"op":"authorSet","id":"square-test","looks":[{"id":"host",
            "layers":[{"id":"picture","aspect":{"width":1,"height":1},"landscape":[0,0,1,1],
            "vertical":[0,0,1,1],"content":{"kind":"source","source":"camera","fit":"cover"}}]}]});
        let mut bad = design.clone();
        bad["looks"][0]["layers"][0]["aspect"]["height"] = json!(0);
        assert!(prepare(&room, bad).is_err());
        prepare(&room, design).unwrap().install(&mut room).unwrap();
        for layout in room.production.sets["square-test"].layouts.values() {
            let frame = layout.root.children[0].frame.as_ref().unwrap();
            assert!((frame.width-frame.height).abs()<1e-6);
            assert!((2.*frame.x+frame.width-f64::from(layout.width)).abs()<1e-6);
            assert!((2.*frame.y+frame.height-f64::from(layout.height)).abs()<1e-6);
        }
        assert_eq!(room.authored_designs["square-test"].inspect("authoredLook","host")["layers"][0]["vertical"], json!([0,0,1,1]));
    }

    #[test]
    fn three_looks_are_six_authored_views_with_independent_sources() {
        let mut room = RoomProject::demo();
        let layer = |id: &str, source: &str| json!({"id":id,"content":{"kind":"source","source":source,"fit":"cover"},"landscape":[0,0,0.5,1],"vertical":[0,0,1,0.5]});
        let host = layer("host", "camera");
        let design = json!({"op":"authorSet","id":"signal-room","materials":{"rim":"return textureSampleLevel(input0, linear_sampler, uv, 0.);"},"looks":[
            {"id":"opening","layers":[{"id":"back","landscape":[0,0,1,1],"vertical":[0,0,1,1],"content":{"kind":"group"}}]},
            {"id":"solo","material":"rim","layers":[host.clone()]},
            {"id":"duo","material":"rim","layers":[host,layer("guest","rtc-guest")]}
        ]});
        let mut invalid = design.clone();
        invalid["looks"][1]["layers"][0]["vertical"] = json!([0, 0, 0, 1]);
        assert!(prepare(&room, invalid)
            .err()
            .unwrap()
            .to_string()
            .contains("solo-vertical/host"));
        prepare(&room, design.clone())
            .unwrap()
            .install(&mut room)
            .unwrap();
        assert!(prepare(&room, design).is_err());
        assert_eq!(room.production.sets["signal-room"].layouts.len(), 6);
        let pairs = room.set_layout_choices("signal-room");
        assert_eq!(pairs.len(), 3);
        for choice in pairs {
            room.mount_set(Some("signal-room".into()), Some(choice.pair.clone()))
                .unwrap();
            let live = room.live_set().unwrap();
            assert_eq!(live.output_layout_pair(), choice.pair);
            live.compile().unwrap();
        }
    }
}
