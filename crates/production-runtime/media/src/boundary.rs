//! Native integration boundaries. No UI, filesystem IO or codecs on callbacks.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// Every asynchronous result must match all owners, including after room reentry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MediaFence {
    pub execution: u64,
    pub epoch: u64,
    pub source_incarnation: u64,
    pub request: u64,
}
impl MediaFence {
    pub fn accepts(self, completion: Self) -> bool { self == completion }
    pub fn seek(&mut self) -> Result<()> {
        self.request = self.request.checked_add(1).ok_or(Error::Limit("request generation"))?;
        Ok(())
    }
    pub fn reopen(&mut self) -> Result<()> {
        let incarnation = self.source_incarnation.checked_add(1).ok_or(Error::Limit("source incarnation"))?;
        let epoch = self.epoch.checked_add(1).ok_or(Error::Limit("media epoch"))?;
        self.source_incarnation = incarnation; self.epoch = epoch; self.request = 0;
        Ok(())
    }
}

pub const AUDIO_RATE: u32 = 48_000;
pub const AUDIO_CHANNELS: usize = 2;
pub const BLOCK_FRAMES: usize = 480;
pub const BLOCK_SAMPLES: usize = BLOCK_FRAMES * AUDIO_CHANNELS;

#[derive(Clone)]
pub struct AudioBlock {
    pub fence: MediaFence,
    pub start: i64,
    pub frames: usize,
    pub samples: [f32; BLOCK_SAMPLES],
}
impl AudioBlock {
    pub fn silence(fence: MediaFence, start: i64) -> Self {
        Self { fence, start, frames: BLOCK_FRAMES, samples: [0.; BLOCK_SAMPLES] }
    }
}
struct Queue {
    blocks: Box<[AudioBlock]>,
    read: usize,
    len: usize,
    fence: MediaFence,
}
/// One bounded queue per source/consumer. A device callback never waits or allocates.
/// Recorder and monitor have distinct queues; draining one cannot steal the other's audio.
pub struct AudioQueue { queue: Mutex<Queue> }
/// Stable, allocation-free callback diagnostics. Capacity and mutex contention
/// deliberately remain distinct even though the legacy API maps both to Busy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioPushError { Contended, Full, Overlap, Superseded, Invalid, ClockOverflow }
impl From<AudioPushError> for Error {
    fn from(value: AudioPushError) -> Self {
        match value {
            AudioPushError::Contended | AudioPushError::Full => Error::Busy,
            AudioPushError::Overlap => Error::Invalid("overlapping PCM"),
            AudioPushError::Superseded => Error::Superseded,
            AudioPushError::Invalid => Error::Invalid("PCM block"),
            AudioPushError::ClockOverflow => Error::Limit("audio clock"),
        }
    }
}
impl AudioQueue {
    pub fn new(fence: MediaFence, blocks: usize) -> Result<Self> {
        if !(2..=64).contains(&blocks) { return Err(Error::Limit("audio blocks")); }
        Ok(Self { queue: Mutex::new(Queue {
            blocks: vec![AudioBlock::silence(fence, 0); blocks].into_boxed_slice(),
            read: 0, len: 0, fence,
        }) })
    }
    /// Control lane: explicit invalidation flushes old source/seek data.
    pub fn reset(&self, fence: MediaFence) -> Result<()> {
        let mut q = self.queue.try_lock().map_err(|_| Error::Busy)?;
        q.fence = fence; q.read = 0; q.len = 0; Ok(())
    }
    pub fn push(&self, block: &AudioBlock) -> Result<()> {
        self.push_detailed(block).map_err(Into::into)
    }
    pub fn push_detailed(&self, block: &AudioBlock) -> std::result::Result<(), AudioPushError> {
        if block.frames == 0 || block.frames > BLOCK_FRAMES
            || block.samples[..block.frames * AUDIO_CHANNELS].iter().any(|v| !v.is_finite()) {
            return Err(AudioPushError::Invalid);
        }
        block.start.checked_add(block.frames as i64).ok_or(AudioPushError::ClockOverflow)?;
        let mut q = self.queue.try_lock().map_err(|_| AudioPushError::Contended)?;
        if !q.fence.accepts(block.fence) { return Err(AudioPushError::Superseded); }
        if q.len == q.blocks.len() { return Err(AudioPushError::Full); }
        if q.len > 0 {
            let last = &q.blocks[(q.read + q.len - 1) % q.blocks.len()];
            if block.start < last.start.checked_add(last.frames as i64).ok_or(AudioPushError::ClockOverflow)? { return Err(AudioPushError::Overlap); }
        }
        let i = (q.read + q.len) % q.blocks.len();
        q.blocks[i].clone_from(block); q.len += 1; Ok(())
    }
    /// Mix into a preallocated stereo device block. Future samples stay queued;
    /// old samples are discarded. Missing/contended audio is silence, never an old loop.
    pub fn mix(&self, fence: MediaFence, start: i64, output: &mut [f32], gain: f32) -> Result<usize> {
        if output.len() > BLOCK_SAMPLES || output.len() % AUDIO_CHANNELS != 0 || !gain.is_finite() {
            return Err(Error::Invalid("device block"));
        }
        let mut q = self.queue.try_lock().map_err(|_| Error::Busy)?;
        if !q.fence.accepts(fence) { return Err(Error::Superseded); }
        let end = start.checked_add((output.len() / AUDIO_CHANNELS) as i64).ok_or(Error::Limit("audio clock"))?;
        let mut mixed = 0;
        while q.len > 0 {
            let block = &q.blocks[q.read];
            let block_end = block.start.checked_add(block.frames as i64).ok_or(Error::Limit("audio clock"))?;
            if block.start >= end { break; }
            let a = start.max(block.start); let b = end.min(block_end);
            if b > a {
                for frame in a..b {
                    for ch in 0..AUDIO_CHANNELS {
                        output[(frame-start) as usize * 2 + ch] += block.samples[(frame-block.start) as usize * 2 + ch] * gain;
                    }
                }
                mixed += (b-a) as usize;
            }
            if block_end > end { break; }
            q.read = (q.read + 1) % q.blocks.len(); q.len -= 1;
        }
        Ok(mixed)
    }
}

