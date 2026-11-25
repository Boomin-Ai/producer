//! Isolated N1 media adapter. No desktop, live source, audio device or renderer linkage.
//! Decode and file IO run only on admitted workers, never in request/poll.
#[cfg(feature = "ffmpeg")]
pub mod native;
pub mod player;
pub mod boundary;
pub mod recording;
pub mod committed;
#[cfg(feature = "ffmpeg")]
pub mod take;

use producer_production_contract::Time;
use std::sync::atomic::{AtomicUsize, Ordering};
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    Busy,
    Closed,
    Superseded,
    Limit(&'static str),
    Invalid(&'static str),
    Decode(String),
    Unavailable,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}

pub const MAX_PLAYERS: usize = 2;
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_WIDTH: u32 = 1920;
pub const MAX_HEIGHT: u32 = 1920;
static FRAME_BYTES: AtomicUsize = AtomicUsize::new(0);

/// A held reply remains charged even after its player is closed. No uncharged Arc clones.
#[derive(Debug)]
pub struct VideoFrame {
    pub start: Time,
    pub end: Time,
    pub width: u32,
    pub height: u32,
    rgba: Vec<u8>,
    charge: usize,
}
impl VideoFrame {
    pub fn allocate(start: Time, end: Time, width: u32, height: u32) -> Result<Self> {
        if start >= end || width == 0 || height == 0 {
            return Err(Error::Invalid("frame range/dimensions"));
        }
        if width > MAX_WIDTH || height > MAX_HEIGHT {
            return Err(Error::Limit("dimensions"));
        }
        let charge = (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or(Error::Limit("frame bytes"))?;
        FRAME_BYTES
            .try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(charge).filter(|n| *n <= MAX_FRAME_BYTES)
            })
            .map_err(|_| Error::Limit("held frames"))?;
        let mut rgba = Vec::new();
        if rgba.try_reserve_exact(charge).is_err() {
            FRAME_BYTES.fetch_sub(charge, Ordering::AcqRel);
            return Err(Error::Limit("allocation"));
        }
        rgba.resize(charge, 0);
        Ok(Self {
            start,
            end,
            width,
            height,
            rgba,
            charge,
        })
    }
    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }
    pub fn rgba_mut(&mut self) -> &mut [u8] {
        &mut self.rgba
    }
    pub fn covers(&self, source_time: Time) -> bool {
        self.start <= source_time && source_time < self.end
    }
}
impl Drop for VideoFrame {
    fn drop(&mut self) {
        FRAME_BYTES.fetch_sub(self.charge, Ordering::AcqRel);
    }
}
pub fn retained_frame_bytes() -> usize {
    FRAME_BYTES.load(Ordering::Acquire)
}
