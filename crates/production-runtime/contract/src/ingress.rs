//! Bounded raw ingestion and RFC 8785 byte encoding are separate from schema.
use crate::{Error, Result, RAW_DEPTH, RAW_VALUES, SAFE_INTEGER, STRING_BYTES};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::{cell::Cell, collections::HashSet, fmt};

pub fn parse(bytes: &[u8], limit: usize) -> Result<Value> {
    parse_depth::<true>(bytes, limit, RAW_DEPTH, RAW_VALUES)
}
/// Bounded transport/store envelope; the embedded authored document still
/// passes its own depth-32 ingress before it can be admitted.
pub fn parse_envelope(bytes: &[u8], limit: usize) -> Result<Value> {
    // One maximum-work document plus up to 4096 bounded receipt records and
    // transport/store framing. Embedded documents still pass RAW_VALUES alone.
    parse_depth::<true>(bytes, limit, RAW_DEPTH + 8, RAW_VALUES + 65_536)
}
/// Check the same raw profile without retaining a second JSON tree. Keys are
/// still tracked per object to reject duplicate decoded names in discard mode.
pub fn check(bytes: &[u8], limit: usize) -> Result<()> {
    parse_depth::<false>(bytes, limit, RAW_DEPTH, RAW_VALUES).map(|_| ())
}
pub fn check_envelope(bytes: &[u8], limit: usize) -> Result<()> {
    parse_depth::<false>(bytes, limit, RAW_DEPTH + 8, RAW_VALUES + 65_536).map(|_| ())
}
// RawValue's serde_json feature recognizes a private sentinel key when using
// Value::deserialize. Metadata is ordinary authored JSON: preserve that key and
// its string value literally rather than interpreting it as another document.
// The full raw profile is still checked before structural document decoding.
pub(crate) fn metadata<'de, D: de::Deserializer<'de>>(
    d: D,
) -> std::result::Result<crate::SharedMap<Value>, D::Error> {
    let fuel = Cell::new(RAW_VALUES);
    match Seed::<true>(0, RAW_DEPTH, &fuel).deserialize(d)? {
        Value::Object(values) => Ok(values.into_iter().collect()),
        _ => Err(de::Error::custom("metadata object required")),
    }
}
fn parse_depth<const KEEP: bool>(
    bytes: &[u8],
    limit: usize,
    depth: usize,
    values: usize,
) -> Result<Value> {
    if bytes.len() > limit {
        return Err(Error::new("RAW_LIMIT", "$", "input byte limit exceeded"));
    }
    std::str::from_utf8(bytes).map_err(|_| Error::new("RAW_UTF8", "$", "invalid UTF-8"))?;
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let fuel = Cell::new(values);
    let v = Seed::<KEEP>(0, depth, &fuel)
        .deserialize(&mut d)
        .map_err(|e| Error::new("RAW_JSON", "$", e.to_string()))?;
    d.end()
        .map_err(|e| Error::new("RAW_JSON", "$", e.to_string()))?;
    Ok(v)
}
struct Seed<'a, const KEEP: bool>(usize, usize, &'a Cell<usize>);
impl<'de, const KEEP: bool> DeserializeSeed<'de> for Seed<'_, KEEP> {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> std::result::Result<Value, D::Error> {
        if self.0 > self.1 {
            return Err(de::Error::custom("nesting limit exceeded"));
        }
        let left = self.2.get();
        if left == 0 {
            return Err(de::Error::custom("JSON value work limit exceeded"));
        }
        self.2.set(left - 1);
        d.deserialize_any(self)
    }
}
impl<'de, const KEEP: bool> Visitor<'de> for Seed<'_, KEEP> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Value, E> {
        if v.unsigned_abs() > SAFE_INTEGER as u64 {
            return Err(E::custom("exact large numbers must be decimal strings"));
        }
        Ok(Value::Number(v.into()))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Value, E> {
        if v > SAFE_INTEGER as u64 {
            return Err(E::custom("exact large numbers must be decimal strings"));
        }
        Ok(Value::Number(v.into()))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Value, E> {
        if !v.is_finite() || (v.fract() == 0.0 && v.abs() > SAFE_INTEGER) {
            return Err(E::custom(
                "number outside finite binary64/safe integer profile",
            ));
        }
        Ok(Value::Number(
            Number::from_f64(if v == 0.0 { 0.0 } else { v })
                .ok_or_else(|| E::custom("nonfinite number"))?,
        ))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        if v.len() > STRING_BYTES {
            return Err(E::custom("UTF-8 string byte limit exceeded"));
        }
        Ok(if KEEP {
            Value::String(v.into())
        } else {
            Value::Null
        })
    }
    fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Value, E> {
        if v.len() > STRING_BYTES {
            return Err(E::custom("UTF-8 string byte limit exceeded"));
        }
        Ok(if KEEP { Value::String(v) } else { Value::Null })
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut out = Vec::new();
        while let Some(v) = a.next_element_seed(Seed::<KEEP>(self.0 + 1, self.1, self.2))? {
            if KEEP {
                out.push(v);
            }
        }
        Ok(Value::Array(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut seen = HashSet::new();
        let mut out = Map::new();
        while let Some(key) = a.next_key::<String>()? {
            if key.len() > STRING_BYTES
                || ["__proto__", "constructor", "prototype"].contains(&key.as_str())
            {
                return Err(de::Error::custom("unsafe or over-limit key"));
            }
            if !seen.insert(key.clone()) {
                return Err(de::Error::custom("duplicate object key"));
            }
            let value = a.next_value_seed(Seed::<KEEP>(self.0 + 1, self.1, self.2))?;
            if KEEP {
                out.insert(key, value);
            }
        }
        Ok(Value::Object(out))
    }
}
pub fn canonical(value: &Value) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    canonical_to(value, &mut out)?;
    Ok(out)
}
/// Same JCS bytes, streamed to an off-callback sink (including hashing) without
/// retaining the complete canonical payload or allocating escaped string copies.
pub fn canonical_to(value: &Value, out: &mut impl std::io::Write) -> Result<()> {
    fn io(e: impl fmt::Display) -> Error {
        Error::new("JCS_IO", "$", e.to_string())
    }
    fn bytes(out: &mut impl std::io::Write, b: &[u8]) -> Result<()> {
        out.write_all(b).map_err(io)
    }
    match value {
        Value::Null => bytes(out, b"null")?,
        Value::Bool(b) => bytes(out, if *b { b"true" } else { b"false" })?,
        Value::Number(n) => {
            let f = n
                .as_f64()
                .ok_or_else(|| Error::new("JCS_NUMBER", "$", "binary64 required"))?;
            if !f.is_finite() {
                return Err(Error::new("JCS_NUMBER", "$", "finite binary64 required"));
            }
            bytes(
                out,
                ryu_js::Buffer::new()
                    .format_finite(if f == 0.0 { 0.0 } else { f })
                    .as_bytes(),
            )?;
        }
        Value::String(s) => serde_json::to_writer(out, s).map_err(io)?,
        Value::Array(a) => {
            bytes(out, b"[")?;
            for (i, v) in a.iter().enumerate() {
                if i != 0 {
                    bytes(out, b",")?;
                }
                canonical_to(v, out)?;
            }
            bytes(out, b"]")?;
        }
        Value::Object(m) => {
            let mut keys: Vec<_> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            bytes(out, b"{")?;
            for (i, k) in keys.iter().enumerate() {
                if i != 0 {
                    bytes(out, b",")?;
                }
                serde_json::to_writer(&mut *out, *k).map_err(io)?;
                bytes(out, b":")?;
                canonical_to(&m[*k], out)?;
            }
            bytes(out, b"}")?;
        }
    }
    Ok(())
}