/// One producer endpoint belongs to one serial capture callback; the consumer
/// endpoint belongs to the mixer. Their sample storage is shared, their mutable
/// cursor state is not. No reset from a third thread: reopen creates a new pair.
pub struct AudioProducer {
    ring: rtrb::Producer<AudioBlock>,
    fence: MediaFence,
    last_end: Option<i64>,
}
pub struct AudioConsumer {
    ring: rtrb::Consumer<AudioBlock>,
    fence: MediaFence,
    mixed_until: Option<i64>,
}
pub fn audio_ring(fence: MediaFence, blocks: usize) -> Result<(AudioProducer, AudioConsumer)> {
    if !(2..=64).contains(&blocks) { return Err(Error::Limit("audio blocks")); }
    let (sender, receiver) = rtrb::RingBuffer::new(blocks);
    Ok((AudioProducer { ring: sender, fence, last_end: None },
        AudioConsumer { ring: receiver, fence, mixed_until: None }))
}
impl AudioProducer {
    pub fn push(&mut self, block: &AudioBlock) -> std::result::Result<(), AudioPushError> {
        if block.frames == 0 || block.frames > BLOCK_FRAMES
            || block.samples[..block.frames * AUDIO_CHANNELS].iter().any(|v| !v.is_finite()) {
            return Err(AudioPushError::Invalid);
        }
        let end = block.start.checked_add(block.frames as i64).ok_or(AudioPushError::ClockOverflow)?;
        if !self.fence.accepts(block.fence) { return Err(AudioPushError::Superseded); }
        if self.last_end.is_some_and(|last| block.start < last) { return Err(AudioPushError::Overlap); }
        self.ring.push(block.clone()).map_err(|_| AudioPushError::Full)?;
        self.last_end = Some(end);
        Ok(())
    }
}
impl AudioConsumer {
    pub fn available_blocks(&self) -> usize { self.ring.slots() }
    /// Partial/future blocks remain in the ring. Only consumed/past blocks are
    /// released; a producer can never overwrite samples still being mixed.
    pub fn mix(&mut self, fence: MediaFence, start: i64, output: &mut [f32], gain: f32) -> Result<usize> {
        if output.len() > BLOCK_SAMPLES || output.len() % AUDIO_CHANNELS != 0 || !gain.is_finite() {
            return Err(Error::Invalid("device block"));
        }
        if !self.fence.accepts(fence) { return Err(Error::Superseded); }
        let end = start.checked_add((output.len() / AUDIO_CHANNELS) as i64).ok_or(Error::Limit("audio clock"))?;
        if self.mixed_until.is_some_and(|at| start < at) { return Err(Error::Invalid("nonmonotonic device block")); }
        self.mixed_until = Some(end);
        let mut mixed = 0;
        while let Ok(block) = self.ring.peek() {
            let block_end = block.start + block.frames as i64; // checked at ingress
            if block.start >= end { break; }
            let a = start.max(block.start); let b = end.min(block_end);
            if b > a {
                for frame in a..b {
                    for ch in 0..AUDIO_CHANNELS {
                        output[(frame-start) as usize * 2 + ch] += block.samples[(frame-block.start) as usize * 2 + ch] * gain;
                    }
                }
                mixed += (b-a) as usize;
            }
            if block_end > end { break; }
            let _ = self.ring.pop();
        }
        Ok(mixed)
    }
}

/// Room output policy, separate from a Set's authored dimensions and global preferences.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OutputSize { pub width: u32, pub height: u32 }
impl OutputSize {
    pub const LANDSCAPE: Self = Self { width: 1920, height: 1080 };
    pub const VERTICAL: Self = Self { width: 1080, height: 1920 };
    pub const SQUARE: Self = Self { width: 1080, height: 1080 };
    pub fn validate(self) -> Result<Self> {
        if self.width < 64 || self.height < 64 || self.width > 4096 || self.height > 4096
            || self.width % 2 != 0 || self.height % 2 != 0
            || u64::from(self.width) * u64::from(self.height) > 8_847_360 {
            return Err(Error::Limit("even output dimensions 64..4096, <=8.8 megapixels"));
        }
        Ok(self)
    }
    pub fn aspect(self) -> f64 { f64::from(self.width) / f64::from(self.height) }
}
