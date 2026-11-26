//! Immutable native visual preparation. Rasterization/upload happens on the
//! control worker; render/audio only reads typed records and retained textures.
use crate::{
    model::{CanvasTransform, RoomProject},
    platform::{Draw, Frame, TextCache, TextSpec},
    speaker_split::{Region, CENTER},
};
use anyhow::{bail, Result};
use producer_native_media::boundary::OutputSize;
use producer_production_contract::{GraphInput, GraphPass, Fit, Ink, Paint, Property, TextAlign};
use producer_production_core::compile::{CompactValue, Plan, Sample};
use sha2::{Digest, Sha256};
use std::{ffi::CString, sync::Arc};

pub const MAX_DRAWS: usize = 1024;
// Budget for intermediate color, layer and depth surfaces per output. An
// eight-pass 1080p graph also needs space for its layer textures.
const MAX_GRAPH_SURFACE_PIXELS: u64 = 32 * 1024 * 1024;
#[derive(Default)]
pub struct VisualCache {
    entries: std::collections::VecDeque<(String, Arc<Visuals>)>,
}
impl VisualCache {
    pub fn merge_warmed(&mut self, cache: Self) {
        for entry in cache.entries {
            if !self.entries.iter().any(|(key, _)| key == &entry.0) {
                // Keep the active layout at the head of the cache.
                self.entries.insert(self.entries.len().min(1), entry);
                self.entries.truncate(3);
            }
        }
    }

    pub fn prepare(&mut self, project: &RoomProject, plan: &Plan) -> Result<Arc<Visuals>> {
        // Editorial cuts and panel changes do not invalidate static text or
        // surface resources. Node indices are included because render records
        // index the plan, rather than looking up string paths every frame.
        let prefixes=project.output_layouts().map(|(id,_)| format!("sets/{}/layouts/{id}/",project.scene));
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
            
            .collect();
        let graph_fields = project
            .production
            .sets
            .get(&project.scene)
            .is_some_and(|set| {
                set.graphs.values().any(|g| {
                    g.passes.iter().any(|p| {
                        let GraphPass::Fragment { fields, .. } = p else { return false };
                        fields.iter().any(Option::is_some)
                    })
                })
            });
        let fields = if graph_fields
            || selected.iter().any(|(_, node)| {
                node.style
                    .as_ref()
                    .and_then(|s| s.text.as_ref())
                    .is_some_and(|t| t.field.as_deref().is_some_and(|f| f != "dj-track"))
            }) {
            crate::weather::fields(&crate::root())?
        } else {
            Default::default()
        };
        let weather_desk = project.production.sets.get(&project.scene)
            .is_some_and(|set| set.theme.contains_key("weather-desk"));
        // Device names and primary bindings do not affect GPU resources.
        // In a set with authored guest layouts, solo layouts intentionally omit the guest.
        let prefix = format!("sets/{}/layouts/", project.scene);
        let places_guest = plan.nodes.iter().any(|node|
            node.source.as_deref() == Some("rtc-guest") && node.path.starts_with(&prefix))
            || project.production.sets.get(&project.scene).is_some_and(|set|
                set.graphs.values().flat_map(|graph| &graph.passes).any(|pass|
                    pass.inputs().iter().any(|input| matches!(input, GraphInput::Source { id } if id == "rtc-guest"))));
        let camera_slots: Vec<_> = project.inputs.iter()
            .filter(|(id, binding)| id.as_str() != "camera" && binding.kind == "camera")
            .map(|(id, binding)| (id, binding.slot))
            .collect();
        let key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(&project.scene, project.output_layouts(), project.production.sets.get(&project.scene).map(|s| (&s.graphs,&s.output_graphs,s.canvas_fit)), weather_desk, places_guest, selected, targets, camera_slots, project.rtc_video_slot(), &project.production.assets, &fields))?)
        );
        if let Some(index) = self.entries.iter().position(|(cached, _)| cached == &key) {
            let entry = self.entries.remove(index).unwrap();
            let prepared = entry.1.clone();
            self.entries.push_front(entry);
            return Ok(prepared);
        }
        let prepared = Arc::new(Visuals::prepare(project, plan, &fields, places_guest)?);
        self.entries.push_front((key, prepared.clone()));
        self.entries.truncate(3);
        Ok(prepared)
    }
}
struct Element {
    key: String,
    wave_border: bool,
    speaker_region: Option<Region>,
    depth: usize,
    tracks: Vec<(usize, Property)>,
    node: usize,
    fill: Option<Draw>,
    content: Option<Draw>,
}
pub struct Visuals {
    outputs: [Vec<Element>; 2],
    viewport: [CanvasTransform; 2],
    terminal: [Option<Draw>; 2],
    guest_slots: [bool; 2],
    pub places_guest: bool,
    speaker_split: bool,
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
fn image_slot(
    project: &RoomProject,
    asset: &str,
    slots: &mut std::collections::HashMap<String, (u32, u32, u32)>,
    images: &mut Vec<image::RgbaImage>,
    specs: &mut Vec<TextSpec>,
    pixels: &mut u64,
) -> Result<(u32, u32, u32)> {
    let digest = &project.production.assets[asset].hash;
    if let Some(&entry) = slots.get(digest) {
        return Ok(entry);
    }
    let path = crate::root().join("assets").join(format!("{digest}.png"));
    let file = std::fs::File::open(path)?;
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= 16 * 1024 * 1024 && format!("{:x}", Sha256::digest(&bytes)) == *digest,
        "Image asset digest or size mismatch"
    );
    let reader =
        image::ImageReader::with_format(std::io::Cursor::new(&bytes), image::ImageFormat::Png);
    let (w, h) = reader.into_dimensions()?;
    *pixels += u64::from(w) * u64::from(h);
    anyhow::ensure!(
        w <= 4096 && h <= 4096 && *pixels <= 8_388_608 && specs.len() < 128,
        "Image exceeds visual texture budget"
    );
    let rgba = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)?.into_rgba8();
    let entry = (specs.len() as u32, w, h);
    specs.push(TextSpec {
        rgba: rgba.as_ptr(),
        value: std::ptr::null(),
        width: w,
        height: h,
        font_size: 0.,
        weight: 0,
        align: 0,
        single_line: 0,
    });
    images.push(rgba);
    slots.insert(digest.clone(), entry);
    Ok(entry)
}

