//! An immutable, bounded view of one committed recording track. No device,
//! renderer or codec dependencies. Construct/open only on a control/IO worker.
use crate::{
    recording::{Chunk, RecordingHead, RecordingStore, RecordingTrack},
    Error, Result,
};
use producer_production_contract::{Range, Time};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// First native-reader admission profile, independent of recorder capacity.
/// Larger takes remain intact; a future paged index can lift this reader limit.
pub const MAX_VIEW_CHUNKS: u64 = 4096;
#[derive(Debug)]
pub struct CommittedTrack {
    root: PathBuf,
    pub head: RecordingHead,
    pub track: RecordingTrack,
    pub hash: String,
    pub available: Range,
    chunks: Vec<Chunk>,
    media_chunks: [Vec<usize>; 2],
}
impl CommittedTrack {
    pub fn open(root: &Path, track: u32) -> Result<Self> {
        let (_, head) = RecordingStore::inspect(root)?;
        Self::at_head(root, track, head)
    }
    pub fn at_head(root: &Path, track: u32, head: RecordingHead) -> Result<Self> {
        let (header, current) = RecordingStore::inspect(root)?;
        let selected = header
            .tracks
            .get(track as usize)
            .ok_or(Error::Unavailable)?
            .clone();
        if head.revision > current.revision || head.tracks.len() != current.tracks.len() {
            return Err(Error::Invalid("unpublished take checkpoint"));
        }
        let cap = head
            .tracks
            .get(track as usize)
            .and_then(Option::as_ref)
            .ok_or(Error::Unavailable)?;
        let live_cap = current.tracks[track as usize]
            .as_ref()
            .ok_or(Error::Unavailable)?;
        if cap.index > live_cap.index {
            return Err(Error::Unavailable);
        }
        if cap.index >= MAX_VIEW_CHUNKS {
            return Err(Error::Limit("committed track index"));
        }
        let mut chunks = Vec::with_capacity(cap.index as usize + 1);
        let mut ends = [Time::ZERO; 2];
        let mut starts = [None; 2];
        let mut media_chunks: [Vec<usize>; 2] = [Vec::new(), Vec::new()];
        for i in 0..=cap.index {
            let c = RecordingStore::chunk_metadata(root, &head, track, i)?;
            if c.spans.iter().any(|s| match s.media.as_str() {
                "video" => selected.width == 0,
                "audio" => !selected.audio,
                _ => true,
            }) {
                return Err(Error::Invalid("take stream changed"));
            }
            for span in &c.spans {
                let k = usize::from(span.media == "audio");
                if starts[k].is_some() && span.start < ends[k] {
                    return Err(Error::Invalid("overlapping committed media"));
                }
                starts[k].get_or_insert(span.start);
                ends[k] = span.end()?;
                media_chunks[k].push(chunks.len());
            }
            chunks.push(c);
        }
        // A/V availability is an envelope, not a promise of gap-free samples.
        // Independent media lookup below returns unavailable for every hole.
        let k = usize::from(selected.width == 0);
        let start = starts[k].ok_or(Error::Unavailable)?;
        let available = Range {
            start,
            duration: ends[k]
                .checked_sub(start)
                .map_err(|_| Error::Invalid("take range"))?,
        };
        let mut hash = Sha256::new();
        hash.update(b"producer.committed-track/1\0");
        hash.update(
            serde_json::to_vec(&header).map_err(|_| Error::Invalid("take header serialization"))?,
        );
        hash.update(
            serde_json::to_vec(&chunks).map_err(|_| Error::Invalid("take index serialization"))?,
        );
        Ok(Self {
            root: root.into(),
            head,
            track: selected,
            hash: format!("{:x}", hash.finalize()),
            available,
            chunks,
            media_chunks,
        })
    }
    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }
    /// Exact half-open media lookup. Never clamp into future footage or hold a
    /// prior chunk through a gap. Video and audio may have different endpoints.
    pub fn locate(&self, media: &str, at: Time) -> Option<&Chunk> {
        if !matches!(media, "video" | "audio") {
            return None;
        }
        let indexes = &self.media_chunks[usize::from(media == "audio")];
        let i = indexes.partition_point(|index| {
            self.chunks[*index]
                .spans
                .iter()
                .find(|s| s.media == media)
                .is_some_and(|s| s.start <= at)
        });
        let c = self.chunks.get(*indexes.get(i.checked_sub(1)?)?)?;
        c.spans
            .iter()
            .find(|s| s.media == media)
            .filter(|s| s.end().is_ok_and(|end| s.start <= at && at < end))
            .map(|_| c)
    }
    /// Digest verification is repeated at decoder-open, including earlier
    /// fragments which may have been changed after the index was constructed.
    pub fn verified_path(&self, index: u64) -> Result<PathBuf> {
        let expected = self.chunks.get(index as usize).ok_or(Error::Unavailable)?;
        let (actual, path) =
            RecordingStore::read_chunk(&self.root, &self.head, self.track.id, index)?;
        if &actual != expected {
            return Err(Error::Invalid("take index changed"));
        }
        Ok(path)
    }
}
