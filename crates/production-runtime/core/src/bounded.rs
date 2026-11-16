//! Bounded control/observer/renderer channels; never used to carry media pixels.
use crate::{compile::Sample, contract::*};
use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};
fn err(code: &str, m: &str) -> Error {
    Error::new(code, "channel", m)
}

pub struct Queue<T> {
    items: VecDeque<(T, usize)>,
    bytes: usize,
    pub stop_requested: bool,
}
impl<T> Default for Queue<T> {
    fn default() -> Self {
        Self {
            items: VecDeque::new(),
            bytes: 0,
            stop_requested: false,
        }
    }
}
impl<T> Queue<T> {
    pub fn admit(&mut self, item: T, bytes: usize) -> Result<()> {
        if self.items.len() >= 256 || bytes > 4 * 1024 * 1024 - self.bytes {
            return Err(err("QUEUE_FULL", "count/byte budget exhausted"));
        }
        self.bytes += bytes;
        self.items.push_back((item, bytes));
        Ok(())
    }
    pub fn pop(&mut self) -> Option<T> {
        self.items.pop_front().map(|(v, n)| {
            self.bytes -= n;
            v
        })
    }
    pub fn stop(&mut self) {
        self.stop_requested = true;
    }
    pub fn len(&self) -> usize {
        self.items.len()
    }
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub cursor: Counter,
    pub revision: Counter,
    pub digest: String,
    pub changed: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Message {
    Snapshot {
        cursor: Counter,
        revision: Counter,
        digest: String,
        index: u32,
        total: u32,
        bytes: Vec<u8>,
    },
    Delta {
        value: Delta,
    },
    ResnapshotRequired,
}
struct Observer {
    cursor: Counter,
    snapshot: Option<(Counter, Counter, String, usize)>,
    queued: VecDeque<Message>,
    bytes: usize,
}
#[derive(Default)]
pub struct Observers {
    clients: BTreeMap<String, Observer>,
    history: VecDeque<(Delta, usize)>,
    history_bytes: usize,
    cursor: Counter,
    snapshot: Vec<u8>,
    revision: Counter,
    digest: String,
}
impl Observers {
    /// Whitelisted metadata only: no document metadata, source props, auth or media.
    pub fn publish(&mut self, d: &Document, revision: Counter, changed: Vec<String>) -> Result<()> {
        if changed.len() > 256 || changed.iter().any(|s| s.len() > 256) {
            return Err(err("DELTA_LIMIT", "bounded operation paths required"));
        }
        let cursor = Counter(
            self.cursor
                .0
                .checked_add(1)
                .ok_or_else(|| err("CURSOR_EXHAUSTED", "new observer lineage required"))?,
        );
        let digest = digest(d)?;
        let snapshot=serde_json::to_vec(&serde_json::json!({"documentId":d.id,"revision":revision,"digest":digest,"sets":d.sets.keys().collect::<Vec<_>>(),"shows":d.shows.keys().collect::<Vec<_>>(),"sourceCount":d.sources.len()})).unwrap();
        if snapshot.len() > DOCUMENT_BYTES {
            return Err(err("SNAPSHOT_LIMIT", "redacted snapshot too large"));
        }
        let delta = Delta {
            cursor,
            revision,
            digest: digest.clone(),
            changed,
        };
        let bytes = serde_json::to_vec(&delta).unwrap().len();
        self.history.push_back((delta, bytes));
        self.history_bytes += bytes;
        while self.history.len() > 128 || self.history_bytes > 1024 * 1024 {
            self.history_bytes -= self.history.pop_front().unwrap().1;
        }
        self.cursor = cursor;
        self.snapshot = snapshot;
        self.revision = revision;
        self.digest = digest;
        Ok(())
    }
    pub fn connect(&mut self) -> Result<String> {
        if self.snapshot.is_empty() {
            return Err(err(
                "SNAPSHOT_REQUIRED",
                "publish an authorized projection first",
            ));
        }
        if self.clients.len() >= 8 {
            return Err(err("OBSERVER_LIMIT", "eight observers maximum"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.clients.insert(
            id.clone(),
            Observer {
                cursor: Counter(0),
                snapshot: None,
                queued: VecDeque::new(),
                bytes: 0,
            },
        );
        self.begin_snapshot(&id)?;
        Ok(id)
    }
    pub fn begin_snapshot(&mut self, id: &str) -> Result<()> {
        let o = self
            .clients
            .get_mut(id)
            .ok_or_else(|| err("AUTH_REQUIRED", "observer session missing"))?;
        o.queued.clear();
        o.bytes = 0;
        o.snapshot = Some((self.cursor, self.revision, self.digest.clone(), 0));
        Ok(())
    }
    pub fn poll(&mut self, id: &str) -> Result<Option<Message>> {
        let o = self
            .clients
            .get_mut(id)
            .ok_or_else(|| err("AUTH_REQUIRED", "observer session missing"))?;
        if let Some((cursor, revision, digest, offset)) = &mut o.snapshot {
            if *cursor != self.cursor {
                o.snapshot = None;
                return Ok(Some(Message::ResnapshotRequired));
            }
            let total = self.snapshot.len().max(1).div_ceil(64 * 1024) as u32;
            let index = (*offset / (64 * 1024)) as u32;
            if index >= total {
                return Ok(None);
            }
            let end = (*offset + 64 * 1024).min(self.snapshot.len());
            let bytes = self.snapshot[*offset..end].to_vec();
            *offset = end.max(*offset + 1);
            return Ok(Some(Message::Snapshot {
                cursor: *cursor,
                revision: *revision,
                digest: digest.clone(),
                index,
                total,
                bytes,
            }));
        }
        let next = o
            .cursor
            .0
            .checked_add(1)
            .ok_or_else(|| err("CURSOR_EXHAUSTED", "new observer lineage required"))?;
        if o.cursor < self.cursor {
            if let Some((d, n)) = self.history.iter().find(|(d, _)| d.cursor.0 == next) {
                if o.queued.len() >= 64 || o.bytes + n > 512 * 1024 {
                    o.queued.clear();
                    o.bytes = 0;
                    return Ok(Some(Message::ResnapshotRequired));
                }
                o.queued.push_back(Message::Delta { value: d.clone() });
                o.bytes += n;
                o.cursor = d.cursor;
            } else {
                return Ok(Some(Message::ResnapshotRequired));
            }
        }
        let m = o.queued.pop_front();
        o.bytes = 0;
        Ok(m)
    }
    pub fn snapshot_complete(&mut self, id: &str, cursor: Counter, digest: &str) -> Result<()> {
        let o = self
            .clients
            .get_mut(id)
            .ok_or_else(|| err("AUTH_REQUIRED", "observer session missing"))?;
        let Some((c, _, d, offset)) = &o.snapshot else {
            return Err(err("SNAPSHOT_REQUIRED", "no transfer active"));
        };
        if *c != cursor || d != digest || *offset < self.snapshot.len() || cursor != self.cursor {
            return Err(err("SNAPSHOT_GAP", "restart snapshot"));
        }
        o.cursor = cursor;
        o.snapshot = None;
        Ok(())
    }
    pub fn disconnect(&mut self, id: &str) {
        self.clients.remove(id);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPacket {
    pub context: Counter,
    pub generation: Counter,
    pub sequence: Counter,
    pub time: Time,
    pub full: bool,
    pub values: Vec<Sample>,
}
#[derive(Clone)]
pub struct ParameterManifest {
    targets: BTreeMap<usize, Property>,
}
impl ParameterManifest {
    pub fn new(targets: BTreeMap<usize, Property>) -> Result<Self> {
        if targets.is_empty()
            || targets.len() > 256
            || targets.keys().any(|n| *n > u32::MAX as usize)
        {
            return Err(err(
                "RENDER_TARGET_LIMIT",
                "manifest requires 1..256 u32 handles",
            ));
        }
        Ok(Self { targets })
    }
    fn validate(&self, values: &[Sample], full: bool) -> Result<()> {
        if values.len() > 256 {
            return Err(err("RENDER_TARGET_LIMIT", "maximum 256 parameter values"));
        }
        let mut seen = std::collections::BTreeSet::new();
        for s in values {
            let property = self
                .targets
                .get(&s.target)
                .ok_or_else(|| err("RENDER_UNKNOWN_TARGET", "target not declared in manifest"))?;
            if !seen.insert(s.target) {
                return Err(err("RENDER_DUPLICATE_TARGET", "duplicate parameter write"));
            }
            let value = match s.value {
                crate::compile::CompactValue::Number(x) => Value::Number(x),
                crate::compile::CompactValue::Vec3(x) => Value::Vec3(x),
                crate::compile::CompactValue::Bool(x) => Value::Bool(x),
                crate::compile::CompactValue::Color(_) => Value::Color("#000000".into()),
            };
            if !validate::property_valid(*property, &value) {
                return Err(err("RENDER_PARAMETER_TYPE", "invalid parameter type/range"));
            }
        }
        if full && seen.len() != self.targets.len() {
            return Err(err(
                "RENDER_SNAPSHOT_REQUIRED",
                "full state must contain the complete manifest",
            ));
        }
        Ok(())
    }
}
pub struct RendererChannel {
    manifest: ParameterManifest,
    context: Counter,
    generation: Counter,
    next: u64,
    acked: u64,
    pending: VecDeque<(RenderPacket, usize)>,
    need_full: bool,
    window: u64,
    bytes: usize,
    pub dropped: u64,
}
impl RendererChannel {
    pub fn new(context: Counter, generation: Counter, manifest: ParameterManifest) -> Self {
        Self {
            manifest,
            context,
            generation,
            next: 0,
            acked: 0,
            pending: VecDeque::new(),
            need_full: true,
            window: 0,
            bytes: 0,
            dropped: 0,
        }
    }
    pub fn publish(
        &mut self,
        time: Time,
        values: &[Sample],
        full: bool,
        now_ms: u64,
    ) -> Result<Counter> {
        self.manifest.validate(values, full)?;
        if values.iter().any(|s| match s.value {
            crate::compile::CompactValue::Number(x) => !x.is_finite(),
            crate::compile::CompactValue::Vec3(v) => v.iter().any(|x| !x.is_finite()),
            _ => false,
        }) {
            return Err(err(
                "NONFINITE_RENDER_VALUE",
                "finite compiled parameter values required",
            ));
        }
        if values.len() > 256 {
            return Err(err(
                "RENDER_TARGET_LIMIT",
                "256 analytic parameters; instanced geometry is a separate immutable manifest",
            ));
        }
        if self.need_full && !full {
            return Err(err(
                "RENDER_SNAPSHOT_REQUIRED",
                "partial state lost; supply full current state",
            ));
        }
        if self.pending.len() >= 2 {
            self.dropped += self.pending.len() as u64;
            self.pending.clear();
            self.need_full = true;
            if !full {
                return Err(err(
                    "RENDER_SNAPSHOT_REQUIRED",
                    "pending data coalesced; full resnapshot required",
                ));
            }
        }
        if now_ms < self.window {
            return Err(err("CLOCK_REVERSED", "monotonic bandwidth clock required"));
        }
        if now_ms - self.window >= 1000 {
            self.window = now_ms;
            self.bytes = 0;
        }
        let sequence = Counter(
            self.next
                .checked_add(1)
                .ok_or_else(|| err("GENERATION_EXHAUSTED", "new renderer channel required"))?,
        );
        let packet = RenderPacket {
            context: self.context,
            generation: self.generation,
            sequence,
            time,
            full,
            values: values.to_vec(),
        };
        let n = serde_json::to_vec(&packet).unwrap().len();
        if n > 256 * 1024 || n > 8 * 1024 * 1024 - self.bytes {
            return Err(err("RENDER_BANDWIDTH", "packet/rate budget exhausted"));
        }
        self.next = sequence.0;
        self.bytes += n;
        self.need_full = false;
        self.pending.push_back((packet, n));
        Ok(sequence)
    }
    pub fn front(&self) -> Option<&RenderPacket> {
        self.pending.front().map(|p| &p.0)
    }
    pub fn acknowledge(
        &mut self,
        context: Counter,
        generation: Counter,
        sequence: Counter,
    ) -> Result<()> {
        if context != self.context
            || generation != self.generation
            || sequence.0 <= self.acked
            || !self.pending.iter().any(|(p, _)| p.sequence == sequence)
        {
            return Err(err(
                "STALE_RENDER_ACK",
                "context/generation/sequence mismatch",
            ));
        }
        self.acked = sequence.0;
        while self
            .pending
            .front()
            .is_some_and(|(p, _)| p.sequence <= sequence)
        {
            self.pending.pop_front();
        }
        Ok(())
    }
}

/// Fake receiver proves gap handling, rather than assuming a transmitted delta
/// arrived. A full packet can jump sequence; a partial packet cannot.
pub struct RendererReceiver {
    manifest: ParameterManifest,
    context: Counter,
    generation: Counter,
    last: Counter,
    pub values: BTreeMap<usize, crate::compile::CompactValue>,
    pub time: Time,
}
impl RendererReceiver {
    pub fn new(context: Counter, generation: Counter, manifest: ParameterManifest) -> Self {
        Self {
            manifest,
            context,
            generation,
            last: Counter(0),
            values: BTreeMap::new(),
            time: Time::ZERO,
        }
    }
    pub fn receive(&mut self, p: &RenderPacket) -> Result<()> {
        self.manifest.validate(&p.values, p.full)?;
        if p.context != self.context || p.generation != self.generation || p.sequence <= self.last {
            return Err(err(
                "STALE_RENDER_PACKET",
                "context/generation/sequence mismatch",
            ));
        }
        if (!p.full
            && (self.last.0 == 0
                || p.sequence.0
                    != self
                        .last
                        .0
                        .checked_add(1)
                        .ok_or_else(|| err("GENERATION_EXHAUSTED", "restart channel"))?))
            || p.values.len() > 256
        {
            return Err(err(
                "RENDER_SNAPSHOT_REQUIRED",
                "missing base or sequence gap",
            ));
        }
        if p.full {
            self.values.clear();
        }
        for sample in &p.values {
            self.values.insert(sample.target, sample.value);
        }
        self.time = p.time;
        self.last = p.sequence;
        Ok(())
    }
}