/// An authored camera can exist before a device is connected. Leave its surface
/// empty until that input owns a slot, including when the guest is already live.
fn live_slot(project: &RoomProject, source: &str) -> Result<Option<u32>> {
    use producer_production_contract::{Role, Source};
    Ok(match source {
        "camera" => Some(0),
        "screen" => Some(1),
        "movie" => Some(2),
        "take" => Some(3),
        "rtc-guest" => project.rtc_video_slot().map(|slot| slot as u32),
        _ if matches!(project.production.sources.get(source), Some(Source::Live { role: Role::HostCamera })) =>
            project.inputs.get(source).map(|binding| binding.slot),
        _ => bail!("Unavailable visual source: {source}"),
    })
}
impl Visuals {
    pub fn has_guest_slot(&self, output: usize) -> bool { self.guest_slots[output] }
    pub fn has_speaker_split(&self) -> bool { self.speaker_split }
    fn prepare(project: &RoomProject, plan: &Plan, fields: &crate::weather::Fields, places_guest: bool) -> Result<Self> {
        let weather_desk = project.production.sets.get(&project.scene)
            .is_some_and(|set| set.theme.contains_key("weather-desk"));
        let mut programs = std::collections::HashMap::new();
        let mut graph_specs = Vec::<crate::platform::GraphSpec>::new();
        let mut terminal = [None; 2];
        let mut viewport = [CanvasTransform::IDENTITY; 2];
        let mut guest_slots = [false; 2];
        let mut speaker_split = false;
        let mut outputs: [Vec<Element>; 2] = std::array::from_fn(|_| Vec::new());
        let mut strings = Vec::<CString>::new();
        let mut specs = Vec::<TextSpec>::new();
        let mut pixels = 0u64;
        let mut images = Vec::<image::RgbaImage>::new();
        let mut image_slots = std::collections::HashMap::new();
        for (out, (name, size)) in project.output_layouts()
        .into_iter()
        .enumerate()
        {
            let prefix = format!("sets/{}/layouts/{name}/", project.scene);
            let mut count = 0;
            let set=project.production.sets.get(&project.scene).ok_or_else(||anyhow::anyhow!("Set unavailable for output"))?;
            viewport[out] = project.canvas.transform(set, &set.layouts[name]);
            let groups: std::collections::BTreeMap<_,_>=set.layouts.get(name).into_iter().flat_map(|layout|layout.root.children.iter()).enumerate().map(|(i,n)|(n.id.as_str(),i as u32+1)).collect();
            let mut jobs=Vec::new();
            let mut graph_pixels=0u64;
            for (index, n) in plan
                .nodes
                .iter()
                .enumerate()
                .filter(|(_, n)| n.path.starts_with(&prefix))
            {
                let tracks: Vec<_> = plan.sequences["main"].tracks.iter().enumerate().filter_map(|(slot, track)| {
                    let target = &plan.targets[track.target];
                    (target.path == n.path).then_some((slot, target.property))
                }).collect();
                let depth = n.path[prefix.len()..].bytes().filter(|&b| b == b'/').count();
                if depth > producer_production_contract::SPATIAL_DEPTH { bail!("Visual hierarchy too deep"); }
                let parent_prefix = format!("{}/", n.path);
                for property in n.bound.iter().map(|(p, _)| p).chain(tracks.iter().map(|(_, p)| p)) {
                    match property {
                        Property::TranslateX | Property::TranslateY | Property::Rotation | Property::Scale | Property::Visibility => {},
                        Property::Opacity if !plan.nodes.iter().any(|child| child.path.starts_with(&parent_prefix)) => {},
                        _ => bail!("Unsupported native animation at {}: {property:?}", n.path),
                    }
                }
                // The headline occupies a fixed region in the output graph's
                // text atlas. Preserve that UV region at every target size.
                let (width, height) = if depth == 1 && n.path.ends_with("/headline")
                    && set.canvas_fit == producer_production_contract::CanvasFit::Reflow
                    && crate::headline::supports(set, name)
                {
                    (set.layouts[name].width, set.layouts[name].height)
                } else {
                    (size.width, size.height)
                };
                let frame = viewport[out].rect(n.frame);
                let rect = [
                    frame.x as f32 / width as f32,
                    frame.y as f32 / height as f32,
                    frame.width as f32 / width as f32,
                    frame.height as f32 / height as f32,
                ];
                let mut base = Draw::solid(rect, [0.; 4]);
                base.group=n.path[prefix.len()..].split('/').nth(1).and_then(|n|groups.get(n)).copied().unwrap_or(0);
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
                            Paint::Graph {graph} => {
                                jobs.push((Some(outputs[out].len()),graph.as_str(),n.frame.width.ceil() as u32,n.frame.height.ceil() as u32));
                                base.kind=4;
                            }
                            Paint::Contours { ink: color, width, period } => {
                                base.color = ink(color);
                                base.material = [3., *width as f32, *period as f32, 0.];
                            }
                            // Previously authored Atmosphere rooms reference this exact generated foil.
                            Paint::Image { asset, .. } if weather_desk && asset == "contour-foil"
                                && project.production.assets[asset].hash == "9e8e67a0d7bc82fef4d42b38411cb4e11b3061be05235bc7ddfa924f1e78f31d" => {
                                base.color = [215./255., 184./255., 128./255., 0.51];
                                base.material = [3., 1.6, 14., 0.];
                            }
                            Paint::Image { asset, fit } => {
                                let (slot,w,h)=image_slot(project,asset,&mut image_slots,&mut images,&mut specs,&mut pixels)?;
                                base.kind = 3;
                                base.source = slot;
                                fit_source(&mut base,Some(*fit),w as usize,h as usize,size);
                            }
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
                    let style = n.style.as_ref().and_then(|s| s.text.as_ref());
                    let name = style.and_then(|s| s.field.as_ref());
                    let mut d = Draw::solid(rect, style.map_or([1.; 4], |s| ink(&s.ink)));
                    d.metrics = [0., w as f32, h as f32, 0.];
                    d.group = base.group;
                    d.kind = 2;
                    if name.is_some_and(|key| key == "dj-track") {
                        d.source = u32::MAX;
                    } else {
                        pixels += w as u64 * h as u64;
                        if specs.len() >= 128 || pixels > 8_388_608 || w > 4096 || h > 4096 {
                            bail!("Native text cache budget exceeded; working output retained");
                        }
                        let value = name.and_then(|k| fields.get(k)).unwrap_or(text);
                        strings.push(CString::new(value.as_str())?);
                        d.source = specs.len() as u32;
                        specs.push(TextSpec {
                            rgba: std::ptr::null(),
                            value: strings.last().unwrap().as_ptr(),
                            width: w,
                            height: h,
                            font_size: style.map_or(48., |s| s.font_size as f32),
                            weight: style.map_or(600, |s| s.weight as u32),
                            single_line: u32::from(name.is_some()),
                            align: style.map_or(0, |s| match s.align {
                                TextAlign::Left => 0,
                                TextAlign::Center => 1,
                                TextAlign::Right => 2,
                            }),
                        });
                    }
                    content = Some(d);
                } else if let Some(source) = &n.source {
                    guest_slots[out] |= source == "rtc-guest";
                    if let Some(slot) = live_slot(project, source)? {
                        let mut d = base;
                        d.kind = 1;
                        d.source = slot;
                        d.surface[1] = 0.; // Grain belongs to authored surfaces, never raw video.
                        content = Some(d);
                    }
                }
                let wave_border = weather_desk && is_presenter_edge(&n.path);
                let key = &n.path[prefix.len()..];
                let speaker_region = Region::from_path(key);
                speaker_split |= speaker_region.is_some();
                count += usize::from(fill.is_some()) + usize::from(content.is_some());
                if count > MAX_DRAWS {
                    bail!("Native visual draw budget exceeded; working output retained");
                }
                outputs[out].push(Element {
                    key: key.to_owned(), wave_border, speaker_region, node: index, depth, tracks,
                    fill,
                    content,
                });
            }
            if let Some(graph) = set.output_graphs.get(name) {
                anyhow::ensure!(count < MAX_DRAWS, "no room for output graph");
                jobs.push((None, graph.as_str(), size.width, size.height));
            }
            for (element, graph, width, height) in jobs {
                let definition = &set.graphs[graph];
                let first = graph_specs.len();
                anyhow::ensure!(
                    width > 0 && height > 0 && width <= 4096 && height <= 4096,
                    "invalid graph surface size at {}",
                    graph
                );
                graph_pixels +=
                    u64::from(width) * u64::from(height) * definition.passes.len() as u64;
                anyhow::ensure!(
                    graph_pixels <= MAX_GRAPH_SURFACE_PIXELS && first + definition.passes.len() <= 64,
                    "graph target budget exceeded at {}",
                    graph
                );
                let mut layers = std::collections::BTreeMap::<u64, i32>::new();
                let mut produced = std::collections::HashMap::new();
                for pass in &definition.passes {
                    let inputs=pass.inputs();
                    let (id, geometry, source, entry, params) = match pass {
                        GraphPass::Geometry { id,scene,.. } => {
                            graph_pixels += u64::from(width) * u64::from(height);
                            anyhow::ensure!(graph_pixels <= MAX_GRAPH_SURFACE_PIXELS,"geometry depth target exceeds graph budget");
                            strings.push(CString::new(crate::glb::prepare(scene)?)?);
                            (id,strings.last().unwrap().as_ptr(),c_geometry_shader(),std::ptr::null(),[0.;4])
                        }
                        GraphPass::Fragment {id,shader,params,fields:bindings,..} => {
                            let params=std::array::from_fn(|i| bindings[i].as_ref()
                                .and_then(|key|fields.get(key)).and_then(|v|v.parse::<f32>().ok())
                                .filter(|v|v.is_finite()).unwrap_or(params[i]));
                            let key=(shader.as_str(),inputs.len());
                            if !programs.contains_key(&key) {
                                programs.insert(key,crate::render_graph::compile(shader,inputs.len())
                                    .map_err(|e|anyhow::anyhow!("{graph}/{id}: {e}"))?);
                            }
                            let program=&programs[&key];
                            (id,std::ptr::null(),program.source.as_ptr(),program.entry.as_ptr(),params)
                        }
                    };
                    let mut reads = [-1; 2];
                    for (index, input) in inputs.iter().enumerate() {
                        reads[index] = match input {
                            GraphInput::Layers { nodes } => {
                                anyhow::ensure!(
                                    element.is_none(),
                                    "layer input requires a layout output graph"
                                );
                                let mask =
                                    nodes.iter().try_fold(0u64, |mask, id| -> Result<u64> {
                                        let slot = *groups
                                            .get(id.as_str())
                                            .ok_or_else(|| anyhow::anyhow!("unknown layer {id}"))?;
                                        Ok(mask
                                            | 1u64.checked_shl(slot).ok_or_else(|| {
                                                anyhow::anyhow!("layer mask exceeds 63 branches")
                                            })?)
                                    })?;
                                if let Some(index) = layers.get(&mask) {
                                    136 + *index
                                } else {
                                    graph_pixels += u64::from(width) * u64::from(height);
                                    anyhow::ensure!(
                                        graph_pixels <= MAX_GRAPH_SURFACE_PIXELS && graph_specs.len() < 64,
                                        "output graph exceeds texture budget"
                                    );
                                    let index = graph_specs.len() as i32;
                                    graph_specs.push(crate::platform::GraphSpec {
                                        geometry: std::ptr::null(),
                                        source: std::ptr::null(),
                                        entry: std::ptr::null(),
                                        width,
                                        height,
                                        inputs: [-1; 2],
                                        params: [0.; 4],
                                        groups: mask,
                                    });
                                    layers.insert(mask, index);
                                    136 + index
                                }
                            }
                            GraphInput::Source { id } => {
                                guest_slots[out] |= id == "rtc-guest";
                                live_slot(project, id)?.map_or(-1, |slot| slot as i32)
                            }
                            GraphInput::Image { asset } => {
                                8 + image_slot(
                                    project,
                                    asset,
                                    &mut image_slots,
                                    &mut images,
                                    &mut specs,
                                    &mut pixels,
                                )?
                                .0 as i32
                            }
                            GraphInput::Pass { id } => 136 + produced[id],
                        };
                    }
                    anyhow::ensure!(graph_specs.len() < 64, "too many native graph targets");
                    produced.insert(id.clone(), graph_specs.len() as i32);
                    graph_specs.push(crate::platform::GraphSpec {
                        geometry, source, entry,
                        width,
                        height,
                        inputs: reads,
                        params,
                        groups: 0,
                    });
                }
                let mut marker = Draw::solid([0., 0., 1., 1.], [0.; 4]);
                let base = if let Some(index) = element {
                    outputs[out][index].fill.as_mut().expect("graph fill")
                } else {
                    &mut marker
                };
                base.kind = if element.is_some() { 4 } else { 5 };
                use producer_production_contract::GraphClock;
                base.accent[0] = match definition.clock {
                    GraphClock::Live => 0.,
                    GraphClock::Timeline => 1.,
                    GraphClock::Layout => 2.,
                };
                base.source = (graph_specs.len() - 1) as u32;
                base.reserved = first as u32;
                if element.is_none() {
                    marker.opacity = f32::from(crate::headline::visible(set));
                    terminal[out] = Some(marker);
                }
            }
        }
        let text = TextCache::with_graphs(&specs, &graph_specs)?;
        Ok(Self {
            outputs,
            viewport,
            guest_slots,
            places_guest,
            speaker_split,
            terminal,
            text,
        })
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
        camera_wave: bool,
        out: &mut Vec<Draw>,
    ) {
        self.draw_transition(plan,samples,output,size,frames,active,production_seconds,production_seconds,production_seconds,camera_wave,out,None,None,CENTER)
    }
    pub fn draw_transition(
        &self,
        plan: &Plan,
        samples: &[Option<Sample>],
        output: usize,
        size: OutputSize,
        frames: &[Option<Arc<Frame>>; 8],
        active: [bool; 8],
        production_seconds: f64,
        timeline_seconds: f64,
        set_motion_seconds: f64,
        camera_wave: bool,
        out: &mut Vec<Draw>,
        transition: Option<(&LayoutBlend,f32)>,
        graph_progress: Option<f32>,
        speaker_share: f32,
    ) {
        out.clear();
        let progress = graph_progress.unwrap_or_else(|| transition.map_or(1., |(_, p)| p));
        let (w,h) = (size.width as f32,size.height as f32);
        let mut poses = [Pose::IDENTITY; producer_production_contract::SPATIAL_DEPTH + 2];
        for (index,e) in self.outputs[output].iter().enumerate() {
            let node = &plan.nodes[e.node];
            let mut opacity = 1.;
            let mut tx = 0.;
            let mut ty = 0.;
            let mut visible = true;
            let mut scale = 1.;
            let mut angle = 0.;
            let mut property = |p, v| match (p, v) {
                (Property::Opacity, CompactValue::Number(v)) => opacity = v as f32,
                (Property::TranslateX, CompactValue::Number(v)) => {
                    tx = v as f32
                }
                (Property::TranslateY, CompactValue::Number(v)) => {
                    ty = v as f32
                }
                (Property::Scale, CompactValue::Number(v)) => scale = v as f32,
                (Property::Rotation, CompactValue::Number(v)) => angle = (v as f32).to_radians(),
                (Property::Visibility, CompactValue::Bool(v)) => visible = v,
                _ => {}
            };
            for (p, v) in &node.bound {
                property(*p, *v);
            }
            for &(slot, prop) in &e.tracks {
                if let Some(Some(sample)) = samples.get(slot) { property(prop,sample.value); }
            }
            let fit = self.viewport[output];
            let frame = fit.rect(node.frame);
            let pivot = [(frame.x + node.pivot.x * frame.width) as f32,
                         (frame.y + node.pivot.y * frame.height) as f32];
            let motion = fit.scale as f32;
            let pose = poses[e.depth].child(pivot,[tx * motion, ty * motion],scale,angle,visible);
            poses[e.depth + 1] = pose;
            if !pose.visible || opacity <= 0. {
                continue;
            }
            for mut d in [e.fill, e.content].into_iter().flatten() {
                if let Some(region) = e.speaker_region {
                    d.rect = region.rect(speaker_share, size, output == 1);
                    d.metrics[1] = d.rect[2] * w;
                    d.metrics[2] = d.rect[3] * h;
                }
                if let Some((blend,phase))=transition {
                    if let Some(prior)=blend.from[output].get(index).copied().flatten() {
                        for (v,start) in d.rect.iter_mut().zip(prior.rect) {*v=start+(*v-start)*phase;}
                        d.metrics[0]=prior.radius+(d.metrics[0]-prior.radius)*phase;
                        d.metrics[1]=d.rect[2]*w;d.metrics[2]=d.rect[3]*h;
                    }
                }
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
                let center = pose.point([(d.rect[0]+0.5*d.rect[2])*w,(d.rect[1]+0.5*d.rect[3])*h]);
                d.rect[2] *= pose.scale;
                d.rect[3] *= pose.scale;
                d.rect[0] = center[0]/w-0.5*d.rect[2];
                d.rect[1] = center[1]/h-0.5*d.rect[3];
                d.surface[2] = pose.angle;
                d.surface[3] = w/h;
                d.opacity = opacity;
                if d.material[0] == 1. {
                    d.material[3] = production_seconds as f32;
                } else if d.material[0] == 3. {
                    let period = f64::from(d.material[2]);
                    d.material[3] = (production_seconds.rem_euclid(period) / period
                        * std::f64::consts::TAU) as f32;
                }
                if d.kind == 4 { set_graph_clock(&mut d, active, production_seconds, timeline_seconds, transition.map_or(1.,|(_,p)|p)); }
                if camera_wave && e.wave_border {
                    d.material = [2., 0., 0., production_seconds.rem_euclid(4.) as f32];
                }
                out.push(d);
            }
        }
        if let Some(mut d)=self.terminal[output] {
            set_graph_clock(&mut d,active,production_seconds,set_motion_seconds,progress);
            out.push(d);
        }
    }
}
fn set_graph_clock(d: &mut Draw, active: [bool; 8], live: f64, timeline: f64, progress: f32) {
    d.accent[1] = active
        .iter()
        .enumerate()
        .fold(0u32, |m, (i, on)| m | (u32::from(*on) << i)) as f32;
    d.accent[2] = if d.accent[0] == 1. { timeline } else { live } as f32;
    d.accent[3] = progress;
}
// The inset video mask and the surrounding bezel share a center in every
// Atmosphere layout. Animate both edges with the same production-clock phase.
fn is_presenter_edge(path: &str) -> bool {
    path.ends_with("/presenter/bezel") || path.ends_with("/presenter/host-camera")
}

