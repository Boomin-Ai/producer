//! Experimental production document contract. No app, device or renderer linkage.
pub mod fixture;
pub mod geometry;
pub mod ingress;
pub mod layout;
pub mod model;
mod shared;
pub use shared::SharedMap;
pub mod temporal;
pub mod time;
pub mod validate;
pub mod wire;

pub use model::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::fmt;
pub use time::{Range, Speed, Time};
pub use validate::{validate_document, Inventory};

pub const DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
pub const STRING_BYTES: usize = 64 * 1024;
pub const RAW_DEPTH: usize = 32;
pub const RAW_VALUES: usize = 1_048_576;
pub const SPATIAL_DEPTH: usize = 32;
pub const TEMPORAL_DEPTH: usize = 16;
pub const TEMPORAL_WORK: usize = 16_384;
pub const TEMPORAL_INSTANCES: usize = 4096;
pub const NODES: usize = 4096;
pub const TRACKS: usize = 512;
pub const KEYS: usize = 256;
pub const COMMAND_BYTES: usize = 256 * 1024;
pub const OPERATIONS: usize = 64;
pub const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Error {
    pub code: String,
    pub path: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            path: path.into(),
            message: message.into(),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at {}: {}", self.code, self.path, self.message)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;

/// Exact counters never travel as JavaScript numbers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Counter(pub u64);
impl Serialize for Counter {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for Counter {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        if s.is_empty()
            || s.len() > 20
            || (s.starts_with('0') && s.len() != 1)
            || !s.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(serde::de::Error::custom(
                "canonical decimal u64 string required",
            ));
        }
        s.parse().map(Self).map_err(serde::de::Error::custom)
    }
}
impl JsonSchema for Counter {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Counter".into()
    }
    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        serde_json::json!({"type":"string","pattern":"^(0|[1-9][0-9]{0,19})$","x-nativeRange":"u64"}).try_into().unwrap()
    }
}

pub fn parse_document(bytes: &[u8]) -> Result<Document> {
    let raw = ingress::parse(bytes, DOCUMENT_BYTES)?;
    let document: Document =
        serde_json::from_value(raw).map_err(|e| Error::new("STRUCTURE", "$", e.to_string()))?;
    validate_document(&document)?;
    Ok(document)
}

pub fn schema() -> serde_json::Value {
    serde_json::to_value(schemars::schema_for!(Document)).unwrap()
}

pub fn digest<T: Serialize>(value: &T) -> Result<String> {
    wire::Scratch::default().digest(value)
}
