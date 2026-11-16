use crate::{Range, Speed, Time};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub type Id = String;
pub type Digest = String;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Document {
    pub schema: Version,
    pub id: Id,
    pub title: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub assets: BTreeMap<Id, Asset>,
    #[serde(default)]
    pub sources: BTreeMap<Id, Source>,
    #[serde(default)]
    pub components: BTreeMap<Id, Component>,
    #[serde(default)]
    pub sets: BTreeMap<Id, Set>,
    #[serde(default)]
    pub sequences: BTreeMap<Id, Sequence>,
    #[serde(default)]
    pub shows: BTreeMap<Id, Show>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
pub enum Version {
    #[serde(rename = "producer.production/1")]
    V1,
}
impl Document {
    pub fn empty(id: &str, title: &str) -> Self {
        Self {
            schema: Version::V1,
            id: id.into(),
            title: title.into(),
            metadata: BTreeMap::new(),
            assets: BTreeMap::new(),
            sources: BTreeMap::new(),
            components: BTreeMap::new(),
            sets: BTreeMap::new(),
            sequences: BTreeMap::new(),
            shows: BTreeMap::new(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Asset {
    pub hash: Digest,
    pub kind: AssetKind,
    #[serde(default)]
    pub available: Option<Range>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Video,
    Audio,
    Image,
    Geometry,
    Material,
    Font,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum Source {
    Live { role: Role },
    Player { asset: Id },
    Graphics { scene: Scene3d },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    HostCamera,
    Screen,
    Guest,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Authority {
    Local,
    Hosted,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Component {
    pub version: u32,
    pub authority: Authority,
    #[serde(default)]
    pub props: BTreeMap<Id, Value>,
    pub root: Node,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Set {
    pub layouts: BTreeMap<Id, Layout>,
    #[serde(default)]
    pub theme: BTreeMap<Id, String>,
    #[serde(default)]
    pub actions: BTreeMap<Id, Vec<Action>>,
    #[serde(default)]
    pub controls: Vec<Control>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Orientation {
    Landscape,
    Vertical,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Layout {
    pub orientation: Orientation,
    pub width: u32,
    pub height: u32,
    pub root: Node,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum Flow {
    #[default]
    Overlay,
    Row {
        gap: f64,
        sizes: Vec<Size>,
    },
    Column {
        gap: f64,
        sizes: Vec<Size>,
    },
    Grid {
        gap: f64,
        columns: u32,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum Size {
    Fixed { pixels: f64 },
    Weight { weight: f64, min: f64, max: f64 },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Node {
    pub id: Id,
    #[serde(default)]
    pub frame: Option<Rect>,
    #[serde(default)]
    pub flow: Flow,
    pub content: Content,
    #[serde(default)]
    pub children: Vec<Node>,
    #[serde(default)]
    pub bindings: Vec<Binding>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum Content {
    Group,
    Text {
        value: String,
        font: Digest,
    },
    Source {
        source: Id,
        fit: Fit,
    },
    Component {
        definition: Id,
        pin: Digest,
        #[serde(default)]
        props: BTreeMap<Id, Value>,
    },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Fit {
    Contain,
    Cover,
    Stretch,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(
    tag = "type",
    content = "value",
    deny_unknown_fields,
    rename_all = "camelCase"
)]
pub enum Value {
    Number(f64),
    Bool(bool),
    Text(String),
    Color(String),
    Vec3([f64; 3]),
}
#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(rename_all = "camelCase")]
pub enum Property {
    Opacity,
    TranslateX,
    TranslateY,
    Scale,
    Rotation,
    Visibility,
    CameraPosition,
    CameraTarget,
    CameraFov,
    MaterialColor,
    MaterialRoughness,
    LightIntensity,
    Uniform,
    InstanceOffset,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Target {
    pub path: String,
    pub property: Property,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "op", deny_unknown_fields, rename_all = "camelCase")]
pub enum Expr {
    Literal {
        value: Value,
    },
    Input {
        name: Id,
    },
    Add {
        a: Box<Expr>,
        b: Box<Expr>,
    },
    Subtract {
        a: Box<Expr>,
        b: Box<Expr>,
    },
    Multiply {
        a: Box<Expr>,
        b: Box<Expr>,
    },
    Divide {
        a: Box<Expr>,
        b: Box<Expr>,
    },
    Less {
        a: Box<Expr>,
        b: Box<Expr>,
    },
    Equal {
        a: Box<Expr>,
        b: Box<Expr>,
    },
    Select {
        condition: Box<Expr>,
        yes: Box<Expr>,
        no: Box<Expr>,
    },
    Clamp {
        value: Box<Expr>,
        min: Box<Expr>,
        max: Box<Expr>,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub property: Property,
    pub expression: Expr,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum Action {
    SetParameter { target: Target, value: Value },
    EmitCue { cue: Id },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Control {
    pub id: Id,
    pub label: String,
    pub action: Id,
    pub scope: ControlScope,
    #[serde(default)]
    pub compact: bool,
    #[serde(default)]
    pub equal_width: bool,
    #[serde(default)]
    pub primary: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum ControlScope {
    EntireSet,
    Layout { layout: Id },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Sequence {
    pub duration: Time,
    #[serde(default)]
    pub instances: Vec<SequenceInstance>,
    #[serde(default)]
    pub placements: Vec<Placement>,
    #[serde(default)]
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub cues: Vec<Cue>,
    #[serde(default)]
    pub audio_routes: Vec<AudioRoute>,
}
/// A placement owns time mapping, not a copy of the reusable definition.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SequenceInstance {
    pub id: Id,
    pub sequence: Id,
    pub range: Range,
    pub source_in: Time,
    #[serde(default)]
    pub speed: Speed,
    #[serde(default)]
    pub looping: bool,
    #[serde(default)]
    pub target_bindings: Vec<TargetBinding>,
    #[serde(default)]
    pub source_bindings: Vec<SourceBinding>,
}
/// Exact exported-property rebinding; no prefix substitution or arbitrary paths.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TargetBinding {
    pub from: Target,
    pub to: Target,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SourceBinding {
    pub from: Id,
    pub to: Id,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Placement {
    pub id: Id,
    pub source: Id,
    pub range: Range,
    pub source_in: Time,
    #[serde(default)]
    pub speed: Speed,
    #[serde(default)]
    pub looping: bool,
}
impl Placement {
    /// Maps a finite file player. Live sources never call this file-time mapping.
    pub fn source_time(&self, parent: Time, available: Range) -> crate::Result<Option<Time>> {
        if !self.range.contains(parent)? {
            return Ok(None);
        }
        let elapsed = parent.checked_sub(self.range.start)?.scale(self.speed)?;
        let source = if self.looping {
            let offset = self
                .source_in
                .checked_sub(available.start)?
                .checked_add(elapsed)?;
            available
                .start
                .checked_add(offset.loop_offset(available.duration)?.0)?
        } else {
            self.source_in.checked_add(elapsed)?
        };
        if !available.contains(source)? {
            return Err(crate::Error::new(
                "SOURCE_RANGE",
                &self.id,
                "mapped sample outside finite file range",
            ));
        }
        Ok(Some(source))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Track {
    pub id: Id,
    pub target: Target,
    pub range: Range,
    pub keys: Vec<Key>,
    pub interpolation: Interpolation,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Key {
    pub at: Time,
    pub value: Value,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Interpolation {
    Step,
    Linear,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Cue {
    pub id: Id,
    pub at: Time,
    #[serde(default)]
    pub at_start: bool,
    #[serde(default)]
    pub each_loop: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AudioRoute {
    pub id: Id,
    pub source: Id,
    pub bus: Bus,
}
#[derive(
    Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq, PartialOrd, Ord,
)]
#[serde(rename_all = "camelCase")]
pub enum Bus {
    Program,
    Monitor,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Show {
    pub set: Id,
    pub authority: Authority,
    pub segments: Vec<Segment>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Segment {
    pub id: Id,
    pub title: String,
    pub landscape: Id,
    pub vertical: Id,
    #[serde(default)]
    pub sequence: Option<Id>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Scene3d {
    pub parameters: BTreeMap<Id, SceneParameter>,
    #[serde(default)]
    pub batches: Vec<Batch>,
    pub analytic: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SceneParameter {
    pub property: Property,
    pub initial: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Batch {
    pub id: Id,
    pub geometry: Id,
    pub material: Id,
    pub instances: u32,
}
