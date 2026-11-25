//! Versioned reconstruction INPUTS, not a GPU renderer or stateful simulation.
//! Bind identity on the control lane; frame sampling is pure bounded arithmetic.
use crate::{compile::EvalError, contract::*};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticSourcePlan {
    pub document: String,
    pub source: String,
    pub reconstruction: AnalyticReconstruction,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyticClock {
    pub version: AnalyticVersion,
    pub seed: [u32; 4],
    pub period: Time,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EffectInputs {
    pub version: AnalyticVersion,
    pub seed: [u32; 4],
    pub time: Time,
    pub cycle: Counter,
    /// floor(fractional cycle * 2^32). Integer transport across GPU APIs avoids
    /// long-running f32 seconds; conversion to shader floats happens locally.
    pub phase_q32: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EffectPlan {
    pub path: String,
    pub source: String,
    pub clock: AnalyticClock,
    pub maps: Vec<temporal::TimeMap>,
}

fn part(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}
fn finish(hash: Sha256) -> [u32; 4] {
    let bytes = hash.finalize();
    std::array::from_fn(|i| u32::from_be_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap()))
}
impl AnalyticSourcePlan {
    /// Static Set adapters bind a stable expanded node path. Timeline compilation
    /// binds its expanded placement path. No run UUID or output time enters seed.
    pub fn bind(&self, path: &str) -> Result<AnalyticClock> {
        if self.reconstruction.scope == SeedScope::Placement && path.is_empty() {
            return Err(Error::new(
                "ANALYTIC_DOMAIN",
                "reconstruction",
                "placement scope requires a stable path",
            ));
        }
        let mut h = Sha256::new();
        h.update(b"producer.analytic/1\0");
        part(&mut h, self.document.as_bytes());
        part(&mut h, self.source.as_bytes());
        h.update(self.reconstruction.seed.0.to_be_bytes());
        match self.reconstruction.scope {
            SeedScope::Source => h.update([0]),
            SeedScope::Placement => {
                h.update([1]);
                part(&mut h, path.as_bytes());
            }
        }
        Ok(AnalyticClock {
            version: self.reconstruction.version,
            seed: finish(h),
            period: self.reconstruction.period,
        })
    }
}
impl AnalyticClock {
    /// Off-frame, optional stable batch/material identity. Reordering authored
    /// batches does not reshuffle their random attributes when IDs are retained.
    pub fn substream(self, id: &str) -> Self {
        let mut h = Sha256::new();
        h.update(b"producer.analytic/1/substream\0");
        for word in self.seed {
            h.update(word.to_be_bytes());
        }
        part(&mut h, id.as_bytes());
        Self {
            seed: finish(h),
            ..self
        }
    }
    pub fn sample(self, time: Time) -> std::result::Result<EffectInputs, EvalError> {
        if time < Time::ZERO
            || self.period < Time::new(1, 1000).unwrap()
            || self.period > Time::seconds(86_400)
        {
            return Err(EvalError::TimeRange);
        }
        // With validated periods <= 86400 s, even the maximum Time numerator,
        // rate and the Q32 multiplication fit in u128. Check anyway: fail closed.
        let n = time.ticks() as u128 * self.period.rate() as u128;
        let d = time.rate() as u128 * self.period.ticks() as u128;
        let cycle = u64::try_from(n / d).map_err(|_| EvalError::TimeRange)?;
        let phase = (n % d)
            .checked_mul(1u128 << 32)
            .ok_or(EvalError::TimeRange)?
            / d;
        Ok(EffectInputs {
            version: self.version,
            seed: self.seed,
            time,
            cycle: Counter(cycle),
            phase_q32: phase as u32,
        })
    }
}
// Murmur3's finalizer, with explicitly wrapping u32 operations. Version 1 fixes
// this exact algorithm; it is deterministic noise, not cryptographic randomness.
fn mix(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x85eb_ca6b);
    x ^= x >> 13;
    x = x.wrapping_mul(0xc2b2_ae35);
    x ^ (x >> 16)
}
impl EffectInputs {
    /// Stable per-instance/channel noise. Time is deliberately not an input:
    /// animated kernels use phase/cycle explicitly, without advancing a PRNG.
    pub fn random_word(self, stream: u32, instance: u32, channel: u32) -> u32 {
        // Ordered mixing separates counter roles even when seed words coincide.
        let a = mix(self.seed[0] ^ stream);
        let b = mix(a ^ self.seed[1] ^ instance);
        let c = mix(b ^ self.seed[2] ^ channel);
        mix(c ^ self.seed[3])
    }
}
impl EffectPlan {
    pub fn sample(&self, root: Time) -> std::result::Result<Option<EffectInputs>, EvalError> {
        temporal::map_chain(&self.maps, root)
            .map_err(|_| EvalError::TimeRange)?
            .map(|local| self.clock.sample(local))
            .transpose()
    }
}
pub(crate) fn sources(d: &Document) -> BTreeMap<String, AnalyticSourcePlan> {
    d.sources
        .iter()
        .filter_map(|(id, source)| match source {
            Source::Graphics { scene } => scene.reconstruction.map(|reconstruction| {
                (
                    id.clone(),
                    AnalyticSourcePlan {
                        document: d.id.clone(),
                        source: id.clone(),
                        reconstruction,
                    },
                )
            }),
            _ => None,
        })
        .collect()
}
