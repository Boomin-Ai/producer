//! Bounded raw ingestion and RFC 8785 byte encoding are separate from schema.
use crate::{Error, Result, RAW_DEPTH, RAW_VALUES, SAFE_INTEGER, STRING_BYTES};
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::{cell::Cell, collections::HashSet, fmt};

pub fn parse(bytes: &[u8], limit: usize) -> Result<Value> {
    parse_depth(bytes, limit, RAW_DEPTH)
}
/// Bounded transport/store envelope; the embedded authored document still
/// passes its own depth-32 ingress before it can be admitted.
pub fn parse_envelope(bytes: &[u8], limit: usize) -> Result<Value> {
    parse_depth(bytes, limit, RAW_DEPTH + 8)
}
fn parse_depth(bytes: &[u8], limit: usize, depth: usize) -> Result<Value> {
    if bytes.len() > limit {
        return Err(Error::new("RAW_LIMIT", "$", "input byte limit exceeded"));
    }
    std::str::from_utf8(bytes).map_err(|_| Error::new("RAW_UTF8", "$", "invalid UTF-8"))?;
    let mut d = serde_json::Deserializer::from_slice(bytes);
    let fuel = Cell::new(RAW_VALUES);
    let v = Seed(0, depth, &fuel)
        .deserialize(&mut d)
        .map_err(|e| Error::new("RAW_JSON", "$", e.to_string()))?;
    d.end()
        .map_err(|e| Error::new("RAW_JSON", "$", e.to_string()))?;
    Ok(v)
}
struct Seed<'a>(usize, usize, &'a Cell<usize>);
impl<'de> DeserializeSeed<'de> for Seed<'_> {
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
impl<'de> Visitor<'de> for Seed<'_> {
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
        Ok(Value::String(v.into()))
    }
    fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Value, E> {
        if v.len() > STRING_BYTES {
            return Err(E::custom("UTF-8 string byte limit exceeded"));
        }
        Ok(Value::String(v))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut out = Vec::new();
        while let Some(v) = a.next_element_seed(Seed(self.0 + 1, self.1, self.2))? {
            out.push(v);
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
            out.insert(key, a.next_value_seed(Seed(self.0 + 1, self.1, self.2))?);
        }
        Ok(Value::Object(out))
    }
}
pub fn canonical(value: &Value) -> Result<Vec<u8>> {
    fn write(v: &Value, out: &mut Vec<u8>) -> Result<()> {
        match v {
            Value::Null => out.extend_from_slice(b"null"),
            Value::Bool(b) => out.extend_from_slice(if *b { b"true" } else { b"false" }),
            Value::Number(n) => {
                let f = n
                    .as_f64()
                    .ok_or_else(|| Error::new("JCS_NUMBER", "$", "binary64 required"))?;
                if !f.is_finite() {
                    return Err(Error::new("JCS_NUMBER", "$", "finite binary64 required"));
                }
                out.extend_from_slice(
                    ryu_js::Buffer::new()
                        .format_finite(if f == 0.0 { 0.0 } else { f })
                        .as_bytes(),
                );
            }
            Value::String(s) => out.extend_from_slice(serde_json::to_string(s).unwrap().as_bytes()),
            Value::Array(a) => {
                out.push(b'[');
                for (i, v) in a.iter().enumerate() {
                    if i != 0 {
                        out.push(b',');
                    }
                    write(v, out)?;
                }
                out.push(b']');
            }
            Value::Object(m) => {
                let mut keys: Vec<_> = m.keys().collect();
                keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                out.push(b'{');
                for (i, k) in keys.iter().enumerate() {
                    if i != 0 {
                        out.push(b',');
                    }
                    write(&Value::String((*k).clone()), out)?;
                    out.push(b':');
                    write(&m[*k], out)?;
                }
                out.push(b'}');
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    write(value, &mut out)?;
    Ok(out)
}
