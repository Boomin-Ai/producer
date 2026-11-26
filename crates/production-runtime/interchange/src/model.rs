//! On-wire vocabulary for production interchange. All map keys are stable local IDs.
use producer_production_contract::Range;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Map<T> = BTreeMap<String, T>;
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub enum Version {
    #[serde(rename = "producer.bundle/1")]
    V1,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub protocol: Version,
    pub production: String,
    pub document_sha256: String,
    pub parent: Option<String>,
    pub authored_at: u64,
    pub author: String,
    pub workflow: Workflow,
    pub entry: Option<Entry>,
    pub assets: Map<Media>,
    #[serde(default)]
    pub universes: Map<Universe>,
    #[serde(default)]
    pub entities: Map<Entity>,
    #[serde(default)]
    pub actors: Map<Actor>,
    #[serde(default)]
    pub shots: Map<Shot>,
    pub setup: Option<Setup>,
    #[serde(default)]
    pub sequence_setups: Map<Setup>,
    #[serde(default)]
    pub contributions: Map<Contribution>,
    #[serde(default)]
    pub mix: Vec<Mix>,
    #[serde(default)]
    pub extensions: Map<Extension>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub show: String,
    pub segment: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Media {
    pub original: Representation,
    #[serde(default)]
    pub proxies: Vec<Representation>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Representation {
    pub sha256: String,
    pub format: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Setup {
    pub camera: Option<Camera>,
    pub lighting: Option<String>,
    pub brief: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Universe {
    pub origin: Option<ResourceOrigin>,
    pub setup: Option<Setup>,
    pub name: String,
    #[serde(default)]
    pub style: Map<Value>,
    pub lore: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum EntityKind {
    Character,
    Location,
    Prop,
    Style,
    Wardrobe,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entity {
    pub origin: Option<ResourceOrigin>,
    pub voice: Option<Voice>,
    pub name: String,
    pub kind: EntityKind,
    pub universe: Option<String>,
    pub played_by: Option<String>,
    #[serde(default)]
    pub traits: Map<Value>,
    pub prompt_scaffold: Option<String>,
    #[serde(default)]
    pub references: Vec<Reference>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ActorKind {
    Person,
    Entity,
    Brand,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Actor {
    pub name: String,
    pub kind: ActorKind,
    pub identity: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cut {
    pub sequence: String,
    pub placement: String,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CreditKind {
    BrandPlacement,
    Performance,
    Production,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Lead,
    Editor,
    Reviewer,
    Viewer,
    Creator,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contribution {
    pub actor: String,
    pub role: Role,
    pub kind: CreditKind,
    pub cut: Cut,
    pub featured_entity: Option<String>,
    pub disclosure: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SoundRole {
    Dialogue,
    Narration,
    Music,
    Effects,
    Ambience,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mix {
    pub sequence: String,
    pub route: String,
    pub role: SoundRole,
    pub gain_millidb: i32,
    pub muted: bool,
    pub balance_permille: i16,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RefRole {
    Subject,
    Wardrobe,
    Location,
    Style,
    Composition,
    FirstFrame,
    LastFrame,
    CameraMotion,
    Performance,
    Voice,
    Sound,
    Storyboard,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    pub asset: String,
    pub role: RefRole,
    pub instruction: String,
    pub range: Option<Range>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Camera {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub focal_length_mm: Option<f64>,
    pub aperture_f: Option<f64>,
    pub focus_distance_m: Option<f64>,
    pub iso: Option<u32>,
    pub shutter_angle_deg: Option<f64>,
    pub white_balance_k: Option<u32>,
    pub sensor: Option<String>,
    pub framing: Option<String>,
    pub angle: Option<String>,
    pub movement: Option<String>,
    pub yaw_deg: Option<f64>,
    pub pitch_deg: Option<f64>,
    pub roll_deg: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Narration {
    pub speaker: String,
    pub language: String,
    pub text: String,
    pub delivery: String,
    pub pronunciation: Option<String>,
    pub audio_asset: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Beat {
    pub range: Range,
    pub action: String,
    pub camera: Option<Camera>,
    pub narration: Option<Narration>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Direction {
    pub action: String,
    pub camera: Option<Camera>,
    pub lighting: Option<String>,
    pub location: Option<String>,
    #[serde(default)]
    pub cast: Vec<String>,
    #[serde(default)]
    pub beats: Vec<Beat>,
    #[serde(default)]
    pub references: Vec<Reference>,
    pub prompt: String,
    #[serde(default)]
    pub mentions: Vec<Mention>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mention {
    pub start: usize,
    pub end: usize,
    pub entity: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Model {
    pub provider: String,
    pub name: String,
    pub version: Option<String>,
    #[serde(default)]
    pub parameters: Map<Value>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    Recorded,
    Generated,
    Synthetic,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Take {
    pub microphone: Option<AudioCapture>,
    pub asset: String,
    pub origin: Origin,
    pub camera: Option<Camera>,
    pub model: Option<Model>,
    pub recipe_revision: Option<String>,
    pub prompt_snapshot: Option<String>,
    pub direction_snapshot: Option<Direction>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Shot {
    pub universe: Option<String>,
    pub title: String,
    pub cut: Option<Cut>,
    pub planned_duration: Option<producer_production_contract::Time>,
    pub direction: Direction,
    pub intended_model: Option<Model>,
    pub takes: Map<Take>,
    pub selected_take: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Extension {
    pub required: bool,
    pub data: Value,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub formats: Vec<String>,
    pub max_video_width: u32,
    pub max_video_height: u32,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Lifecycle {
    Planned,
    Active,
    Completed,
    Cancelled,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Development,
    Preproduction,
    Production,
    Postproduction,
    Review,
    Delivery,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskState {
    Todo,
    InProgress,
    Blocked,
    Done,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workflow {
    pub state: Lifecycle,
    pub phase: Phase,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
    pub tasks: Map<Task>,
    pub review: Option<Review>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub title: String,
    pub phase: Phase,
    pub state: TaskState,
    pub required: bool,
    pub owner: Option<String>,
    pub shot: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Approved,
    ChangesRequested,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Review {
    pub actor: String,
    pub decision: Decision,
    pub work_sha256: String,
    pub note: String,
}

/// Provenance of a locally cloned Universe or entity in a specific signed production.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceOrigin {
    pub production: String,
    pub revision: String,
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Voice {
    pub provider: String,
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioCapture {
    pub make: Option<String>,
    pub model: Option<String>,
    pub polar_pattern: Option<String>,
    pub position: Option<String>,
    pub distance_m: Option<f64>,
    pub sample_rate_hz: Option<u32>,
    pub channels: Vec<String>,
}
