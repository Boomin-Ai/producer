//! Streaming serialized-shape accounting, without a second JSON tree. These dimensions
//! bound retained history complexity; they are not an allocator/RSS estimator.
use crate::contract::*;
use serde::{
    ser::{
        SerializeMap, SerializeSeq, SerializeStruct, SerializeStructVariant, SerializeTuple,
        SerializeTupleStruct, SerializeTupleVariant, Serializer,
    },
    Serialize,
};
use std::{fmt, io::Write};

#[derive(Debug, Default, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Weight {
    pub encoded_bytes: usize,
    /// JSON keys plus values/containers, unlike ingress fuel (values only).
    pub structural_units: usize,
}
struct Bytes(usize);
impl Write for Bytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .filter(|n| *n <= DOCUMENT_BYTES)
            .ok_or_else(|| std::io::Error::other("document retention byte limit"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
#[derive(Debug)]
struct Limit;
impl fmt::Display for Limit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("serialized history work limit")
    }
}
impl std::error::Error for Limit {}
impl serde::ser::Error for Limit {
    fn custom<T: fmt::Display>(_: T) -> Self {
        Self
    }
}
#[derive(Default)]
struct Units(usize);
impl Units {
    fn add(&mut self, n: usize) -> std::result::Result<(), Limit> {
        self.0 = self
            .0
            .checked_add(n)
            .filter(|n| *n <= RAW_VALUES * 2)
            .ok_or(Limit)?;
        Ok(())
    }
}
impl Serializer for &mut Units {
    type Ok = ();
    type Error = Limit;
    type SerializeSeq = Self;
    type SerializeTuple = Self;
    type SerializeTupleStruct = Self;
    type SerializeTupleVariant = Self;
    type SerializeMap = Self;
    type SerializeStruct = Self;
    type SerializeStructVariant = Self;
    fn serialize_bool(self, _: bool) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_i8(self, _: i8) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_i16(self, _: i16) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_i32(self, _: i32) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_i64(self, _: i64) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_u8(self, _: u8) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_u16(self, _: u16) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_u32(self, _: u32) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_u64(self, _: u64) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_f32(self, _: f32) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_f64(self, _: f64) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_char(self, _: char) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_str(self, _: &str) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_bytes(self, bytes: &[u8]) -> std::result::Result<(), Limit> {
        self.add(bytes.len().saturating_add(1))
    }
    fn serialize_none(self) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_some<T: ?Sized + Serialize>(self, v: &T) -> std::result::Result<(), Limit> {
        v.serialize(self)
    }
    fn serialize_unit(self) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_unit_struct(self, _: &'static str) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
    ) -> std::result::Result<(), Limit> {
        self.add(1)
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(
        self,
        _: &'static str,
        v: &T,
    ) -> std::result::Result<(), Limit> {
        v.serialize(self)
    }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        v: &T,
    ) -> std::result::Result<(), Limit> {
        self.add(2)?;
        v.serialize(self)
    }
    fn serialize_seq(self, _: Option<usize>) -> std::result::Result<Self, Limit> {
        self.add(1)?;
        Ok(self)
    }
    fn serialize_tuple(self, _: usize) -> std::result::Result<Self, Limit> {
        self.add(1)?;
        Ok(self)
    }
    fn serialize_tuple_struct(self, _: &'static str, _: usize) -> std::result::Result<Self, Limit> {
        self.add(1)?;
        Ok(self)
    }
    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> std::result::Result<Self, Limit> {
        self.add(3)?;
        Ok(self)
    }
    fn serialize_map(self, _: Option<usize>) -> std::result::Result<Self, Limit> {
        self.add(1)?;
        Ok(self)
    }
    fn serialize_struct(self, _: &'static str, _: usize) -> std::result::Result<Self, Limit> {
        self.add(1)?;
        Ok(self)
    }
    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> std::result::Result<Self, Limit> {
        self.add(3)?;
        Ok(self)
    }
}
macro_rules! sequence {
    ($trait:ident, $element:ident) => {
        impl $trait for &mut Units {
            type Ok = ();
            type Error = Limit;
            fn $element<T: ?Sized + Serialize>(&mut self, v: &T) -> std::result::Result<(), Limit> {
                v.serialize(&mut **self)
            }
            fn end(self) -> std::result::Result<(), Limit> {
                Ok(())
            }
        }
    };
}
sequence!(SerializeSeq, serialize_element);
sequence!(SerializeTuple, serialize_element);
sequence!(SerializeTupleStruct, serialize_field);
sequence!(SerializeTupleVariant, serialize_field);
impl SerializeMap for &mut Units {
    type Ok = ();
    type Error = Limit;
    fn serialize_key<T: ?Sized + Serialize>(&mut self, k: &T) -> std::result::Result<(), Limit> {
        k.serialize(&mut **self)
    }
    fn serialize_value<T: ?Sized + Serialize>(&mut self, v: &T) -> std::result::Result<(), Limit> {
        v.serialize(&mut **self)
    }
    fn end(self) -> std::result::Result<(), Limit> {
        Ok(())
    }
}
macro_rules! structure {
    ($trait:ident) => {
        impl $trait for &mut Units {
            type Ok = ();
            type Error = Limit;
            fn serialize_field<T: ?Sized + Serialize>(
                &mut self,
                _: &'static str,
                v: &T,
            ) -> std::result::Result<(), Limit> {
                self.add(1)?;
                v.serialize(&mut **self)
            }
            fn end(self) -> std::result::Result<(), Limit> {
                Ok(())
            }
        }
    };
}
structure!(SerializeStruct);
structure!(SerializeStructVariant);

pub fn measure(d: &Document) -> Result<Weight> {
    let error = || {
        Error::new(
            "RETENTION_LIMIT",
            "history",
            "document exceeds serialized retention profile",
        )
    };
    let mut bytes = Bytes(0);
    serde_json::to_writer(&mut bytes, d).map_err(|_| error())?;
    let mut units = Units::default();
    d.serialize(&mut units).map_err(|_| error())?;
    Ok(Weight {
        encoded_bytes: bytes.0,
        structural_units: units.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn independent(v: &serde_json::Value) -> usize {
        1 + match v {
            serde_json::Value::Array(a) => a.iter().map(independent).sum(),
            serde_json::Value::Object(m) => m.iter().map(|(_, v)| 1 + independent(v)).sum(),
            _ => 0,
        }
    }
    #[test]
    fn retained_shape_matches_independent_json_tree_for_all_fixtures() {
        for d in [
            fixture::classic_like(),
            fixture::nested_timeline(),
            fixture::responsive_layout(),
        ] {
            let value = serde_json::to_value(&d).unwrap();
            let weight = measure(&d).unwrap();
            assert_eq!(weight.encoded_bytes, serde_json::to_vec(&d).unwrap().len());
            assert_eq!(weight.structural_units, independent(&value));
        }
    }
}
