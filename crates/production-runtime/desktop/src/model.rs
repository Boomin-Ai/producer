use anyhow::{anyhow, bail, Context, Result};
use producer_native_media::boundary::OutputSize;
use producer_production_contract::*;
use producer_production_core::{commands, compile};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CanvasSettings {
    pub landscape: OutputSize,
    pub vertical: OutputSize,
    pub view: CanvasView,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CanvasView {
    Landscape,
    Vertical,
    Both,
}
/// Affine mapping from compiled layout pixels to the native output. Shared by
/// the compositor and the set editor's source hit regions.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CanvasTransform {
    pub scale: f64,
    x: f64,
    y: f64,
}
impl CanvasTransform {
    pub const IDENTITY: Self = Self { scale: 1., x: 0., y: 0. };

    pub fn rect(self, r: Rect) -> Rect {
        Rect { x: self.x + r.x * self.scale, y: self.y + r.y * self.scale,
            width: r.width * self.scale, height: r.height * self.scale }
    }
}

impl CanvasSettings {
    pub fn transform(&self, set: &Set, layout: &Layout) -> CanvasTransform {
        if set.canvas_fit == CanvasFit::Reflow {
            return CanvasTransform::IDENTITY;
        }
        let output = match layout.orientation {
            Orientation::Landscape => self.landscape,
            Orientation::Vertical => self.vertical,
        };
        let (w, h) = (f64::from(output.width), f64::from(output.height));
        let (lw, lh) = (f64::from(layout.width), f64::from(layout.height));
        let scale = (w / lw).min(h / lh);
        CanvasTransform { scale, x: (w - lw * scale) * 0.5, y: (h - lh * scale) * 0.5 }
    }
}
impl Default for CanvasSettings {
    fn default() -> Self {
        Self {
            landscape: OutputSize::LANDSCAPE,
            vertical: OutputSize::VERTICAL,
            view: CanvasView::Both,
        }
    }
}
pub use crate::workspace::Workspace;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Lane {
    pub id: String,
    pub label: String,
    pub source: String,
    pub kind: String,
    pub muted: bool,
    pub gain: f32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InputBinding {
    pub kind: String,
    pub device: String,
    pub slot: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SetLayoutPair {
    pub landscape: String,
    pub vertical: String,
}

impl Default for SetLayoutPair {
    fn default() -> Self {
        Self { landscape: "landscape".into(), vertical: "vertical".into() }
    }
}

impl SetLayoutPair {
    pub(crate) fn exists_in(&self, set: &Set) -> bool {
        set.layouts.get(&self.landscape).is_some_and(|layout| layout.orientation == Orientation::Landscape)
            && set.layouts.get(&self.vertical).is_some_and(|layout| layout.orientation == Orientation::Vertical)
    }

    pub fn has_flythrough(&self, set: &Set) -> bool {
        self.ids().iter().any(|id| {
            set.output_graphs.get(*id).and_then(|name| set.graphs.get(name)).is_some_and(|graph| {
                graph.clock == GraphClock::Timeline
                    && graph.passes.iter().any(|pass| matches!(pass, GraphPass::Geometry { .. }))
            })
        })
    }

    pub fn ids(&self) -> [&str; 2] {
        [&self.landscape, &self.vertical]
    }
}

#[derive(Debug, Clone)]
pub struct SetLayoutChoice {
    pub label: String,
    pub pair: SetLayoutPair,
}

pub fn set_label(id: &str) -> String {
    if id == "studio" {
        return "Native Studio".into();
    }
    id.split(['-', '_'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut letters = word.chars();
            match letters.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), letters.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RoomScene {
    pub name: String,
    pub composition: Set,
    pub mounted_set: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mounted_layout: Option<SetLayoutPair>,
}
/// Meter and transport snapshots share the set library until a project edit needs its own copy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProductionDocument(Arc<Document>);

impl std::ops::Deref for ProductionDocument {
    type Target = Document;
    fn deref(&self) -> &Document { &self.0 }
}

impl std::ops::DerefMut for ProductionDocument {
    fn deref_mut(&mut self) -> &mut Document { Arc::make_mut(&mut self.0) }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct HostDirection {
    pub microphones: [String; 2],
}
impl Default for HostDirection {
    fn default() -> Self {
        Self { microphones: ["microphone".into(), "microphone-2".into()] }
    }
}

/// Optical framing within an authored slot. Each shot stores its own crop for both outputs.
pub type MfmFraming = BTreeMap<String, [u16; 3]>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MfmSubject { Shaan, Sam, Screen }

impl MfmSubject {
    pub fn from_slot(id: &str) -> Option<Self> {
        match id { "shaan" => Some(Self::Shaan), "sam" => Some(Self::Sam),
            "screen-share" => Some(Self::Screen), _ => None }
    }
    pub fn label(self) -> &'static str {
        match self { Self::Shaan => "Shaan", Self::Sam => "Sam", Self::Screen => "Screen share" }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RoomProject {
    #[serde(default)]
    pub mfm_direction: HostDirection,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mfm_framing: MfmFraming,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub set_source_defaults: BTreeMap<String, BTreeMap<String, String>>,
    #[serde(default)]
    pub speaker_segments: BTreeMap<String, std::collections::BTreeSet<String>>,
    #[serde(default)]
    pub untimed_segments: BTreeMap<String, std::collections::BTreeSet<String>>,
    /// Program selection belongs to this running harness. Reopening a studio
    /// never restarts an editorial segment merely because its set is mounted.
    #[serde(skip)]
    pub playing_segment: Option<(String, String)>,
    #[serde(skip)]
    pub shot_override: Option<SetLayoutPair>,
    #[serde(skip)]
    pub rendering_show: bool,
    #[serde(default)]
    pub room_scenes: BTreeMap<String, RoomScene>,
    #[serde(default = "default_active_scene")]
    pub active_scene: String,
    #[serde(default = "default_mounted_set")]
    pub mounted_set: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mounted_layout: Option<SetLayoutPair>,
    pub version: u32,
    pub room: String,
    pub canvas: CanvasSettings,
    pub workspace: Workspace,
    pub production: ProductionDocument,
    pub lanes: Vec<Lane>,
    pub scene: String,
    #[serde(default)]
    pub inputs: BTreeMap<String, InputBinding>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub camera_grades: BTreeMap<String, CameraGrade>,
}
/// Source-local software grade. Integer controls keep wire values and reset exact.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct CameraGrade {
    pub exposure: i16, // hundredths of a stop
    pub contrast: i16, // percentage points relative to neutral
    pub saturation: i16,
    pub warmth: i16,
}
impl CameraGrade {
    pub fn valid(self) -> bool {
        (-200..=200).contains(&self.exposure) && [self.contrast, self.saturation, self.warmth]
            .iter().all(|v| (-100..=100).contains(v))
    }
    fn uniform(self) -> [f32; 4] {
        [self.exposure, self.contrast, self.saturation, self.warmth].map(|v| f32::from(v) / 100.)
    }
}
impl RoomProject {
    pub fn set_mfm_zoom(&mut self, pair: &SetLayoutPair, subject: MfmSubject, percent: u16) -> Result<bool> {
        let set = self.production.sets.get("my-first-million").context("My First Million is unavailable")?;
        anyhow::ensure!(pair.exists_in(set) && (100..=300).contains(&percent), "Invalid shot or zoom");
        fn has_subject(node: &Node, subject: MfmSubject) -> bool {
            (matches!(&node.content, Content::Source { .. }) && MfmSubject::from_slot(&node.id) == Some(subject))
                || node.children.iter().any(|child| has_subject(child, subject))
        }
        anyhow::ensure!(pair.ids().iter().any(|id| has_subject(&set.layouts[*id].root, subject)), "Source is absent from this shot");
        let mut changed = false;
        for id in pair.ids() {
            let mut values = self.mfm_framing.get(id).copied().unwrap_or([100; 3]);
            if values[subject as usize] == percent { continue; }
            values[subject as usize] = percent;
            if values == [100; 3] { self.mfm_framing.remove(id); }
            else { self.mfm_framing.insert(id.into(), values); }
            changed = true;
        }
        Ok(changed)
    }

    pub fn validate_grade(&self, source: &str, grade: CameraGrade) -> Result<()> {
        anyhow::ensure!(matches!(self.production.sources.get(source), Some(Source::Live { role: Role::HostCamera })), "Select a camera source");
        anyhow::ensure!(grade.valid(), "Camera grade outside its allowed range");
        Ok(())
    }
    pub fn grade_slots(&self) -> [[f32; 4]; 8] {
        let mut values = [[0.; 4]; 8];
        for (source, grade) in self.camera_grades.iter().filter(|(_, g)| g.valid()) {
            let slot = if source == "camera" { Some(0) } else {
                self.inputs.get(source).filter(|b| b.kind == "camera").map(|b| b.slot as usize)
            };
            if let Some(target) = slot.and_then(|slot| values.get_mut(slot)) {
                *target = grade.uniform();
            }
        }
        values
    }
}
fn default_active_scene() -> String {
    "studio".into()
}
fn default_mounted_set() -> Option<String> {
    Some("studio".into())
}
fn node(id: &str, content: Content) -> Node {
    Node {
        style: None,
        id: id.into(),
        frame: None,
        placement: None,
        flow: Flow::Overlay,
        content,
        children: vec![],
        bindings: vec![],
    }
}
fn weight(n: f64) -> Size {
    Size::Weight {
        weight: n,
        min: 1.,
        max: 65536.,
    }
}
fn layout(size: OutputSize, orientation: Orientation) -> Layout {
    let title = node(
        "title",
        Content::Text {
            value: "PRODUCER / NATIVE STUDIO".into(),
            font: "0".repeat(64),
        },
    );
    let mut body = node("body", Content::Group);
    body.flow = if size.aspect() > 1.2 {
        Flow::Row {
            gap: 24.,
            sizes: vec![weight(3.), weight(1.3)],
        }
    } else {
        Flow::Column {
            gap: 24.,
            sizes: vec![weight(2.3), weight(1.5)],
        }
    };
    let mut main = node("main", Content::Group);
    main.flow = Flow::Column {
        gap: 18.,
        sizes: vec![weight(1.), weight(1.)],
    };
    main.children = vec![
        node(
            "screen",
            Content::Source {
                source: "screen".into(),
                fit: Fit::Contain,
            },
        ),
        node(
            "mov",
            Content::Source {
                source: "movie".into(),
                fit: Fit::Contain,
            },
        ),
    ];
    let host = node(
        "camera",
        Content::Source {
            source: "camera".into(),
            fit: Fit::Cover,
        },
    );
    body.children = vec![main, host];
    let mut root = node("root", Content::Group);
    root.frame = Some(Rect {
        x: 0.,
        y: 0.,
        width: size.width as f64,
        height: size.height as f64,
    });
    root.flow = Flow::Column {
        gap: 18.,
        sizes: vec![Size::Fixed { pixels: 100. }, weight(1.)],
    };
    root.children = vec![title, body];
    Layout {
        orientation,
        width: size.width,
        height: size.height,
        root,
    }
}
impl RoomProject {
    pub fn demo() -> Self {
        let mut d = Document::empty("native-room-lab", "Native Studio");
        for (id, role) in [
            ("camera", Role::HostCamera),
            ("screen", Role::Screen),
            ("microphone", Role::Microphone),
        ] {
            d.sources.insert(id.into(), Source::Live { role });
        }
        d.assets.insert(
            "system-font".into(),
            Asset {
                hash: "0".repeat(64),
                kind: AssetKind::Font,
                available: None,
            },
        );
        d.assets.insert(
            "movie-asset".into(),
            Asset {
                hash: "1".repeat(64),
                kind: AssetKind::Video,
                available: Some(Range {
                    start: Time::ZERO,
                    duration: Time::seconds(12),
                }),
            },
        );
        d.sources.insert(
            "movie".into(),
            Source::Player {
                asset: "movie-asset".into(),
            },
        );
        let set = Set {
            participant_inputs: Default::default(),
            canvas_fit: Default::default(),
            graphs: Default::default(),
            output_graphs: Default::default(),
            layout_transition_ms: None,
            reversible_layout_transitions: BTreeMap::new(),
            layouts: BTreeMap::from([
                (
                    "landscape".into(),
                    layout(OutputSize::LANDSCAPE, Orientation::Landscape),
                ),
                (
                    "vertical".into(),
                    layout(OutputSize::VERTICAL, Orientation::Vertical),
                ),
            ]),
            theme: BTreeMap::from([("accent".into(), "#72DDBA".into())]),
            actions: BTreeMap::new(),
            controls: vec![],
        };
        d.sets.insert("studio".into(), set);
        let duration = Time::seconds(30);
        d.sequences.insert(
            "main".into(),
            Sequence {
                duration,
                instances: vec![],
                placements: vec![
                    Placement {
                        envelopes: Default::default(),
                        id: "screen-clip".into(),
                        source: "screen".into(),
                        range: Range {
                            start: Time::ZERO,
                            duration,
                        },
                        source_in: Time::ZERO,
                        speed: Speed::default(),
                        looping: false,
                    },
                    Placement {
                        envelopes: Default::default(),
                        id: "camera-clip".into(),
                        source: "camera".into(),
                        range: Range {
                            start: Time::ZERO,
                            duration,
                        },
                        source_in: Time::ZERO,
                        speed: Speed::default(),
                        looping: false,
                    },
                    Placement {
                        envelopes: Default::default(),
                        id: "movie-clip".into(),
                        source: "movie".into(),
                        range: Range {
                            start: Time::seconds(4),
                            duration: Time::seconds(8),
                        },
                        source_in: Time::ZERO,
                        speed: Speed::default(),
                        looping: false,
                    },
                    Placement {
                        envelopes: Default::default(),
                        id: "mic-clip".into(),
                        source: "microphone".into(),
                        range: Range {
                            start: Time::ZERO,
                            duration,
                        },
                        source_in: Time::ZERO,
                        speed: Speed::default(),
                        looping: false,
                    },
                ],
                tracks: vec![],
                cues: vec![],
                audio_routes: vec![AudioRoute {
                    id: "mic-program".into(),
                    source: "microphone".into(),
                    bus: Bus::Program,
                }],
            },
        );
        for id in ["landscape", "vertical"] {
            d.sequences.get_mut("main").unwrap().tracks.push(Track {
                id: format!("camera-motion-{id}"),
                target: Target {
                    path: format!("sets/studio/layouts/{id}/root/body/camera"),
                    property: Property::TranslateX,
                },
                range: Range {
                    start: Time::ZERO,
                    duration: Time::seconds(8),
                },
                keys: vec![
                    Key {
                        at: Time::ZERO,
                        value: Value::Number(0.),
                    },
                    Key {
                        at: Time::seconds(4),
                        value: Value::Number(-20.),
                    },
                    Key {
                        at: Time::seconds(8),
                        value: Value::Number(0.),
                    },
                ],
                interpolation: Interpolation::Linear,
            });
        }
        d.shows.insert(
            "native-show".into(),
            Show {
                set: "studio".into(),
                authority: Authority::Local,
                segments: vec![Segment {
                layout_changes: Vec::new(),
                    id: "teaching".into(),
                    title: "Live teaching".into(),
                    landscape: "landscape".into(),
                    vertical: "vertical".into(),
                    sequence: Some("main".into()),
                }],
            },
        );
        Self {
            mfm_direction: HostDirection::default(),
            mfm_framing: Default::default(),
            set_source_defaults: Default::default(),
            speaker_segments: BTreeMap::new(),
            untimed_segments: BTreeMap::new(),
            playing_segment: None,
            shot_override: None,
            rendering_show: false,
            mounted_set: default_mounted_set(),
            mounted_layout: None,
            version: 1,
            room: "native-room-lab".into(),
            canvas: CanvasSettings::default(),
            workspace: Workspace::default(),
            production: ProductionDocument(Arc::new(d)),
            lanes: vec![
                Lane {
                    id: "v1".into(),
                    label: "Screen share".into(),
                    source: "screen".into(),
                    kind: "video".into(),
                    muted: false,
                    gain: 1.,
                },
                Lane {
                    id: "v2".into(),
                    label: "Camera".into(),
                    source: "camera".into(),
                    kind: "video".into(),
                    muted: false,
                    gain: 1.,
                },
                Lane {
                    id: "v3".into(),
                    label: "MOV / insert".into(),
                    source: "movie".into(),
                    kind: "video".into(),
                    muted: false,
                    gain: 1.,
                },
                Lane {
                    id: "g1".into(),
                    label: "Title + motion".into(),
                    source: "title".into(),
                    kind: "graphics".into(),
                    muted: false,
                    gain: 1.,
                },
                Lane {
                    id: "a1".into(),
                    label: "Microphone".into(),
                    source: "microphone".into(),
                    kind: "audio".into(),
                    muted: false,
                    gain: 1.,
                },
            ],
            room_scenes: BTreeMap::new(),
            active_scene: default_active_scene(),
            scene: "studio".into(),
            inputs: BTreeMap::new(),
            camera_grades: BTreeMap::new(),
        }
    }
    /// Capture identity is separate from source type. Each endpoint receives its
    /// own timeline placement, gain and device binding.
    pub fn add_input(&mut self, kind: &str, device: &str, label: &str) -> Result<String> {
        let mut next = self.clone();
        let source = next.add_input_inner(kind, device, label)?;
        next.validate()?;
        *self = next;
        Ok(source)
    }
    pub(crate) fn add_input_inner(&mut self, kind: &str, device: &str, label: &str) -> Result<String> {
        if !matches!(kind, "camera" | "microphone")
            || device.is_empty()
            || device.len() > 512
            || label.is_empty()
            || label.len() > 160
        {
            bail!("Invalid capture device");
        }
        if self
            .inputs
            .values()
            .any(|b| b.kind == kind && b.device == device)
        {
            bail!("This device is already in Sources");
        }
        let n = (2..=5)
            .find(|n| {
                !self
                    .lanes
                    .iter()
                    .any(|lane| lane.source == format!("{kind}-{n}"))
            })
            .ok_or_else(|| anyhow!("Up to five inputs of each type are supported"))?;
        let source = format!("{kind}-{n}");
        self.production.sources.insert(
            source.clone(),
            Source::Live {
                role: if kind == "camera" {
                    Role::HostCamera
                } else {
                    Role::Microphone
                },
            },
        );
        self.configure_input_inner(&source, kind, device, label)?;
        Ok(source)
    }

    fn add_input_lane(&mut self, source: &str, kind: &str, label: &str) -> Result<()> {
        let seq = self.production.sequences.get_mut("main").context("Missing timeline")?;
        seq.placements.push(Placement {
            envelopes: Default::default(),
            id: format!("{source}-clip"),
            source: source.into(),
            range: Range {
                start: Time::ZERO,
                duration: seq.duration,
            },
            source_in: Time::ZERO,
            speed: Speed::default(),
            looping: false,
        });
        if kind == "microphone" {
            seq.audio_routes.push(AudioRoute {
                id: format!("{source}-program"),
                source: source.into(),
                bus: Bus::Program,
            });
        }
        self.lanes.push(Lane {
            id: format!("lane-{source}"),
            source: source.into(),
            label: label.into(),
            kind: if kind == "camera" { "video" } else { "audio" }.into(),
            gain: 1.,
            muted: kind == "microphone",
        });
        Ok(())
    }
    pub fn configure_input(
        &mut self,
        source: &str,
        kind: &str,
        device: &str,
        label: &str,
    ) -> Result<()> {
        let mut next = self.clone();
        next.configure_input_inner(source, kind, device, label)?;
        next.validate()?;
        *self = next;
        Ok(())
    }
    pub(crate) fn configure_input_inner(
        &mut self,
        source: &str,
        kind: &str,
        device: &str,
        label: &str,
    ) -> Result<()> {
        if device.is_empty() || device.len() > 512 || label.is_empty() || label.len() > 160 {
            bail!("Invalid capture device");
        }
        let expected = match self.production.sources.get(source) {
            Some(Source::Live {
                role: Role::HostCamera,
            }) => "camera",
            Some(Source::Live {
                role: Role::Microphone,
            }) => "microphone",
            _ => bail!("Source is not a device input"),
        };
        if expected != kind {
            bail!("Source and device types differ");
        }
        if self
            .inputs
            .iter()
            .any(|(id, b)| id != source && b.kind == kind && b.device == device)
        {
            bail!("This device is already in Sources");
        }
        let slot = if let Some(binding) = self.inputs.get(source) {
            binding.slot
        } else if kind == "camera" && source != "camera" {
            (4..8)
                .find(|slot| {
                    !self
                        .inputs
                        .values()
                        .any(|b| b.kind == "camera" && b.slot == *slot)
                })
                .ok_or_else(|| anyhow!("Camera capture budget reached"))?
        } else {
            0
        };
        if !self.lanes.iter().any(|lane| lane.source == source) {
            if source == kind {
                self.restore_source_lane(source)?;
            } else {
                self.add_input_lane(source, kind, label)?;
            }
        }
        self.inputs.insert(
            source.into(),
            InputBinding {
                kind: kind.into(),
                device: device.into(),
                slot,
            },
        );
        if let Some(lane) = self.lanes.iter_mut().find(|l| l.source == source) {
            lane.label = label.into();
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(self.mfm_framing.values().flatten().all(|v| (100..=300).contains(v)), "Shot zoom must be 100–300%");
        self.validate_room()?;
        validate_document(&self.production)?;
        Ok(())
    }
    fn validate_room(&self) -> Result<()> {
        if self.version != 1 || self.room.is_empty() || self.room.len() > 128 {
            bail!("Invalid room project");
        }
        if self.inputs.len() > 10 {
            bail!("Capture endpoint budget exceeded");
        }
        let mut slots = std::collections::BTreeSet::new();
        let mut devices = std::collections::BTreeSet::new();
        for (id, b) in &self.inputs {
            if !matches!(b.kind.as_str(), "camera" | "microphone")
                || b.device.is_empty()
                || b.device.len() > 512
                || !devices.insert((b.kind.clone(), b.device.clone()))
            {
                bail!("Invalid or duplicate input binding");
            }
            let primary = id == "camera" || id == "microphone";
            if (primary && b.slot != 0)
                || (!primary
                    && b.kind == "camera"
                    && (!(4..8).contains(&b.slot) || !slots.insert(b.slot)))
            {
                bail!("Invalid native input slot");
            }
            if !self.lanes.iter().any(|l| l.source == *id)
                || !matches!(self.production.sources.get(id),Some(Source::Live{role}) if (*role==Role::HostCamera&&b.kind=="camera")||(*role==Role::Microphone&&b.kind=="microphone"))
            {
                bail!("Input binding must reference a matching room source");
            }
        }
        self.workspace.validate()?;
        self.canvas.landscape.validate()?;
        self.canvas.vertical.validate()?;
        if self.lanes.len() > 32 || !self.production.sets.contains_key(&self.scene) {
            bail!("Invalid scene/layer admission");
        }
        if !self.production.sequences.contains_key("main") {
            bail!("Missing editorial sequence");
        }
        Ok(())
    }
    /// Room overrides adapt a prepared copy. The library Set/document stays unchanged.
    pub fn compile(&self) -> Result<Arc<compile::Plan>> {
        self.validate_room()?;
        let set = &self.production.sets[&self.scene];
        if set.canvas_fit == CanvasFit::Contain || set.layouts.values().all(|layout| {
            let size = match layout.orientation {
                Orientation::Landscape => self.canvas.landscape,
                Orientation::Vertical => self.canvas.vertical,
            };
            layout.width == size.width && layout.height == size.height
                && layout.root.frame.as_ref().is_none_or(|f| f.width == size.width as f64 && f.height == size.height as f64)
        }) {
            // The compiler validates this exact document before producing its plan.
            return self.select_compiled_sequence(compile::compile(&self.production)?);
        }
        validate_document(&self.production)?;
        let mut render = self.production.clone();
        if let Some(set) = render.sets.get_mut(&self.scene) {
            for l in set.layouts.values_mut() {
                let size = match l.orientation {
                    Orientation::Landscape => self.canvas.landscape,
                    Orientation::Vertical => self.canvas.vertical,
                };
                l.width = size.width;
                l.height = size.height;
                if let Some(frame) = &mut l.root.frame {
                    frame.width = size.width as f64;
                    frame.height = size.height as f64;
                }
            }
        }
        self.select_compiled_sequence(compile::compile(&render)?)
    }
    fn select_compiled_sequence(&self, mut plan: compile::Plan) -> Result<Arc<compile::Plan>> {
        if self.rendering_show {
            let segment = self.active_segment()?.context("No segment selected for program")?;
            if let Some(id) = &segment.sequence {
                let mut compiled = plan.sequences.get(id).context("Missing segment sequence")?.clone();
                if self.scene == "my-first-million" {
                    // Timing belongs to the authored role. The set supplies the input
                    // that occupies that role in this studio, including remote guests.
                    let bindings = crate::set_slots::bindings(&self.production.sets[&self.scene]);
                    for player in &mut Arc::make_mut(&mut compiled).players {
                        let slot = match player.source.as_str() {
                            "camera" => "node/stage/shaan",
                            "camera-2" => "node/stage/sam",
                            "rtc-guest" => "node/stage/guest",
                            "screen" => "node/stage/screen-share",
                            _ => continue,
                        };
                        if let Some(bound) = bindings.get(slot) {
                            player.source.clone_from(bound);
                        }
                    }
                }
                plan.sequences.insert("main".into(), compiled);
            }
        }
        Ok(Arc::new(plan))
    }

    pub fn active_segment(&self) -> Result<Option<&producer_production_contract::Segment>> {
        let Some((show_id, segment_id)) = &self.playing_segment else { return Ok(None) };
        let show = self.production.shows.get(show_id).context("Show unavailable")?;
        anyhow::ensure!(show.set == self.scene, "Show and mounted set differ");
        Ok(Some(show.segments.iter().find(|s| &s.id == segment_id).context("Segment unavailable")?))
    }

    pub fn show_layout_at(&self, seconds: f64) -> Option<SetLayoutPair> {
        let segment = self.active_segment().ok()??;
        if let Some(pair) = &self.shot_override { return Some(pair.clone()); }
        let time = time(seconds).ok()?;
        let (landscape, vertical) = segment.layouts_at(time);
        Some(SetLayoutPair { landscape: landscape.into(), vertical: vertical.into() })
    }

    pub fn segment_duration(&self, show: &str, segment: &Segment) -> Option<f64> {
        if self.untimed_segments.get(show).is_some_and(|ids| ids.contains(&segment.id)) { return None; }
        self.production.sequences.get(segment.sequence.as_ref()?).map(|seq| seq.duration.as_f64())
    }

    // The director has authority only during the exact opted-in show occurrence.
    // A manual shot takes precedence until the operator returns to the rundown.
    pub fn supports_host_shots(&self) -> bool {
        self.scene == "my-first-million" && self.mounted_set.as_deref() == Some("my-first-million")
            && self.rendering_show && self.shot_override.is_none()
            && self.playing_segment.as_ref().is_some_and(|(show, segment)|
                self.speaker_segments.get(show).is_some_and(|ids| ids.contains(segment)))
    }

    pub fn enter_segment(&mut self, show_id: &str, segment_id: &str) -> Result<()> {
        let show = self.production.shows.get(show_id).context("Show unavailable")?;
        let segment = show.segments.iter().find(|s| s.id == segment_id).context("Segment unavailable")?;
        let set = show.set.clone();
        let opening = SetLayoutPair { landscape: segment.landscape.clone(), vertical: segment.vertical.clone() };
        self.mount_set(Some(set.clone()), Some(opening))?;
        self.scene = set;
        self.playing_segment = Some((show_id.into(), segment_id.into()));
        Ok(())
    }

    pub fn command(&mut self, c: commands::Command) -> Result<()> {
        let next = commands::apply(&self.production, &c)?;
        let old = std::mem::replace(&mut self.production, ProductionDocument(Arc::new(next)));
        if let Err(e) = self.compile() {
            self.production = old;
            return Err(e);
        }
        Ok(())
    }
    pub fn trim(&mut self, clip: &str, start: f64, duration: f64, source_in: f64) -> Result<()> {
        if ![start, duration, source_in]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.)
            || duration < 0.05
        {
            bail!("Invalid trim");
        }
        let mut seq = self.production.sequences["main"].clone();
        let p = seq
            .placements
            .iter_mut()
            .find(|p| p.id == clip)
            .ok_or_else(|| anyhow!("Unknown clip"))?;
        p.range = Range {
            start: time(start)?,
            duration: time(duration)?,
        };
        p.source_in = time(source_in)?;
        self.command(commands::Command::Transaction {
            operations: vec![commands::Operation::ReplaceSequence {
                id: "main".into(),
                value: seq,
            }],
        })
    }
    pub fn bind_movie(&mut self, hash: &str, duration: f64) -> Result<()> {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            bail!("Expected a lowercase SHA-256 asset identity");
        }
        let id = format!("movie-{}", &hash[..32]);
        if self
            .production
            .assets
            .get(&id)
            .is_some_and(|a| a.hash != hash)
        {
            bail!("Asset identifier collision; import retained its previous source");
        }
        let mut operations = vec![];
        if !self.production.assets.contains_key(&id) {
            operations.push(commands::Operation::AddAsset {
                id: id.clone(),
                value: Asset {
                    hash: hash.into(),
                    kind: AssetKind::Video,
                    available: Some(Range {
                        start: Time::ZERO,
                        duration: time(duration)?,
                    }),
                },
            });
        }
        operations.push(commands::Operation::RemoveSource { id: "movie".into() });
        operations.push(commands::Operation::AddSource {
            id: "movie".into(),
            value: Source::Player { asset: id },
        });
        let mut seq = self.production.sequences["main"].clone();
        let p = seq
            .placements
            .iter_mut()
            .find(|p| p.source == "movie")
            .ok_or_else(|| anyhow::anyhow!("MOV placement missing"))?;
        p.source_in = Time::ZERO;
        p.range.duration = time(duration.min(8.))?;
        operations.push(commands::Operation::ReplaceSequence {
            id: "main".into(),
            value: seq,
        });
        self.command(commands::Command::Transaction { operations })
    }
    /// A committed snapshot is an immutable composite asset, not the growing
    /// recording directory. The private grant resolves its digest to fragments.
    pub fn bind_take(
        &mut self,
        hash: &str,
        available: Range,
        placement: Option<(f64, f64, f64)>,
    ) -> Result<()> {
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            bail!("Invalid committed asset identity");
        }
        let mut next = self.clone();
        let asset_id = format!("take-{}", &hash[..32]);
        let asset = Asset {
            hash: hash.into(),
            kind: AssetKind::Video,
            available: Some(available),
        };
        if next
            .production
            .assets
            .get(&asset_id)
            .is_some_and(|a| a != &asset)
        {
            bail!("Take asset collision");
        }
        next.production.assets.insert(asset_id.clone(), asset);
        next.production
            .sources
            .insert("take".into(), Source::Player { asset: asset_id });
        let seq = next.production.sequences.get_mut("main").unwrap();
        if let Some((start, duration, source_in)) = placement {
            let range = Range {
                start: time(start)?,
                duration: time(duration)?,
            };
            if duration < 0.05 {
                bail!("Committed clip must be at least 50ms");
            }
            let p = Placement {
                envelopes: Default::default(),
                id: "take-clip".into(),
                source: "take".into(),
                range,
                source_in: time(source_in)?,
                speed: Speed::default(),
                looping: false,
            };
            if let Some(old) = seq.placements.iter_mut().find(|p| p.id == "take-clip") {
                *old = p;
            } else {
                seq.placements.push(p);
            }
            seq.duration = seq.duration.max(range.end()?);
        }
        if !next.lanes.iter().any(|l| l.source == "take") {
            next.lanes.push(Lane {
                id: "v4".into(),
                label: "Committed take".into(),
                source: "take".into(),
                kind: "video".into(),
                muted: false,
                gain: 1.,
            });
        }
        // The first native adapter exposes an additional tile in its existing
        // media column. Authoring still uses ordinary source nodes/placements.
        fn slot(n: &mut Node) -> bool {
            if n.id == "main" {
                if n.children.iter().any(|n| n.id == "take") {
                    return true;
                }
                if let Flow::Column { sizes, .. } = &mut n.flow {
                    sizes.push(weight(1.));
                    n.children.push(node(
                        "take",
                        Content::Source {
                            source: "take".into(),
                            fit: Fit::Contain,
                        },
                    ));
                    return true;
                }
            }
            n.children.iter_mut().any(slot)
        }
        for l in next
            .production
            .sets
            .get_mut(&next.scene)
            .unwrap()
            .layouts
            .values_mut()
        {
            if !slot(&mut l.root) {
                bail!("This native Set has no media column for a take tile");
            }
        }
        next.compile()?;
        *self = next;
        Ok(())
    }
    pub fn scaffold_set(&mut self, id: &str, title: &str) -> Result<()> {
        if title.trim().is_empty() || title.len() > 200 {
            bail!("Set title needs 1..200 bytes");
        }
        let mut set = self.production.sets[&self.scene].clone();
        set.layouts = BTreeMap::from([
            (
                "landscape".into(),
                layout(self.canvas.landscape, Orientation::Landscape),
            ),
            (
                "vertical".into(),
                layout(self.canvas.vertical, Orientation::Vertical),
            ),
        ]);
        for layout in set.layouts.values_mut() {
            if let Content::Text { value, .. } = &mut layout.root.children[0].content {
                *value = title.into();
            }
        }
        let mut show = self.production.shows["native-show"].clone();
        show.set = id.into();
        let mut sequence = self.production.sequences["main"].clone();
        let prefix = format!("sets/{}/", self.scene);
        let added: Vec<_> = sequence
            .tracks
            .iter()
            .filter(|t| t.target.path.starts_with(&prefix))
            .cloned()
            .map(|mut track| {
                // Identity stays bounded when users derive Sets repeatedly.
                // Prefixing the previous ID grows beyond the contract limit.
                let identity = Sha256::digest(format!("{id}/{}", track.id).as_bytes());
                track.id = format!("motion-{}", &format!("{identity:x}")[..32]);
                track.target.path = track
                    .target
                    .path
                    .replacen(&prefix, &format!("sets/{id}/"), 1);
                track
            })
            .collect();
        sequence.tracks.extend(added);
        self.command(commands::Command::Transaction {
            operations: vec![
                commands::Operation::AddSet {
                    id: id.into(),
                    value: set,
                },
                commands::Operation::ReplaceShow {
                    id: "native-show".into(),
                    value: show,
                },
                commands::Operation::ReplaceSequence {
                    id: "main".into(),
                    value: sequence,
                },
            ],
        })?;
        self.scene = id.into();
        Ok(())
    }
    fn bare_composition() -> Set {
        let mut raw = Self::demo();
        let mut set = raw.production.sets.remove("studio").unwrap();
        for layout in set.layouts.values_mut() {
            let mut body = layout.root.children.remove(1);
            body.id = "root".into();
            body.frame = layout.root.frame;
            layout.root = body;
        }
        set
    }
    /// Materialize legacy rooms without changing the program or Set library.
    pub fn remember_scene_set(&mut self) {
        if self.room_scenes.is_empty() {
            self.active_scene = default_active_scene();
            self.room_scenes.insert(
                self.active_scene.clone(),
                RoomScene {
                    name: "Studio".into(),
                    composition: Self::bare_composition(),
                    mounted_set: self.mounted_set.clone(),
                    mounted_layout: self.mounted_layout.clone(),
                },
            );
        }
        if let Some(scene) = self.room_scenes.get_mut(&self.active_scene) {
            scene.mounted_set = self.mounted_set.clone();
            scene.mounted_layout = self.mounted_layout.clone();
        }
    }
    pub fn add_scene(&mut self) -> Result<String> {
        if self.room_scenes.len() >= 32 {
            bail!("A room supports up to 32 scenes");
        }
        self.remember_scene_set();
        let mut number = 2;
        while self.room_scenes.contains_key(&format!("scene-{number}")) {
            number += 1;
        }
        let id = format!("scene-{number}");
        let mut scene = self
            .room_scenes
            .get(&self.active_scene)
            .context("Unknown current scene")?
            .clone();
        scene.name = format!("Scene {number}");
        self.room_scenes.insert(id.clone(), scene);
        Ok(id)
    }
    pub fn remove_scene(&mut self, id: &str) -> Result<()> {
        if self.room_scenes.len() <= 1 {
            bail!("Keep at least one scene in the room");
        }
        if !self.room_scenes.contains_key(id) {
            bail!("Unknown scene");
        }
        self.remember_scene_set();
        if self.active_scene == id {
            let fallback = self
                .room_scenes
                .keys()
                .find(|key| key.as_str() != id)
                .unwrap()
                .clone();
            self.select_scene(&fallback)?;
        }
        self.room_scenes.remove(id);
        Ok(())
    }
    /// Remove a room instance, retaining reusable source definitions/assets in
    /// the document so existing Set templates and recorded takes remain valid.
    pub fn remove_source(&mut self, source: &str) -> Result<Arc<compile::Plan>> {
        if !self
            .lanes
            .iter()
            .any(|l| l.source == source && l.kind != "graphics")
        {
            bail!("Unknown room source");
        }
        self.lanes.retain(|l| l.source != source);
        self.inputs.remove(source);
        self.camera_grades.remove(source);
        // Disconnect a studio input without deleting authored cues from show timelines.
        if let Some(seq) = self.production.sequences.get_mut("main") {
            seq.placements.retain(|p| p.source != source);
            seq.audio_routes.retain(|r| r.source != source);
        }
        self.compile()
    }
    pub fn restore_source(&mut self, source: &str) -> Result<()> {
        if self.lanes.iter().any(|lane| lane.source == source) { return Ok(()); }
        self.restore_source_lane(source)?;
        self.compile()?;
        Ok(())
    }
    pub(crate) fn restore_source_lane(&mut self, source: &str) -> Result<()> {
        if self.lanes.iter().any(|l| l.source == source) {
            return Ok(());
        }
        let base = Self::demo();
        let mut lane = base
            .lanes
            .iter()
            .find(|l| l.source == source && l.kind != "graphics")
            .context("Unknown built-in source")?
            .clone();
        if lane.kind == "audio" {
            lane.muted = true;
        }
        self.lanes.push(lane);
        let seq = self
            .production
            .sequences
            .get_mut("main")
            .context("Missing timeline")?;
        let mut placement = base.production.sequences["main"]
            .placements
            .iter()
            .find(|p| p.source == source)
            .context("Missing source placement")?
            .clone();
        placement.range.start = Time::ZERO;
        placement.range.duration = seq.duration;
        seq.placements.push(placement);
        for route in &base.production.sequences["main"].audio_routes {
            if route.source == source {
                seq.audio_routes.push(route.clone());
            }
        }
        Ok(())
    }
    pub fn select_scene(&mut self, id: &str) -> Result<()> {
        if self.room_scenes.is_empty() && id == "studio" {
            return Ok(());
        }
        // Validate first: a rejected selection must not mutate the room.
        let scene = self.room_scenes.get(id).context("Unknown scene")?;
        let mounted = scene.mounted_set.clone();
        let layout = scene.mounted_layout.clone();
        self.remember_scene_set();
        self.playing_segment = None;
        self.shot_override = None;
        self.active_scene = id.into();
        self.mounted_set = mounted;
        self.mounted_layout = layout;
        Ok(())
    }
    /// Snapshot the live Set independently of editorial cuts and transport.
    pub fn rtc_video_slot(&self) -> Option<usize> {
        (4..8).find(|slot| !self.inputs.values().any(|binding| binding.kind == "camera" && binding.slot as usize == *slot))
    }
    pub fn set_layout_choices(&self, id: &str) -> Vec<SetLayoutChoice> {
        let Some(set) = self.production.sets.get(id) else { return Vec::new() };
        self.draft_layout_choices(id,set)
    }
    pub fn draft_layout_choices(&self, _id: &str, set: &Set) -> Vec<SetLayoutChoice> {
        let mut named = Vec::<SetLayoutChoice>::new();
        let default = SetLayoutPair::default();
        if default.exists_in(set) {
            named.push(SetLayoutChoice { label: "Default".into(), pair: default });
        }
        for (key, layout) in &set.layouts {
            if named.iter().any(|choice| choice.pair.ids().contains(&key.as_str())) {
                continue;
            }
            let (own, other, orientation) = match layout.orientation {
                Orientation::Landscape => ("landscape", "vertical", Orientation::Vertical),
                Orientation::Vertical => ("vertical", "landscape", Orientation::Landscape),
            };
            let stem = key.strip_suffix(&format!("-{own}")).unwrap_or(key);
            let sibling = format!("{stem}-{other}");
            let partner = [sibling.as_str(), other].into_iter().find(|id| {
                set.layouts.get(*id).is_some_and(|layout| layout.orientation == orientation)
            }).or_else(|| set.layouts.iter().find(|(_, layout)| layout.orientation == orientation)
                .map(|(id, _)| id.as_str()));
            let Some(partner) = partner else { continue };
            let pair = match layout.orientation {
                Orientation::Landscape => SetLayoutPair { landscape: key.clone(), vertical: partner.into() },
                Orientation::Vertical => SetLayoutPair { landscape: partner.into(), vertical: key.clone() },
            };
            named.push(SetLayoutChoice { label: set_label(stem), pair });
        }
        named
    }

    pub fn default_set_selection(&self, id: &str) -> SetLayoutPair {
        if self.mounted_set.as_deref() == Some(id) && self.scene == id {
            self.output_layout_pair()
        } else {
            self.set_layout_choices(id).into_iter().next().map(|choice| choice.pair).unwrap_or_default()
        }
    }

    pub fn mount_set(&mut self, id: Option<String>, pair: Option<SetLayoutPair>) -> Result<()> {
        let selected = if let Some(id) = id.as_deref() {
            let set = self.production.sets.get(id).context("Unknown Set")?;
            if let Some(pair) = pair {
                if !pair.exists_in(set) && pair != SetLayoutPair::default() {
                    bail!("The Set does not have that pair of layouts");
                }
                Some(pair)
            } else if self.mounted_set.as_deref() == Some(id) {
                self.mounted_layout.clone()
            } else {
                self.set_layout_choices(id).into_iter().next().map(|choice| choice.pair)
            }
        } else {
            None
        };
        self.playing_segment = None;
        self.shot_override = None;
        self.mounted_set = id;
        self.mounted_layout = selected;
        self.remember_scene_set();
        Ok(())
    }

    pub fn output_layouts(&self) -> [(&str, OutputSize); 2] {
        let [landscape, vertical] = self.mounted_layout.as_ref()
            .filter(|pair| self.mounted_set.as_deref() == Some(self.scene.as_str())
                && self.production.sets.get(&self.scene).is_some_and(|set| pair.exists_in(set)))
            .map_or(["landscape", "vertical"], SetLayoutPair::ids);
        [(landscape, self.canvas.landscape), (vertical, self.canvas.vertical)]
    }

    pub fn output_layout_pair(&self) -> SetLayoutPair {
        let [(landscape, _), (vertical, _)] = self.output_layouts();
        SetLayoutPair { landscape: landscape.into(), vertical: vertical.into() }
    }

    pub fn live_set(&self) -> Result<Self> {
        let mut next = self.clone();
        if let Some(id) = &self.mounted_set {
            if !self.production.sets.contains_key(id) {
                bail!("Unknown Set");
            }
            next.scene = id.clone();
        } else {
            let set = self
                .room_scenes
                .get(&self.active_scene)
                .map(|scene| scene.composition.clone())
                .unwrap_or_else(Self::bare_composition);
            next.production.sets.insert("room-scene".into(), set);
            next.scene = "room-scene".into();
        }
        if let Some(timed_media) = next.active_segment()?.map(|s| s.sequence.is_some()) {
            if let Some(pair) = &next.shot_override {
                next.mounted_layout = Some(pair.clone());
            }
            next.rendering_show = true;
            if timed_media { return Ok(next); }
        }
        let document = &mut *next.production;
        let seq = document.sequences
            .get_mut("main")
            .context("Missing timeline")?;
        let prefix = format!("sets/{}/", next.scene);
        seq.tracks.retain(|t| t.target.path.starts_with(&prefix));
        seq.cues.clear();
        seq.placements.clear();
        for (id, source) in &document.sources {
            if !next.lanes.iter().any(|lane| lane.source == *id) {
                continue;
            }
            seq.placements.push(Placement {
                envelopes: Default::default(),
                id: format!("live-{id}"),
                source: id.clone(),
                range: Range {
                    start: Time::ZERO,
                    duration: seq.duration,
                },
                source_in: Time::ZERO,
                speed: Speed::default(),
                looping: matches!(source, Source::Player { .. }),
            });
        }
        Ok(next)
    }
    pub fn assistant_context(&self) -> serde_json::Value {
        serde_json::json!({"renderGraph":{"profile":"producer.render/1","paint":"graph","pass":"fragment","language":"WGSL function body","inputs":["pass","source","image","layers"],"outputGraphs":"maps each layout ID to its terminal graph; layers are premultiplied RGBA","uniforms":["frame.info.xy = target pixels","frame.info.z = seconds","frame.info.w = layout progress","frame.params = four constants or numeric room fields"],"maxPasses":8,"commands":["setEditPreview","setEditSave"]},"room":self.room,"scenes":{"active":self.active_scene,"items":self.room_scenes.keys().collect::<Vec<_>>(),"commands":["sceneAdd","sceneSelect"],"addCopiesCurrentScene":true,"maximum":32},"activeView":self.canvas.view,"renderTargets":{"landscape":self.canvas.landscape,"vertical":self.canvas.vertical},"set":self.scene,"show":"native-show","authorAtRoomDimensions":true,"showLayoutsUseRoomDimensions":true,"responsiveLayout":true,"capabilities":["document.transaction","timeline.trim","canvas.size","panel.visibility","timeline.dock","workspace.move","workspace.place","source.addInput","source.configureInput","workspace.resize","workspace.collapse","workspace.activate","transport.seek","take.place","take.refresh","take.inspect","surface.style"],"workspace":{"layout":self.workspace,"panels":crate::workspace::PanelId::ALL,"edges":crate::workspace::Edge::ALL,"operation":"workspace","themes":["classic","orbitalGreen"],"actions":["setTheme","setHeader","move","place","activate","visibility","collapse","hideDock","resize","resizeSplit","reset"],"timelineEdges":["top","bottom"],"changesAffectOutput":false},"inputs":{"bindings":self.inputs,"commands":["addInput","configureInput"],"types":["camera","microphone"],"independentGainAndMute":true,"newMicrophonesMuted":true,"changesRequireIdleRecording":true},"visualRendering":{"surfaceStyle":["solid","linearGradient","veil","alpha","pixelRadius","innerBorder","grain","text"],"textFonts":["system-font"],"nativeTextTextureBudgetBytes":33554432,"maxTextElements":128,"writeOperation":"document.transaction.setSurface","resourcesPreparedOffRenderAudioLane":true}})
    }
}
pub fn time(seconds: f64) -> Result<Time> {
    if !seconds.is_finite() || seconds < 0. || seconds > 86400. {
        bail!("Time outside native room profile");
    }
    Ok(Time::new((seconds * 48000.).round() as i64, 48000)?)
}

#[cfg(test)]
mod tests {

    #[test]
    fn sets_offer_their_authored_layouts_without_a_show_or_conventional_names() {
        let room = RoomProject::demo();
        let mut set = room.production.sets["studio"].clone();
        let wide = set.layouts["landscape"].clone();
        let tall = set.layouts["vertical"].clone();
        set.layouts.clear();
        set.layouts.insert("wide-stage".into(), wide);
        set.layouts.insert("phone-view".into(), tall);
        let choices = room.draft_layout_choices("custom-set", &set);
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].pair.landscape, "wide-stage");
        assert_eq!(choices[0].pair.vertical, "phone-view");
    }

    #[test]
    fn contain_fits_the_authored_stage_to_hd_and_square_outputs() {
        let mut room = RoomProject::demo();
        let set = room.production.sets.get_mut("studio").unwrap();
        assert!(serde_json::to_value(&set).unwrap().get("canvasFit").is_none());
        set.canvas_fit = CanvasFit::Contain;
        let authored = set.layouts["landscape"].clone();
        let authored_rect = authored.root.frame.unwrap();
        let pair = [
            (OutputSize { width: 1280, height: 720 }, 0., 1280., 720.),
            (OutputSize::LANDSCAPE, 0., 1920., 1080.),
            (OutputSize::SQUARE, 236.25, 1080., 607.5),
        ];
        for (output, top, width, height) in pair {
            room.canvas.landscape = output;
            let plan = room.compile().unwrap();
            let root = plan.nodes.iter().find(|n| n.path ==
                format!("sets/studio/layouts/landscape/{}", authored.root.id)).unwrap();
            assert_eq!(root.frame, authored_rect);
            let fit = room.canvas.transform(&room.production.sets["studio"], &authored);
            assert_eq!(fit.rect(root.frame), Rect { x: 0., y: top, width, height });
        }
        assert_eq!(room.production.sets["studio"].layouts["landscape"], authored);
    }

    #[test]
    fn studio_snapshots_share_the_library_until_it_is_edited() {
        let room = RoomProject::demo();
        let mut copy = room.clone();
        assert!(Arc::ptr_eq(&room.production.0, &copy.production.0));
        copy.production.title = "Updated".into();
        assert_ne!(room.production.title, copy.production.title);
        assert!(!Arc::ptr_eq(&room.production.0, &copy.production.0));
    }

    #[test]
    fn capture_rejections_leave_the_document_unchanged() {
        let mut room = RoomProject::demo();
        room.configure_input("camera", "camera", "primary", "Host")
            .unwrap();
        let before = serde_json::to_value(&room).unwrap();
        assert!(room.add_input("camera", "primary", "Duplicate").is_err());
        assert_eq!(serde_json::to_value(&room).unwrap(), before);
        room.production.sequences.remove("main");
        let before = serde_json::to_value(&room).unwrap();
        assert!(room
            .configure_input("camera", "camera", "other", "Other")
            .is_err());
        assert_eq!(serde_json::to_value(&room).unwrap(), before);
    }
    #[test]
    fn multiple_capture_sources_have_independent_ids_routes_gains_and_persistent_devices() {
        let mut r = RoomProject::demo();
        r.configure_input("camera", "camera", "cam-primary", "Host webcam")
            .unwrap();
        r.configure_input("microphone", "microphone", "mic-primary", "Host mic")
            .unwrap();
        let camera = r
            .add_input("camera", "cam-secondary", "Overhead camera")
            .unwrap();
        let mic = r
            .add_input("microphone", "mic-secondary", "Guest mic")
            .unwrap();
        assert_ne!(camera, "camera");
        assert_ne!(mic, "microphone");
        assert_eq!(r.inputs[&camera].slot, 4);
        assert!(r.production.sequences["main"]
            .audio_routes
            .iter()
            .any(|a| a.source == mic));
        assert!(r.lanes.iter().find(|l| l.source == mic).unwrap().muted);
        r.lanes.iter_mut().find(|l| l.source == mic).unwrap().gain = 0.4;
        assert_eq!(
            r.lanes
                .iter()
                .find(|l| l.source == "microphone")
                .unwrap()
                .gain,
            1.
        );
        r.compile().unwrap();
        let restored: RoomProject =
            serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(restored.inputs, r.inputs);
        restored.compile().unwrap();
        assert!(r.add_input("camera", "cam-primary", "Duplicate").is_err());
        assert!(r
            .configure_input(&camera, "camera", "cam-primary", "Duplicate")
            .is_err());
    }
    #[test]
    fn camera_endpoint_budget_is_bounded_and_legacy_projects_still_load() {
        let mut r = RoomProject::demo();
        for i in 0..4 {
            r.add_input("camera", &format!("camera-{i}"), "Camera")
                .unwrap();
        }
        assert!(r.add_input("camera", "overflow", "Camera").is_err());
        let mut legacy = serde_json::to_value(RoomProject::demo()).unwrap();
        legacy.as_object_mut().unwrap().remove("inputs");
        let old: RoomProject = serde_json::from_value(legacy).unwrap();
        assert!(old.inputs.is_empty());
        old.compile().unwrap();
    }
    use super::*;
    #[test]
    fn paired_room_compiles_and_room_square_does_not_change_library_set() {
        let mut r = RoomProject::demo();
        r.compile().unwrap();
        let original = r.production.clone();
        r.canvas.landscape = OutputSize::SQUARE;
        let plan = r.compile().unwrap();
        assert_eq!(r.production, original);
        for n in plan
            .nodes
            .iter()
            .filter(|n| n.path.starts_with("sets/studio/layouts/landscape/"))
        {
            assert!(n.frame.x + n.frame.width <= 1081.);
            assert!(n.frame.y + n.frame.height <= 1081.);
        }
        assert_eq!(
            r.assistant_context()["renderTargets"]["landscape"]["width"],
            1080
        );
    }
    #[test]
    fn assistant_scaffold_authors_at_custom_room_dimensions_and_show_stays_linked() {
        let mut r = RoomProject::demo();
        r.canvas.landscape = OutputSize::SQUARE;
        r.canvas.vertical = OutputSize {
            width: 1200,
            height: 1500,
        };
        r.scaffold_set("agent-native", "Agent Native").unwrap();
        assert_eq!(
            r.production.sets["agent-native"].layouts["landscape"].width,
            1080
        );
        assert_eq!(
            r.production.sets["agent-native"].layouts["vertical"].height,
            1500
        );
        assert_eq!(r.production.sets["studio"].layouts["landscape"].width, 1920);
        assert_eq!(r.production.shows["native-show"].set, "agent-native");
        r.compile().unwrap();
        for i in 0..8 {
            r.scaffold_set(&format!("agent-native-generation-{i}"), "Next Studio")
                .unwrap();
            r.compile().unwrap();
        }
    }
    #[test]
    fn invalid_trim_is_atomic_and_independent_placements_are_preserved() {
        let mut r = RoomProject::demo();
        let original = r.production.clone();
        assert!(r.trim("movie-clip", 4., 30., 0.).is_err());
        assert_eq!(r.production, original);
        r.trim("movie-clip", 5., 3., 2.).unwrap();
        let seq = &r.production.sequences["main"];
        assert_eq!(seq.placements.len(), 4);
        assert_eq!(seq.placements[2].source_in, Time::seconds(2));
        assert_eq!(seq.placements[0].range.duration, Time::seconds(30));
    }
    #[test]
    fn movie_import_declares_immutable_asset_and_rebinds_stable_source() {
        let mut r = RoomProject::demo();
        let old = r.production.assets["movie-asset"].clone();
        r.bind_movie(&"a".repeat(64), 11.).unwrap();
        assert_eq!(r.production.assets["movie-asset"], old);
        assert_eq!(
            r.production.sources["movie"],
            Source::Player {
                asset: format!("movie-{}", "a".repeat(32))
            }
        );
        r.bind_movie(&"a".repeat(64), 11.).unwrap();
        assert_eq!(r.production.assets.len(), 3);
        assert!(r.bind_movie("invalid-hash", 11.).is_err());
    }
    #[test]
    fn frozen_take_refresh_preserves_trims_assets_and_live_sources() {
        let mut r = RoomProject::demo();
        let old = r.production.clone();
        let range = Range {
            start: time(0.3).unwrap(),
            duration: time(5.).unwrap(),
        };
        r.bind_take(&"c".repeat(64), range, Some((1., 2., 1.)))
            .unwrap();
        r.trim("take-clip", 2., 1., 2.).unwrap();
        let clip = r.production.sequences["main"]
            .placements
            .last()
            .unwrap()
            .clone();
        let prior = r.production.assets.clone();
        r.bind_take(
            &"d".repeat(64),
            Range {
                start: range.start,
                duration: time(9.).unwrap(),
            },
            None,
        )
        .unwrap();
        assert_eq!(
            &clip,
            r.production.sequences["main"].placements.last().unwrap()
        );
        for (k, v) in prior.iter() {
            assert_eq!(r.production.assets.get(k), Some(v));
        }
        for id in ["camera", "screen", "movie", "microphone"] {
            assert_eq!(r.production.sources[id], old.sources[id]);
        }
        assert_eq!(r.lanes.iter().filter(|l| l.source == "take").count(), 1);
        for l in r.production.sets["studio"].layouts.values() {
            let main = &l.root.children[1].children[0];
            assert_eq!(main.children.iter().filter(|n| n.id == "take").count(), 1);
        }
        let good = r.production.clone();
        assert!(r
            .bind_take(&"e".repeat(64), range, Some((0., 99., 0.)))
            .is_err());
        assert_eq!(r.production, good);
        assert!(r.trim("take-clip", 0., 10., 2.).is_err());
        r.compile().unwrap();
    }
    #[test]
    fn selecting_a_segment_preserves_its_cuts_and_keeps_preview_independent() {
        let mut room = RoomProject::demo();
        let (show, first) = room.production.shows.iter().next().map(|(id,s)| (id.clone(),s.segments[0].clone())).unwrap();
        let mut second = first.clone();
        second.id = "interview".into();
        second.sequence = Some("interview-cut".into());
        let mut sequence = room.production.sequences["main"].clone();
        sequence.cues.clear();
        room.production.sequences.insert("interview-cut".into(), sequence.clone());
        room.production.shows.get_mut(&show).unwrap().segments.push(second);
        room.enter_segment(&show, "interview").unwrap();
        let program = room.live_set().unwrap();
        assert_eq!(program.active_segment().unwrap().unwrap().id, "interview");
        assert_eq!(program.output_layout_pair(), room.output_layout_pair());
        assert_eq!(program.compile().unwrap().sequences["main"].cues.len(), 0);
        assert_eq!(room.production.sequences["main"].placements, program.production.sequences["main"].placements);
        assert!(!room.rendering_show && program.rendering_show);
        let mut restored: RoomProject = serde_json::from_slice(&serde_json::to_vec(&room).unwrap()).unwrap();
        assert!(restored.active_segment().unwrap().is_none());
        restored.enter_segment(&show,&first.id).unwrap();
        assert_eq!(restored.active_segment().unwrap().unwrap().id, first.id);
    }

    #[test]
    fn live_set_ignores_editorial_cuts_without_mutating_the_draft() {
        let mut room = RoomProject::demo();
        room.trim("camera-clip", 9., 2., 0.).unwrap();
        let original = room.production.clone();
        let live = room.live_set().unwrap();
        live.compile().unwrap();
        assert_eq!(room.production, original);
        let camera = live.production.sequences["main"]
            .placements
            .iter()
            .find(|p| p.source == "camera")
            .unwrap();
        assert_eq!(camera.range.start, Time::ZERO);
        assert_eq!(
            camera.range.duration,
            live.production.sequences["main"].duration
        );
        assert_eq!(
            live.production.sequences["main"].tracks.len(),
            original.sequences["main"].tracks.len()
        );
    }
    #[test]
    fn removing_a_set_yields_a_valid_bare_room_and_preserves_library() {
        let mut room = RoomProject::demo();
        room.mounted_set = None;
        let bare = room.live_set().unwrap();
        bare.compile().unwrap();
        assert_eq!(bare.scene, "room-scene");
        assert!(room.production.sets.contains_key("studio"));
        assert!(!room.production.sets.contains_key("room-scene"));
        room.mounted_set = Some("missing".into());
        assert!(room.live_set().is_err());
    }
    #[test]
    fn scenes_persist_without_touching_library_timeline_or_program_selection() {
        let mut room = RoomProject::demo();
        let document = room.production.clone();
        let id = room.add_scene().unwrap();
        assert_eq!(room.active_scene, "studio");
        assert_eq!(room.production, document);
        room.select_scene(&id).unwrap();
        room.mounted_set = None;
        room.remember_scene_set();
        room.live_set().unwrap().compile().unwrap();
        let bytes = serde_json::to_vec(&room).unwrap();
        let mut restored: RoomProject = serde_json::from_slice(&bytes).unwrap();
        restored.select_scene("studio").unwrap();
        assert_eq!(restored.mounted_set.as_deref(), Some("studio"));
        restored.select_scene(&id).unwrap();
        assert!(restored.mounted_set.is_none());
        assert!(restored.select_scene("missing").is_err());
        assert_eq!(restored.active_scene, id);
        assert_eq!(restored.production, document);
    }
    #[test]
    fn scene_budget_is_bounded_and_failed_add_is_unchanged() {
        let mut room = RoomProject::demo();
        for _ in 0..31 {
            room.add_scene().unwrap();
        }
        let before = serde_json::to_vec(&room).unwrap();
        assert!(room.add_scene().is_err());
        assert_eq!(serde_json::to_vec(&room).unwrap(), before);
    }
    #[test]
    fn removal_preserves_templates_and_does_not_resurrect_live_sources() {
        let mut room = RoomProject::demo();
        let sets = room.production.sets.clone();
        room.remove_source("camera").unwrap();
        assert!(!room.live_set().unwrap().production.sequences["main"]
            .placements
            .iter()
            .any(|p| p.source == "camera"));
        assert_eq!(room.production.sets, sets);
        room.restore_source("camera").unwrap();
        room.compile().unwrap();
        assert_eq!(
            room.lanes.iter().filter(|l| l.source == "camera").count(),
            1
        );
        assert!(room.remove_source("missing").is_err());
        for _ in 0..8 {
            let id = room
                .add_input("camera", "test-device", "Test camera")
                .unwrap();
            assert_eq!(id, "camera-2");
            room.remove_source(&id).unwrap();
        }
        let id = room.add_scene().unwrap();
        room.select_scene(&id).unwrap();
        room.remove_scene(&id).unwrap();
        assert_eq!(room.active_scene, "studio");
        assert!(room.remove_scene("studio").is_err());
    }
}
