//! Exact rational content/source time. Output time is a different core type.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct Time {
    ticks: i64,
    rate: u32,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct WireTime {
    #[schemars(regex(pattern = r"^(0|-?[1-9][0-9]{0,18})$"))]
    ticks: String,
    #[schemars(range(min = 1, max = 1_000_000_000))]
    rate: u32,
}
impl Serialize for Time {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        WireTime {
            ticks: self.ticks.to_string(),
            rate: self.rate,
        }
        .serialize(s)
    }
}
impl<'de> Deserialize<'de> for Time {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let w = WireTime::deserialize(d)?;
        let s = &w.ticks;
        let digits = s.strip_prefix('-').unwrap_or(s);
        if s == "-0"
            || digits.is_empty()
            || digits.len() > 19
            || (digits.starts_with('0') && digits.len() != 1)
            || !digits.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(serde::de::Error::custom(
                "canonical signed decimal i64 string required",
            ));
        }
        let ticks = s.parse::<i64>().map_err(serde::de::Error::custom)?;
        if w.rate == 0 || w.rate > 1_000_000_000 {
            return Err(serde::de::Error::custom("time rate outside profile"));
        }
        Self::new(ticks, w.rate).map_err(serde::de::Error::custom)
    }
}
impl JsonSchema for Time {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Time".into()
    }
    fn json_schema(g: &mut schemars::SchemaGenerator) -> schemars::Schema {
        WireTime::json_schema(g)
    }
}
fn gcd(mut a: u128, mut b: u128) -> u128 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}
fn bad() -> Error {
    Error::new(
        "TIME_UNREPRESENTABLE",
        "time",
        "exact rational outside supported profile",
    )
}
impl Time {
    pub const ZERO: Self = Self { ticks: 0, rate: 1 };
    pub fn new(ticks: i64, rate: u32) -> Result<Self> {
        Self::wide(ticks as i128, rate as i128)
    }
    pub fn seconds(ticks: i64) -> Self {
        Self { ticks, rate: 1 }
    }
    fn wide(t: i128, r: i128) -> Result<Self> {
        if r <= 0 {
            return Err(bad());
        }
        if t == 0 {
            return Ok(Self::ZERO);
        }
        let g = gcd(t.unsigned_abs(), r as u128) as i128;
        let (t, r) = (t / g, r / g);
        if r > 1_000_000_000 || t < i64::MIN as i128 || t > i64::MAX as i128 {
            return Err(bad());
        }
        Ok(Self {
            ticks: t as i64,
            rate: r as u32,
        })
    }
    pub fn ticks(self) -> i64 {
        self.ticks
    }
    pub fn rate(self) -> u32 {
        self.rate
    }
    pub fn as_f64(self) -> f64 {
        self.ticks as f64 / self.rate as f64
    }
    pub fn checked_add(self, b: Self) -> Result<Self> {
        Self::wide(
            self.ticks as i128 * b.rate as i128 + b.ticks as i128 * self.rate as i128,
            self.rate as i128 * b.rate as i128,
        )
    }
    pub fn checked_sub(self, b: Self) -> Result<Self> {
        Self::wide(
            self.ticks as i128 * b.rate as i128 - b.ticks as i128 * self.rate as i128,
            self.rate as i128 * b.rate as i128,
        )
    }
    pub fn scale(self, s: Speed) -> Result<Self> {
        s.validate()?;
        Self::wide(
            self.ticks as i128 * s.numerator as i128,
            self.rate as i128 * s.denominator as i128,
        )
    }
    pub fn times(self, n: u64) -> Result<Self> {
        Self::wide(
            (self.ticks as i128)
                .checked_mul(n as i128)
                .ok_or_else(bad)?,
            self.rate as i128,
        )
    }
    pub fn snap(self, rate: u32) -> Result<Self> {
        if rate == 0 || rate > 1_000_000_000 {
            return Err(bad());
        }
        let n = self.ticks as i128 * rate as i128;
        let d = self.rate as i128;
        let q = n.div_euclid(d);
        let rem = n.rem_euclid(d);
        let v = if rem * 2 > d || (rem * 2 == d && q % 2 != 0) {
            q + 1
        } else {
            q
        };
        Self::wide(v, rate as i128)
    }
    /// Exact modulo of an elapsed offset, never absolute file PTS.
    pub fn loop_offset(self, length: Self) -> Result<(Self, u64)> {
        if self < Self::ZERO || length <= Self::ZERO {
            return Err(bad());
        }
        let n = self.ticks as i128 * length.rate as i128;
        let d = self.rate as i128 * length.ticks as i128;
        let loops = n / d;
        let offset = Self::wide(n % d, self.rate as i128 * length.rate as i128)?;
        Ok((offset, u64::try_from(loops).map_err(|_| bad())?))
    }
}
impl PartialOrd for Time {
    fn partial_cmp(&self, b: &Self) -> Option<Ordering> {
        Some(self.cmp(b))
    }
}
impl Ord for Time {
    fn cmp(&self, b: &Self) -> Ordering {
        (self.ticks as i128 * b.rate as i128).cmp(&(b.ticks as i128 * self.rate as i128))
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Speed {
    pub numerator: u32,
    pub denominator: u32,
}
impl Default for Speed {
    fn default() -> Self {
        Self {
            numerator: 1,
            denominator: 1,
        }
    }
}
impl Speed {
    pub fn validate(self) -> Result<()> {
        if self.numerator == 0
            || self.denominator == 0
            || self.numerator > 1_000_000
            || self.denominator > 1_000_000
            || gcd(self.numerator as u128, self.denominator as u128) != 1
        {
            Err(bad())
        } else {
            Ok(())
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Range {
    pub start: Time,
    pub duration: Time,
}
impl Range {
    pub fn end(self) -> Result<Time> {
        if self.duration <= Time::ZERO {
            return Err(bad());
        }
        self.start.checked_add(self.duration)
    }
    pub fn contains(self, t: Time) -> Result<bool> {
        Ok(t >= self.start && t < self.end()?)
    }
    pub fn overlaps(self, b: Self) -> Result<bool> {
        Ok(self.start < b.end()? && b.start < self.end()?)
    }
    pub fn source_time(self, parent: Time, source_in: Time, speed: Speed) -> Result<Option<Time>> {
        speed.validate()?;
        if !self.contains(parent)? {
            return Ok(None);
        }
        Ok(Some(source_in.checked_add(
            parent.checked_sub(self.start)?.scale(speed)?,
        )?))
    }
}
