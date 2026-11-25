//! Bounded off-callback wire scratch. Owned by the document writer, never global
//! or thread-local. Retained capacity drops with its owner. JSON/JCS identities
//! match the previous serde_json::Value path, without copying the value tree.
use crate::{Error, Result};
use serde::{
    de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor},
    Serialize,
};
use serde_json::{
    ser::{CompactFormatter, Formatter},
    value::RawValue,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fmt,
    io::{self, Write},
};

pub const SCRATCH_BYTES: usize = 48 * 1024 * 1024;
#[derive(Default)]
pub struct Scratch {
    bytes: Vec<u8>,
}
struct Limited<'a> {
    bytes: &'a mut Vec<u8>,
    limit: usize,
    exceeded: bool,
}
impl Write for Limited<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let needed = match self
            .bytes
            .len()
            .checked_add(data.len())
            .filter(|n| *n <= self.limit)
        {
            Some(n) => n,
            None => {
                self.exceeded = true;
                return Err(io::Error::other("wire byte limit exceeded"));
            }
        };
        if needed > self.bytes.capacity() {
            // Double only small buffers. Above 1MiB, grow in 1MiB blocks so a
            // checkpoint crossing 8MiB by a receipt does not retain 16MiB.
            let target = if needed <= 1024 * 1024 {
                needed.max(self.bytes.capacity().saturating_mul(2))
            } else {
                needed.div_ceil(1024 * 1024) * 1024 * 1024
            }
            .min(self.limit);
            self.bytes
                .try_reserve_exact(target - self.bytes.len())
                .map_err(io::Error::other)?;
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Scratch {
    pub fn capacity(&self) -> usize {
        self.bytes.capacity()
    }
    fn headroom(&mut self, limit: usize) -> Result<()> {
        if self.bytes.len() > 1024 * 1024 && self.bytes.capacity() - self.bytes.len() < 64 * 1024 {
            let target = (self.bytes.len() + 64 * 1024).div_ceil(1024 * 1024) * 1024 * 1024;
            let target = target.min(limit);
            if target > self.bytes.capacity() {
                self.bytes
                    .try_reserve_exact(target - self.bytes.len())
                    .map_err(|e| Error::new("SERIALIZE", "$", e.to_string()))?;
            }
        }
        Ok(())
    }
    pub fn serialize<T: ?Sized + Serialize>(&mut self, value: &T, limit: usize) -> Result<&[u8]> {
        if limit > SCRATCH_BYTES {
            return Err(Error::new("RAW_LIMIT", "$", "wire scratch limit exceeded"));
        }
        self.bytes.clear();
        let mut out = Limited {
            bytes: &mut self.bytes,
            limit,
            exceeded: false,
        };
        let result = serde_json::to_writer(&mut out, value);
        result.map_err(|e| serialization_error(e, out.exceeded))?;
        self.headroom(limit)?;
        Ok(&self.bytes)
    }
    pub fn digest<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<String> {
        self.bytes.clear();
        let out = Limited {
            bytes: &mut self.bytes,
            limit: SCRATCH_BYTES,
            exceeded: false,
        };
        let mut serializer = serde_json::Serializer::with_formatter(out, ValueNumbers::default());
        let result = value.serialize(&mut serializer);
        let exceeded = serializer.into_inner().exceeded;
        result.map_err(|e| serialization_error(e, exceeded))?;
        self.headroom(SCRATCH_BYTES)?;
        let mut sink = HashSink(Sha256::new());
        sink.0.update(b"producer.production/1\0");
        canonical_bytes_to(&self.bytes, &mut sink)?;
        Ok(format!("{:x}", sink.0.finalize()))
    }
}
fn serialization_error(e: impl fmt::Display, exceeded: bool) -> Error {
    if exceeded {
        Error::new("RAW_LIMIT", "$", "input byte limit exceeded")
    } else {
        Error::new("SERIALIZE", "$", e.to_string())
    }
}
// serde_json::to_value widens f32 to f64, while to_writer normally prints the
// shorter f32 spelling. Keys keep their original string spelling. Oversized
// i128/u128 fail just as to_value did (arbitrary_precision remains disabled).
#[derive(Default)]
struct ValueNumbers {
    in_string: bool,
}
impl Formatter for ValueNumbers {
    fn begin_string<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.in_string = true;
        CompactFormatter.begin_string(w)
    }
    fn end_string<W: ?Sized + Write>(&mut self, w: &mut W) -> io::Result<()> {
        self.in_string = false;
        CompactFormatter.end_string(w)
    }
    fn write_f32<W: ?Sized + Write>(&mut self, w: &mut W, v: f32) -> io::Result<()> {
        if self.in_string {
            CompactFormatter.write_f32(w, v)
        } else {
            CompactFormatter.write_f64(w, v as f64)
        }
    }
    fn write_i128<W: ?Sized + Write>(&mut self, w: &mut W, v: i128) -> io::Result<()> {
        if !self.in_string && (v < i64::MIN as i128 || v > u64::MAX as i128) {
            return Err(io::Error::other("number out of range"));
        }
        CompactFormatter.write_i128(w, v)
    }
    fn write_u128<W: ?Sized + Write>(&mut self, w: &mut W, v: u128) -> io::Result<()> {
        if !self.in_string && v > u64::MAX as u128 {
            return Err(io::Error::other("number out of range"));
        }
        CompactFormatter.write_u128(w, v)
    }
}
struct HashSink(Sha256);
impl Write for HashSink {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.update(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
/// Canonicalize serializer-owned JSON. This is not an ingress validator: raw
/// ingress still checks duplicates, depth/work, strings and unsafe numbers.
/// Object values borrow raw slices; arrays stream, without a Value allocation.
pub fn canonical_bytes_to(bytes: &[u8], out: &mut dyn Write) -> Result<()> {
    let mut d = serde_json::Deserializer::from_slice(bytes);
    Canon(out)
        .deserialize(&mut d)
        .map_err(|e| Error::new("JCS_JSON", "$", e.to_string()))?;
    d.end()
        .map_err(|e| Error::new("JCS_JSON", "$", e.to_string()))
}
struct Canon<'a>(&'a mut dyn Write);
impl<'de> DeserializeSeed<'de> for Canon<'_> {
    type Value = ();
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> std::result::Result<(), D::Error> {
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Canon<'_> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("serializer-owned JSON")
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<(), E> {
        self.0.write_all(b"null").map_err(E::custom)
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<(), E> {
        self.0
            .write_all(if v { b"true" } else { b"false" })
            .map_err(E::custom)
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<(), E> {
        self.visit_f64(v as f64)
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<(), E> {
        self.visit_f64(v as f64)
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<(), E> {
        if !v.is_finite() {
            return Err(E::custom("finite binary64 required"));
        }
        self.0
            .write_all(
                ryu_js::Buffer::new()
                    .format_finite(if v == 0.0 { 0.0 } else { v })
                    .as_bytes(),
            )
            .map_err(E::custom)
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<(), E> {
        serde_json::to_writer(self.0, v).map_err(E::custom)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<(), A::Error> {
        self.0.write_all(b"[").map_err(de::Error::custom)?;
        let mut first = true;
        while let Some(raw) = a.next_element::<&'de RawValue>()? {
            if !first {
                self.0.write_all(b",").map_err(de::Error::custom)?;
            }
            first = false;
            canonical_bytes_to(raw.get().as_bytes(), self.0).map_err(de::Error::custom)?;
        }
        self.0.write_all(b"]").map_err(de::Error::custom)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> std::result::Result<(), A::Error> {
        // Last-wins duplicates match serde_json::to_value for custom serializers.
        // Native byte admission independently rejects duplicates before use.
        let mut fields = BTreeMap::<String, &'de RawValue>::new();
        while let Some(k) = a.next_key::<String>()? {
            fields.insert(k, a.next_value()?);
        }
        let mut fields: Vec<_> = fields.into_iter().collect();
        fields.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
        self.0.write_all(b"{").map_err(de::Error::custom)?;
        for (n, (key, raw)) in fields.iter().enumerate() {
            if n != 0 {
                self.0.write_all(b",").map_err(de::Error::custom)?;
            }
            serde_json::to_writer(&mut *self.0, key).map_err(de::Error::custom)?;
            self.0.write_all(b":").map_err(de::Error::custom)?;
            canonical_bytes_to(raw.get().as_bytes(), self.0).map_err(de::Error::custom)?;
        }
        self.0.write_all(b"}").map_err(de::Error::custom)
    }
}
