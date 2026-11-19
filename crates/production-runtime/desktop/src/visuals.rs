//! Immutable native visual preparation. Rasterization/upload happens on the
//! control worker; render/audio only reads typed records and retained textures.
use crate::{
    model::RoomProject,
    platform::{Draw, Frame, TextCache, TextSpec},
};
use anyhow::{bail, Result};
use producer_native_media::boundary::OutputSize;
use producer_production_contract::{Fit, Ink, Paint, Property, TextAlign};
use producer_production_core::compile::{CompactValue, Plan, Sample};
use sha2::{Digest, Sha256};
use std::{ffi::CString, sync::Arc};

pub const MAX_DRAWS: usize = 1024;
#[derive(Default)]
pub struct VisualCache {
    key: String,
    prepared: Option<Arc<Visuals>>,
}
impl VisualCache {
    pub fn prepare(&mut self, project: &RoomProject, plan: &Plan) -> Result<Arc<Visuals>> {
        // Editorial cuts and panel changes do not invalidate static text or
        // surface resources. Node indices are included because render records
        // index the plan, rather than looking up string paths every frame.
        let prefixes = [
            format!("sets/{}/layouts/landscape/", project.scene),
            format!("sets/{}/layouts/vertical/", project.scene),
        ];
        let selected: Vec<_> = plan
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| prefixes.iter().any(|p| n.path.starts_with(p)))
            .collect();
        let targets: Vec<_> = plan.sequences["main"]
            .tracks
            .iter()
            .map(|t| &plan.targets[t.target])
            .filter(|t| prefixes.iter().any(|p| t.path.starts_with(p)))
            .collect();
        let key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(selected, targets, &project.inputs))?)
        );
        if self.key == key {
            if let Some(v) = &self.prepared {
                return Ok(v.clone());
            }
        }
        let prepared = Arc::new(Visuals::prepare(project, plan)?);
        self.key = key;
        self.prepared = Some(prepared.clone());
        Ok(prepared)
    }
}
struct Element {
    node: usize,
    fill: Option<Draw>,
    content: Option<Draw>,
}
pub struct Visuals {
    outputs: [Vec<Element>; 2],
    pub text: TextCache,
}
fn ink(i: &Ink) -> [f32; 4] {
    let n = u32::from_str_radix(&i.color[1..], 16).expect("validated ink");
    [
        ((n >> 16) & 255) as f32 / 255.,
        ((n >> 8) & 255) as f32 / 255.,
        (n & 255) as f32 / 255.,
        i.opacity as f32,
    ]
}
impl Visuals {
    pub fn prepare(project: &RoomProject, plan: &Plan) -> Result<Self> {
        let mut outputs: [Vec<Element>; 2] = std::array::from_fn(|_| Vec::new());
        let mut strings = Vec::<CString>::new();
        let mut specs = Vec::<TextSpec>::new();
        let mut pixels = 0u64;
        for (out, (name, size)) in [
            ("landscape", project.canvas.landscape),
            ("vertical", project.canvas.vertical),
        ]
        .into_iter()
        .enumerate()
        {
            let prefix = format!("sets/{}/layouts/{name}/", project.scene);
            let mut count = 0;
            for (index, n) in plan
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, n)| n.path.starts_with(&prefix))
            {
                // Never silently discard a requested visual animation. Parent
                // transforms need a composed transform/clip stack in a later
                // renderer profile; the first 2D adapter admits leaf targets.
                let animated = plan.sequences["main"].tracks.iter().filter_map(|t| {
                    let target = &plan.targets[t.target];
                    (target.path == n.path).then_some(target.property)
                });
                let parent_prefix = n.path.clone() + "/";
                for property in n.bound.iter().map(|(p, _)| *p).chain(animated) {
                    if !matches!(
                        property,
                        Property::Opacity
                            | Property::TranslateX
                            | Property::TranslateY
                            | Property::Visibility
                    ) || plan
                        .nodes
                        .iter()
                        .any(|child| child.path.starts_with(&parent_prefix))
                    {
                        bail!("Native visual animation is not qualified for {}: {property:?}; working output retained", n.path);
                    }
                }
                let rect = [
                    n.frame.x as f32 / size.width as f32,
                    n.frame.y as f32 / size.height as f32,
                    n.frame.width as f32 / size.width as f32,
                    n.frame.height as f32 / size.height as f32,
                ];
                let mut base = Draw::solid(rect, [0.; 4]);
                base.metrics = [0., n.frame.width as f32, n.frame.height as f32, 0.];
                let mut fill = None;
                if let Some(style) = &n.style {
                    base.metrics[0] = style.radius as f32;
                    base.surface[1] = style.grain as f32;
                    if let Some(border) = &style.border {
                        base.border = ink(&border.ink);
                        base.metrics[3] = border.width as f32;
                    }
                    if let Some(paint) = &style.fill {
                        match paint {
                            Paint::Solid { ink: i } => {
                                base.color = ink(i);
                                base.color_to = base.color;
                            }
                            Paint::Linear { from, to, angle } => {
                                base.color = ink(from);
                                base.color_to = ink(to);
                                base.surface[0] = (*angle as f32).to_radians();
                            }
                            Paint::Veil {
                                from,
                                to,
                                glow,
                                cell,
                                motion,
                            } => {
                                base.color = ink(from);
                                base.color_to = ink(to);
                                base.accent = ink(glow);
                                base.material = [1., *cell as f32, *motion as f32, 0.];
                            }
                        }
                    }
                    if style.fill.is_some() || style.border.is_some() {
                        fill = Some(base);
                    }
                }
                let mut content = None;
                if let Some(text) = &n.text {
                    // The current adapter has one explicit portable system-font
                    // asset. Other fonts must gain a real loader, never silently substitute.
                    if n.font.as_deref() != Some(&"0".repeat(64)) {
                        bail!("Native text requires the qualified system-font asset");
                    }
                    let (w, h) = (n.frame.width.ceil() as u32, n.frame.height.ceil() as u32);
                    pixels += w as u64 * h as u64;
                    if specs.len() >= 128 || pixels > 8_388_608 || w > 4096 || h > 4096 {
                        bail!("Native text cache budget exceeded; working output retained");
                    }
                    strings.push(CString::new(text.as_str())?);
                    let style = n.style.as_ref().and_then(|s| s.text.as_ref());
                    specs.push(TextSpec {
                        value: strings.last().unwrap().as_ptr(),
                        width: w,
                        height: h,
                        font_size: style.map_or(48., |s| s.font_size as f32),
                        weight: style.map_or(600, |s| s.weight as u32),
                        align: style.map_or(0, |s| match s.align {
                            TextAlign::Left => 0,
                            TextAlign::Center => 1,
                            TextAlign::Right => 2,
                        }),
                    });
                    let mut d = Draw::solid(rect, style.map_or([1.; 4], |s| ink(&s.ink)));
                    d.metrics = [0., w as f32, h as f32, 0.];
                    d.kind = 2;
                    d.source = (specs.len() - 1) as u32;
                    content = Some(d);
                } else if let Some(source) = &n.source {
                    let slot = match source.as_str() {
                        "camera" => 0,
                        "screen" => 1,
                        "movie" => 2,
                        "take" => 3,
                        _ => project
                            .inputs
                            .get(source)
                            .filter(|b| b.kind == "camera")
                            .map(|b| b.slot)
                            .ok_or_else(|| {
                                anyhow::anyhow!("Native visual source is not qualified: {source}")
                            })?,
                    };
                    let mut d = base;
                    d.kind = 1;
                    d.source = slot;
                    d.surface[1] = 0.; // Grain belongs to authored surfaces, never raw video.
                    content = Some(d);
                }
                count += usize::from(fill.is_some()) + usize::from(content.is_some());
                if count > MAX_DRAWS {
                    bail!("Native visual draw budget exceeded; working output retained");
                }
                outputs[out].push(Element {
                    node: index,
                    fill,
                    content,
                });
            }
        }
        let text = TextCache::new(&specs)?;
        Ok(Self { outputs, text })
    }
    pub fn draws(
        &self,
        plan: &Plan,
        samples: &[Option<Sample>],
        output: usize,
        size: OutputSize,
        frames: &[Option<Arc<Frame>>; 8],
        active: [bool; 8],
        production_seconds: f64,
        out: &mut Vec<Draw>,
    ) {
        out.clear();
        for e in &self.outputs[output] {
            let node = &plan.nodes[e.node];
            let mut opacity = 1.;
            let mut tx = 0.;
            let mut ty = 0.;
            let mut visible = true;
            let mut property = |p, v| match (p, v) {
                (Property::Opacity, CompactValue::Number(v)) => opacity = v as f32,
                (Property::TranslateX, CompactValue::Number(v)) => {
                    tx = v as f32 / size.width as f32
                }
                (Property::TranslateY, CompactValue::Number(v)) => {
                    ty = v as f32 / size.height as f32
                }
                (Property::Visibility, CompactValue::Bool(v)) => visible = v,
                _ => {}
            };
            for (p, v) in &node.bound {
                property(*p, *v);
            }
            for sample in samples.iter().flatten() {
                let target = &plan.targets[sample.target];
                if target.path == node.path {
                    property(target.property, sample.value);
                }
            }
            if !visible || opacity <= 0. {
                continue;
            }
            for mut d in [e.fill, e.content].into_iter().flatten() {
                if d.kind == 1 {
                    let i = d.source as usize;
                    if !active[i] {
                        continue;
                    }
                    let Some(frame) = frames[i].as_ref() else {
                        continue;
                    };
                    fit_source(&mut d, node.fit, frame.width, frame.height, size);
                }
                d.rect[0] += tx;
                d.rect[1] += ty;
                d.opacity = opacity;
                if d.material[0] == 1. {
                    d.material[3] = production_seconds as f32;
                }
                out.push(d);
            }
        }
    }
}
fn fit_source(d: &mut Draw, fit: Option<Fit>, width: usize, height: usize, size: OutputSize) {
    let aspect = width as f32 / height.max(1) as f32;
    let dest = d.rect[2] * size.width as f32 / (d.rect[3] * size.height as f32);
    if fit == Some(Fit::Contain) {
        if aspect > dest {
            let h = d.rect[2] * size.width as f32 / aspect / size.height as f32;
            d.rect[1] += (d.rect[3] - h) / 2.;
            d.rect[3] = h;
        } else {
            let w = d.rect[3] * size.height as f32 * aspect / size.width as f32;
            d.rect[0] += (d.rect[2] - w) / 2.;
            d.rect[2] = w;
        }
        d.metrics[1] = d.rect[2] * size.width as f32;
        d.metrics[2] = d.rect[3] * size.height as f32;
    } else if fit == Some(Fit::Cover) {
        if aspect > dest {
            let f = dest / aspect;
            d.uv = [(1. - f) / 2., 0., f, 1.];
        } else {
            let f = aspect / dest;
            d.uv = [0., (1. - f) / 2., 1., f];
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contain_and_cover_preserve_media_aspect_and_pixel_metrics() {
        let mut d = Draw::solid([0., 0., 1., 1.], [1.; 4]);
        d.metrics = [24., 1920., 1080., 2.];
        fit_source(
            &mut d,
            Some(Fit::Contain),
            1080,
            1920,
            OutputSize {
                width: 1920,
                height: 1080,
            },
        );
        assert!((d.metrics[1] / d.metrics[2] - 1080. / 1920.).abs() < 0.0001);
        assert_eq!(d.metrics[0], 24.);
        assert_eq!(d.metrics[3], 2.);
        let mut d = Draw::solid([0., 0., 1., 1.], [1.; 4]);
        fit_source(
            &mut d,
            Some(Fit::Cover),
            1920,
            1080,
            OutputSize {
                width: 1080,
                height: 1920,
            },
        );
        assert!((d.uv[2] - 0.31640625).abs() < 0.0001);
    }
    #[test]
    fn native_draw_abi_is_sixteen_byte_sized() {
        assert_eq!(std::mem::size_of::<Draw>(), 160);
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;
    #[test]
    fn prepared_text_is_reused_for_editorial_and_dock_changes() {
        let mut p = crate::visual_fixture::project(false);
        let mut cache = VisualCache::default();
        let a = cache.prepare(&p, &p.compile().unwrap()).unwrap();
        p.workspace
            .apply(crate::workspace::WorkspaceCommand::Visibility {
                panel: crate::workspace::PanelId::Sources,
                visible: false,
            })
            .unwrap();
        p.production.sequences.get_mut("main").unwrap().placements[0]
            .range
            .start = producer_production_contract::Time::seconds(1);
        p.production.sequences.get_mut("main").unwrap().placements[0]
            .range
            .duration = producer_production_contract::Time::seconds(29);
        let b = cache.prepare(&p, &p.compile().unwrap()).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let mut out = Vec::with_capacity(MAX_DRAWS);
        b.draws(
            &p.compile().unwrap(),
            &[],
            0,
            p.canvas.landscape,
            &std::array::from_fn(|_| None),
            [false; 8],
            0.,
            &mut out,
        );
        assert_eq!(out.iter().filter(|d| d.kind == 2).count(), 6);
        assert!(out.iter().any(|d| d.kind == 0 && d.material[0] == 1.));
        let before = out.capacity();
        b.draws(
            &p.compile().unwrap(),
            &[],
            1,
            p.canvas.vertical,
            &std::array::from_fn(|_| None),
            [false; 8],
            0.,
            &mut out,
        );
        assert_eq!(out.capacity(), before);
    }
    #[test]
    fn unknown_font_is_refused_and_previous_resources_survive() {
        let mut p = crate::visual_fixture::project(false);
        let mut cache = VisualCache::default();
        let before = cache.prepare(&p, &p.compile().unwrap()).unwrap();
        let node = &mut p
            .production
            .sets
            .get_mut("studio")
            .unwrap()
            .layouts
            .get_mut("landscape")
            .unwrap()
            .root
            .children[1]
            .children[0];
        if let producer_production_contract::Content::Text { font, .. } = &mut node.content {
            *font = "f".repeat(64);
        }
        assert!(cache.prepare(&p, &p.compile().unwrap()).is_err());
        assert!(Arc::ptr_eq(&before, cache.prepared.as_ref().unwrap()));
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    #[test]
    fn cached_scene_does_not_hide_new_unsupported_animation() {
        use producer_production_contract::*;
        let mut p = crate::visual_fixture::project(false);
        let mut cache = VisualCache::default();
        let before = cache.prepare(&p, &p.compile().unwrap()).unwrap();
        p.production
            .sequences
            .get_mut("main")
            .unwrap()
            .tracks
            .push(Track {
                id: "unsupported-parent".into(),
                target: Target {
                    path: "sets/studio/layouts/landscape/root/glass".into(),
                    property: Property::Opacity,
                },
                range: Range {
                    start: Time::ZERO,
                    duration: Time::seconds(1),
                },
                keys: vec![
                    Key {
                        at: Time::ZERO,
                        value: Value::Number(0.),
                    },
                    Key {
                        at: Time::seconds(1),
                        value: Value::Number(1.),
                    },
                ],
                interpolation: Interpolation::Linear,
            });
        assert!(cache.prepare(&p, &p.compile().unwrap()).is_err());
        assert!(Arc::ptr_eq(&before, cache.prepared.as_ref().unwrap()));
    }
}