#[derive(Clone,Copy)]
struct Bounds { rect:[f32;4],radius:f32 }
pub struct LayoutBlend {from:[Vec<Option<Bounds>>;2], pub start:f64, duration:f64}
impl LayoutBlend {
    pub fn phase(&self,now:f64)->f32 {
        let t=((now-self.start)/self.duration).clamp(0.,1.) as f32;
        t*t*(3.-2.*t)
    }
    pub fn begin(old:&Visuals,next:&Visuals,prior:Option<&Self>,now:f64,ms:u16)->Self{
        let from=std::array::from_fn(|out|{
            let mut previous=std::collections::HashMap::new();
            for (index,element) in old.outputs[out].iter().enumerate(){
                if let Some(draw)=element.content.or(element.fill){
                    let mut b=Bounds{rect:draw.rect,radius:draw.metrics[0]};
                    if let Some((start,phase))=prior.and_then(|p|Some((p.from[out].get(index).copied().flatten()?,p.phase(now)))){
                        for (v,a) in b.rect.iter_mut().zip(start.rect){*v=a+(*v-a)*phase;}
                        b.radius=start.radius+(b.radius-start.radius)*phase;
                    }
                    previous.insert(&element.key,b);
                }
            }
            next.outputs[out].iter().map(|e|previous.get(&e.key).copied()).collect()
        });
        Self{from,start:now,duration:f64::from(ms.max(1))/1000.}
    }
}
#[derive(Clone, Copy)]
struct Pose { offset: [f32;2], scale: f32, angle: f32, visible: bool, cos: f32, sin: f32 }
impl Pose {
    const IDENTITY: Self = Self { offset:[0.;2],scale:1.,angle:0.,visible:true,cos:1.,sin:0. };
    fn point(self,[x,y]:[f32;2]) -> [f32;2] {
        [self.offset[0]+self.scale*(self.cos*x-self.sin*y),self.offset[1]+self.scale*(self.sin*x+self.cos*y)]
    }
    fn child(self,pivot:[f32;2],delta:[f32;2],scale:f32,angle:f32,visible:bool) -> Self {
        let angle=self.angle+angle;
        let (sin,cos)=angle.sin_cos();
        let mut child=Self {offset:[0.;2],scale:self.scale*scale,angle,visible:self.visible&&visible,cos,sin};
        let at=self.point([pivot[0]+delta[0],pivot[1]+delta[1]]);
        let moved=child.point(pivot);
        child.offset=[at[0]-moved[0],at[1]-moved[1]];
        child
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
    fn unbound_cohost_camera_stays_empty_and_binds_independently_of_host_and_guest() {
        use producer_production_contract::{Role, Source};
        let mut project = RoomProject::demo();
        project.production.sources.insert("camera-2".into(), Source::Live { role: Role::HostCamera });
        project.production.sources.insert("rtc-guest".into(), Source::Live { role: Role::Guest });
        assert_eq!(live_slot(&project, "camera-2").unwrap(), None);
        assert_eq!(live_slot(&project, "rtc-guest").unwrap(), Some(4));

        project.configure_input("camera", "camera", "front", "Host camera").unwrap();
        assert!(project.configure_input("camera-2", "camera", "front", "Already used").is_err());
        project.configure_input("camera-2", "camera", "side", "Co-host camera").unwrap();
        let reopened: RoomProject = serde_json::from_slice(&serde_json::to_vec(&project).unwrap()).unwrap();
        assert_eq!(live_slot(&reopened, "camera").unwrap(), Some(0));
        assert_eq!(live_slot(&reopened, "camera-2").unwrap(), Some(4));
        assert_eq!(live_slot(&reopened, "rtc-guest").unwrap(), Some(5));
        assert!(reopened.lanes.iter().any(|lane| lane.source == "camera-2"));
        assert!(reopened.production.sequences["main"].placements.iter().any(|p| p.source == "camera-2"));
        let mut full = reopened.clone();
        for number in 3..=5 {
            full.add_input("camera", &format!("device-{number}"), "Existing camera").unwrap();
        }
        assert_eq!(live_slot(&full, "rtc-guest").unwrap(), None);
        full.remove_source("camera-4").unwrap();
        assert_eq!(live_slot(&full, "rtc-guest").unwrap(), Some(6));
        assert_eq!(live_slot(&full, "camera-2").unwrap(), Some(4));
        project.remove_source("camera-2").unwrap();
        assert_eq!(live_slot(&project, "camera-2").unwrap(), None);
        assert_eq!(live_slot(&project, "rtc-guest").unwrap(), Some(4));
    }

    #[test]
    fn camera_wave_targets_the_bezel_and_its_video_mask() {
        for layout in ["landscape", "vertical", "presenter-landscape", "presenter-vertical"] {
            let root = format!("sets/atmosphere/layouts/{layout}/root");
            assert!(is_presenter_edge(&format!("{root}/presenter/bezel")));
            assert!(is_presenter_edge(&format!("{root}/presenter/host-camera")));
            assert!(!is_presenter_edge(&format!("{root}/presenter/placeholder")));
            assert!(!is_presenter_edge(&format!("{root}/forecast/bezel")));
        }
    }
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
        assert_eq!(std::mem::size_of::<Draw>(), 164);
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;
    #[test]
    fn speaker_split_deforms_the_authored_host_and_guest_slots_on_both_outputs() {
        let directory = tempfile::tempdir().unwrap();
        crate::starter_sets::install(directory.path()).unwrap();
        let mut project: RoomProject =
            serde_json::from_slice(&std::fs::read(directory.path().join("room.json")).unwrap()).unwrap();
        project.mount_set(Some(crate::speaker_split::ID.into()), None).unwrap();
        let project = project.live_set().unwrap();
        let plan = project.compile().unwrap();
        let visuals = VisualCache::default().prepare(&project, &plan).unwrap();
        assert!(visuals.has_speaker_split());
        let mut draws = Vec::new();
        for (output, (_, size)) in project.output_layouts().into_iter().enumerate() {
            assert!(visuals.has_guest_slot(output));
            visuals.draw_transition(
                &plan, &[], output, size, &std::array::from_fn(|_| None), [false; 8],
                0., 0., 0., false, &mut draws, None, None, 0.64,
            );
            assert_eq!(draws.len(), 3);
            for region in [Region::Host, Region::Guest, Region::Divider] {
                let expected = region.rect(0.64, size, output == 1);
                assert!(draws.iter().any(|draw| {
                    draw.metrics[3] == 0. &&
                        draw.rect.iter().zip(expected).all(|(&actual, expected)| (actual - expected).abs() < 1e-6)
                }));
            }
        }
    }

    #[test]
    fn changing_the_primary_camera_reuses_prepared_visuals() {
        let mut project = crate::visual_fixture::project(false);
        let mut cache = VisualCache::default();
        let original = cache.prepare(&project, &project.compile().unwrap()).unwrap();
        project.configure_input("camera", "camera", "facetime", "FaceTime").unwrap();
        let rebound = cache.prepare(&project, &project.compile().unwrap()).unwrap();
        assert!(Arc::ptr_eq(&original, &rebound));
        let removed_plan = project.remove_source("camera").unwrap();
        assert!(Arc::ptr_eq(&original, &cache.prepare(&project, &removed_plan).unwrap()));
    }
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
            false,
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
            false,
            &mut out,
        );
        assert_eq!(out.capacity(), before);
    }
    #[test]
    fn returning_to_a_layout_reuses_its_prepared_visuals() {
        let mut project = crate::visual_fixture::project(false);
        let set = project.production.sets.get_mut("studio").unwrap();
        for orientation in ["landscape", "vertical"] {
            set.layouts.insert(format!("alternate-{orientation}"), set.layouts[orientation].clone());
        }
        let plan = project.compile().unwrap();
        let mut cache = VisualCache::default();
        let original = cache.prepare(&project, &plan).unwrap();
        let selection = project.mounted_layout.clone();
        project.mount_set(Some("studio".into()), Some(crate::model::SetLayoutPair {
            landscape: "alternate-landscape".into(), vertical: "alternate-vertical".into(),
        })).unwrap();
        let alternate = cache.prepare(&project, &plan).unwrap();
        assert!(!Arc::ptr_eq(&original, &alternate));
        project.mounted_layout = selection;
        assert!(Arc::ptr_eq(&original, &cache.prepare(&project, &plan).unwrap()));
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
        assert!(Arc::ptr_eq(&before, &cache.entries.front().unwrap().1));
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
        assert!(Arc::ptr_eq(&before, &cache.entries.front().unwrap().1));
    }
}

#[cfg(test)]
mod group_motion_tests {
    use super::*;

    #[test]
    fn inherited_pose_rotates_about_pixel_pivot_and_preserves_child_offset() {
        let pose = Pose::IDENTITY.child([100., 200.], [30., -20.], 2., std::f32::consts::FRAC_PI_2, true);
        let child = pose.child([110., 200.], [5., 0.], 1., 0., true);
        let mapped = child.point([110., 200.]);
        assert!((mapped[0] - 130.).abs() < 0.001 && (mapped[1] - 210.).abs() < 0.001);
        assert!(!pose.child([0.;2],[0.;2],1.,0.,false).child([0.;2],[0.;2],1.,0.,true).visible);
    }
}

fn c_geometry_shader() -> *const std::ffi::c_char {
    concat!(include_str!("../native/geometry.metal"), "\0").as_ptr().cast()
}
