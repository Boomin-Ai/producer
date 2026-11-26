use crate::SharedMap;
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
    #[serde(default, deserialize_with = "crate::ingress::metadata")]
    #[schemars(with = "BTreeMap<String, serde_json::Value>")]
    pub metadata: SharedMap<serde_json::Value>,
    #[serde(default)]
    #[schemars(with = "BTreeMap<Id, Asset>")]
    pub assets: SharedMap<Asset>,
    #[serde(default)]
    #[schemars(with = "BTreeMap<Id, Source>")]
    pub sources: SharedMap<Source>,
    #[serde(default)]
    #[schemars(with = "BTreeMap<Id, Component>")]
    pub components: SharedMap<Component>,
    #[serde(default)]
    #[schemars(with = "BTreeMap<Id, Set>")]
    pub sets: SharedMap<Set>,
    #[serde(default)]
    #[schemars(with = "BTreeMap<Id, Sequence>")]
    pub sequences: SharedMap<Sequence>,
    #[serde(default)]
    #[schemars(length(max = 64))]
    #[schemars(with = "BTreeMap<Id, Show>")]
    pub shows: SharedMap<Show>,
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
            metadata: SharedMap::default(),
            assets: SharedMap::default(),
            sources: SharedMap::default(),
            components: SharedMap::default(),
            sets: SharedMap::default(),
            sequences: SharedMap::default(),
            shows: SharedMap::default(),
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
    Microphone,
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
/// How a room maps its authored sets to an output with different dimensions.
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CanvasFit {
    #[default]
    Reflow,
    Contain,
}
impl CanvasFit {
    fn is_reflow(&self) -> bool { *self == Self::Reflow }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Set {
    #[serde(default, skip_serializing_if = "CanvasFit::is_reflow")]
    pub canvas_fit: CanvasFit,
    /// Named, versioned GPU graphs shared by the layouts in this set.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub graphs: BTreeMap<Id, RenderGraph>,
    /// Layout id to terminal render graph. Older layouts lower to one composite pass.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub output_graphs: BTreeMap<Id, Id>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_transition_ms: Option<u16>,
    /// Animated layout to resting layout. The animated graph runs from 0 to 1
    /// on entry from its resting layout and from 1 to 0 on return.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub reversible_layout_transitions: BTreeMap<Id, Id>,
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
/// Composition/output role; dimensions may be custom, including square.
/// Shows pair roles, while the room independently chooses each output size.
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
/// Normalized parent anchor or local transform pivot, in [0, 1] on each axis.
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UnitPoint {
    #[schemars(range(min = 0.0, max = 1.0))]
    pub x: f64,
    #[schemars(range(min = 0.0, max = 1.0))]
    pub y: f64,
}
/// Integer display ratio. Pixel aspect and rotation must already be normalized
/// by the source adapter; these are not raw encoded dimensions.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Ratio {
    #[schemars(range(min = 1, max = 65536))]
    pub width: u32,
    #[schemars(range(min = 1, max = 65536))]
    pub height: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum AspectRatio {
    Fixed {
        ratio: Ratio,
    },
    /// Use a qualified control-lane input, or the explicit portable fallback.
    Source {
        source: Id,
        fallback: Ratio,
    },
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AspectMode {
    /// Preserve width and derive height. Column aspect items use this mode.
    Width,
    /// Preserve height and derive width. Row aspect items use this mode.
    Height,
    /// Fit inside the allocated box without changing sibling allocation.
    Contain,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AspectConstraint {
    pub ratio: AspectRatio,
    pub mode: AspectMode,
}
/// Frame offsets are measured from the parent anchor to this node's pivot.
/// For flow items, the allocated cell is the parent box and offsets are zero.
#[derive(Debug, Default, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NodePlacement {
    #[serde(default)]
    pub anchor: UnitPoint,
    #[serde(default)]
    pub pivot: UnitPoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aspect: Option<AspectConstraint>,
}
/// Observed geometry is a compile input, not a document edit or frame callback.
/// Native adapters must fence document/source incarnation before supplying it.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LayoutInputs {
    pub document: Id,
    #[serde(default)]
    #[schemars(length(max = 256))]
    pub sources: BTreeMap<Id, SourceDimensions>,
}
impl LayoutInputs {
    pub fn empty(document: &str) -> Self {
        Self {
            document: document.into(),
            sources: BTreeMap::new(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceDimensions {
    /// Hash of document/source/resolved asset definition, not an authority grant.
    pub identity: Digest,
    pub display: Ratio,
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
    Fixed {
        pixels: f64,
    },
    Weight {
        weight: f64,
        min: f64,
        max: f64,
    },
    /// Derive the main-axis length from this child's aspect constraint and the
    /// parent's cross-axis extent. The following siblings reflow accordingly.
    Aspect,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Node {
    pub id: Id,
    /// Local surface/typography. Missing style preserves the original contract.
    /// Coordinates and radii are authored canvas pixels, not CSS or UI points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<SurfaceStyle>,
    #[serde(default)]
    pub frame: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<NodePlacement>,
    #[serde(default)]
    pub flow: Flow,
    pub content: Content,
    #[serde(default)]
    pub children: Vec<Node>,
    #[serde(default)]
    pub bindings: Vec<Binding>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SurfaceStyle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<Paint>,
    #[serde(default)]
    #[schemars(range(min = 0.0, max = 2048.0))]
    pub radius: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<SurfaceBorder>,
    /// Static fine luminance texture. No random allocations or animation clock.
    #[serde(default)]
    #[schemars(range(min = 0.0, max = 0.15))]
    pub grain: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<TextStyle>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Ink {
    /// sRGB RGB hex, exactly #RRGGBB. Alpha is the separate opacity field.
    #[schemars(regex(pattern = "^#[0-9A-Fa-f]{6}$"))]
    pub color: String,
    #[schemars(range(min = 0.0, max = 1.0))]
    pub opacity: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields, rename_all = "camelCase")]
pub enum Paint {
    Graph { graph: Id },
    /// Digest-backed PNG artwork in the room asset library.
    Image { asset: Id, fit: Fit },
    Solid {
        ink: Ink,
    },
    /// Interpolate straight RGBA over a line across this surface. Alpha is real
    /// compositing alpha: lower video layers remain visible through the paint.
    Linear {
        from: Ink,
        to: Ink,
        angle: f64,
    },
    /// Animated contour lines. Width is in output pixels, period in seconds.
    Contours {
        ink: Ink,
        #[schemars(range(min = 0.5, max = 16.0))]
        width: f64,
        #[schemars(range(min = 1.0, max = 600.0))]
        period: f64,
    },
    /// Spatially varied translucent ink with a fine halftone. Evaluated on the
    /// GPU against production time; no generated images or frame uploads.
    Veil {
        from: Ink,
        to: Ink,
        glow: Ink,
        #[schemars(range(min = 2.0, max = 24.0))]
        cell: f64,
        #[schemars(range(min = 0.0, max = 1.0))]
        motion: f64,
    },
}
/// Ordered current-frame resource dependencies. Future resource lifetimes and
/// compute/geometry pass kinds require explicit admission in a new profile.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RenderGraph {
    pub profile: GraphProfile,
    #[serde(default, skip_serializing_if = "GraphClock::is_live")]
    pub clock: GraphClock,
    pub passes: Vec<GraphPass>,
}
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GraphClock {
    #[default]
    Live,
    Timeline,
    /// Geometry camera keys use the layout transition's normalized progress.
    /// Fragment passes continue to use the live clock.
    Layout,
}
impl GraphClock {
    fn is_live(&self) -> bool { *self == Self::Live }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
pub enum GraphProfile {
    #[serde(rename = "producer.render/1")]
    V1,
    #[serde(rename = "producer.geometry/1")]
    Geometry,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum GraphPass {
    Geometry {
        id: Id,
        #[serde(default)]
        inputs: Vec<GraphInput>,
        scene: crate::geometry::GeometryScene,
    },
    Fragment {
        id: Id,
        /// WGSL function body returning straight-alpha RGBA in
        /// the set compositor's color space. The runtime supplies uv and globals.
        shader: String,
        #[serde(default)]
        inputs: Vec<GraphInput>,
        #[serde(default)]
        params: [f32; 4],
        /// Optional numeric room field for each parameter. Missing data uses params.
        #[serde(default, skip_serializing_if = "no_graph_fields")]
        fields: [Option<Id>; 4],
    },
}
impl GraphPass {
    pub fn inputs(&self) -> &[GraphInput] {
        match self { Self::Geometry {inputs,..} | Self::Fragment {inputs,..} => inputs }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum GraphInput {
    /// Premultiplied RGBA of the named top-level layout branches in document order.
    Layers { nodes: Vec<Id> },
    Pass { id: Id },
    Source { id: Id },
    Image { asset: Id },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SurfaceBorder {
    pub ink: Ink,
    #[schemars(range(min = 0.0, max = 32.0))]
    pub width: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TextStyle {
    /// Named scalar field from the room snapshot. Text content supplies the offline fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<Id>,
    #[schemars(range(min = 6.0, max = 512.0))]
    pub font_size: f64,
    #[schemars(range(min = 100, max = 900))]
    pub weight: u16,
    pub ink: Ink,
    pub align: TextAlign,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
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
    EaseInOut,
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
    #[schemars(length(min = 1, max = 256))]
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
    /// Opt-in reconstruction inputs. Omitted legacy scenes make no promise
    /// about an effect clock/seed; admission never invents either one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reconstruction: Option<AnalyticReconstruction>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AnalyticReconstruction {
    pub version: AnalyticVersion,
    pub seed: crate::Counter,
    pub scope: SeedScope,
    /// Positive cycle length, between 1 ms and 24 h. This is an effect period,
    /// not a decoder range or a second transport.
    pub period: Time,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub enum AnalyticVersion {
    #[serde(rename = "producer.analytic/1")]
    V1,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SeedScope {
    Source,
    Placement,
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

fn no_graph_fields(fields: &[Option<Id>; 4]) -> bool { fields.iter().all(Option::is_none) }
