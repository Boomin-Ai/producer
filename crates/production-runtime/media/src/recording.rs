//! Durable compressed takes. Storage/control worker only; no device or UI callbacks.
//! Immutable independently playable chunks precede the atomically published head.
//! A frozen head is a capability to committed ranges, never to future footage.
use crate::{Error, Result};
use producer_production_contract::Time;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_SEGMENT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TRACKS: usize = 5;
const MAX_JSON: u64 = 32768;
const MAX_CHUNKS: u64 = 100_000; // >24 hours at the admitted two-second cadence

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingTrack {
    pub id: u32,
    pub source: String,
    pub incarnation: u64,
    pub width: u32,
    pub height: u32,
    pub audio: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingHeader {
    pub version: u32,
    pub room: String,
    pub host_origin_ns: u64,
    pub tracks: Vec<RecordingTrack>,
    #[serde(default)]
    pub asset_refs: std::collections::BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SampleSpan {
    pub media: String,
    pub start: Time,
    pub duration: Time,
}
impl SampleSpan {
    pub fn end(&self) -> Result<Time> {
        self.start.checked_add(self.duration).map_err(io)
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SampleGap {
    pub media: String,
    pub start: Time,
    pub end: Time,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chunk {
    pub track: u32,
    pub index: u64,
    pub bytes: u64,
    pub sha256: String,
    pub spans: Vec<SampleSpan>,
    pub gap_before: Option<(Time, Time)>,
    #[serde(default)]
    pub gaps_before: Vec<SampleGap>,
}
impl Chunk {
    pub fn start(&self) -> Time {
        self.spans
            .iter()
            .map(|s| s.start)
            .max()
            .unwrap_or(Time::ZERO)
    }
    pub fn end(&self) -> Result<Time> {
        self.spans
            .iter()
            .map(SampleSpan::end)
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .min()
            .ok_or(Error::Invalid("empty segment report"))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum TakeState {
    Recording,
    Saved,
    Interrupted,
    Failed,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingHead {
    pub revision: u64,
    pub state: TakeState,
    pub tracks: Vec<Option<Chunk>>,
    pub error: Option<String>,
}
impl RecordingHead {
    /// Conservative common endpoint. Actual available ranges come from chunk
    /// records; gaps are never advertised as continuous footage.
    pub fn common_end(&self) -> Result<Time> {
        if self.tracks.iter().any(Option::is_none) {
            return Ok(Time::ZERO);
        }
        self.tracks
            .iter()
            .flatten()
            .map(Chunk::end)
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .min()
            .ok_or(Error::Unavailable)
    }
}
fn io(e: impl std::fmt::Display) -> Error {
    Error::Decode(e.to_string())
}
fn regular(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path).map_err(io)?;
    if !m.is_file() {
        return Err(Error::Invalid("take file must be regular"));
    }
    Ok(())
}
fn root_dir(path: &Path) -> Result<()> {
    if !fs::symlink_metadata(path).map_err(io)?.is_dir() {
        return Err(Error::Invalid("take root must be a directory, not a link"));
    }
    Ok(())
}
fn json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    regular(path)?;
    let f = File::open(path).map_err(io)?;
    if f.metadata().map_err(io)?.len() > MAX_JSON {
        return Err(Error::Limit("take metadata"));
    }
    serde_json::from_reader(f.take(MAX_JSON + 1)).map_err(io)
}
fn sync_dir(root: &Path) -> Result<()> {
    File::open(root).map_err(io)?.sync_all().map_err(io)
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(io)?;
    f.write_all(bytes).map_err(io)?;
    f.sync_all().map_err(io)
}
fn check_header(h: &RecordingHeader) -> Result<()> {
    if h.version != 1
        || h.room.is_empty()
        || h.room.len() > 128
        || h.tracks.len() < 2
        || h.tracks.len() > MAX_TRACKS
    {
        return Err(Error::Invalid("take header"));
    }
    if h.asset_refs.len() > 32
        || h.asset_refs.iter().any(|(k, v)| {
            k.is_empty()
                || k.len() > 64
                || v.len() != 64
                || !v.bytes().all(|b| b.is_ascii_hexdigit())
        })
    {
        return Err(Error::Invalid("take asset reference"));
    }
    for (i, t) in h.tracks.iter().enumerate() {
        if t.id != i as u32
            || t.source.is_empty()
            || t.source.len() > 64
            || t.incarnation == 0
            || ((t.width == 0 || t.height == 0) && !(t.audio && t.width == 0 && t.height == 0))
            || t.width > 4096
            || t.height > 4096
        {
            return Err(Error::Invalid("take track"));
        }
    }
    Ok(())
}
fn media_name(track: u32, index: u64) -> String {
    format!("track-{track:02}-{index:08}.mp4")
}
fn meta_name(track: u32, index: u64) -> String {
    format!("track-{track:02}-{index:08}.json")
}

pub struct RecordingStore {
    root: PathBuf,
    header: RecordingHeader,
    head: RecordingHead,
    init: Vec<Option<Vec<u8>>>,
    // Per-medium cursors survive a fragment with no samples for that medium.
    stream_ends: Vec<[Option<Time>; 2]>,
    faulted: bool,
    _lock: File,
}
impl RecordingStore {
    pub fn create(root: &Path, header: RecordingHeader) -> Result<Self> {
        check_header(&header)?;
        fs::create_dir(root).map_err(io)?;
        sync_dir(root.parent().ok_or(Error::Invalid("take parent"))?)?;
        let lock = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(root.join("owner.lock"))
            .map_err(io)?;
        lock.try_lock().map_err(io)?;
        write_new(
            &root.join("take.json"),
            &serde_json::to_vec(&header).map_err(io)?,
        )?;
        let head = RecordingHead {
            revision: 0,
            state: TakeState::Recording,
            tracks: vec![None; header.tracks.len()],
            error: None,
        };
        let mut store = Self {
            root: root.into(),
            init: vec![None; header.tracks.len()],
            stream_ends: vec![[None; 2]; header.tracks.len()],
            header,
            head,
            faulted: false,
            _lock: lock,
        };
        store.publish(store.head.clone())?;
        Ok(store)
    }
    pub fn head(&self) -> &RecordingHead {
        &self.head
    }
    pub fn initialize(&mut self, track: u32, data: &[u8]) -> Result<()> {
        if self.faulted {
            return Err(Error::Closed);
        }
        if data.is_empty() || data.len() > 65536 {
            return Err(Error::Limit("take initialization"));
        }
        let slot = self
            .init
            .get_mut(track as usize)
            .ok_or(Error::Invalid("take track"))?;
        if slot.is_some() {
            return Err(Error::Invalid("duplicate take initialization"));
        }
        *slot = Some(data.to_vec());
        Ok(())
    }
    pub fn append(&mut self, track: u32, data: &[u8], spans: Vec<SampleSpan>) -> Result<Chunk> {
        if self.faulted || self.head.state != TakeState::Recording {
            return Err(Error::Closed);
        }
        let result = self.append_inner(track, data, spans);
        if result.is_err() {
            self.faulted = true;
        }
        result
    }
    fn append_inner(&mut self, track: u32, data: &[u8], spans: Vec<SampleSpan>) -> Result<Chunk> {
        if data.is_empty() || data.len() > MAX_SEGMENT_BYTES {
            return Err(Error::Limit("encoded segment bytes"));
        }
        let desc = self
            .header
            .tracks
            .get(track as usize)
            .ok_or(Error::Invalid("take track"))?;
        if spans.is_empty()
            || spans.len() > 2
            || spans.iter().any(|s| {
                s.start < Time::ZERO
                    || s.duration <= Time::ZERO
                    || match s.media.as_str() {
                        "video" => desc.width == 0,
                        "audio" => !desc.audio,
                        _ => true,
                    }
            })
            || spans.len() == 2 && spans[0].media == spans[1].media
        {
            return Err(Error::Invalid("segment sample spans"));
        }
        let init = self.init[track as usize]
            .as_ref()
            .ok_or(Error::Unavailable)?;
        let previous = &self.head.tracks[track as usize];
        let index = previous.as_ref().map_or(0, |c| c.index + 1);
        if index >= MAX_CHUNKS {
            return Err(Error::Limit("take chunks"));
        }
        let mut chunk = Chunk {
            track,
            index,
            bytes: (init.len() + data.len()) as u64,
            sha256: String::new(),
            spans,
            gap_before: None,
            gaps_before: Vec::new(),
        };
        if chunk.end()? <= chunk.start() {
            return Err(Error::Invalid("disjoint segment media"));
        }
        for span in &chunk.spans {
            if let Some(end) = self.stream_ends[track as usize][usize::from(span.media == "audio")]
            {
                if span.start < end {
                    return Err(Error::Invalid("overlapping segment timestamps"));
                }
                if span.start > end {
                    chunk.gaps_before.push(SampleGap {
                        media: span.media.clone(),
                        start: end,
                        end: span.start,
                    });
                }
            }
        }
        if let Some(gap) = chunk.gaps_before.first() {
            chunk.gap_before = Some((gap.start, gap.end));
        }
        let path = self.root.join(media_name(track, index));
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(io)?;
        f.write_all(init).map_err(io)?;
        f.write_all(data).map_err(io)?;
        f.sync_all().map_err(io)?;
        let mut hash = Sha256::new();
        hash.update(init);
        hash.update(data);
        chunk.sha256 = format!("{:x}", hash.finalize());
        write_new(
            &self.root.join(meta_name(track, index)),
            &serde_json::to_vec(&chunk).map_err(io)?,
        )?;
        sync_dir(&self.root)?;
        let mut next = self.head.clone();
        next.tracks[track as usize] = Some(chunk.clone());
        self.publish(next)?;
        for span in &chunk.spans {
            self.stream_ends[track as usize][usize::from(span.media == "audio")] =
                Some(span.end()?);
        }
        Ok(chunk)
    }
    fn publish(&mut self, mut next: RecordingHead) -> Result<()> {
        next.revision = self
            .head
            .revision
            .checked_add(1)
            .ok_or(Error::Limit("take revision"))?;
        let pending = self.root.join("head.pending");
        write_new(&pending, &serde_json::to_vec(&next).map_err(io)?)?;
        fs::rename(&pending, self.root.join("head.json")).map_err(io)?;
        sync_dir(&self.root)?;
        self.head = next;
        Ok(())
    }
    pub fn finish(&mut self) -> Result<()> {
        if self.faulted
            || self.head.state != TakeState::Recording
            || self.head.tracks.iter().any(Option::is_none)
            || self.header.tracks.iter().enumerate().any(|(i, t)| {
                t.width > 0 && self.stream_ends[i][0].is_none()
                    || t.audio && self.stream_ends[i][1].is_none()
            })
        {
            return Err(Error::Unavailable);
        }
        let mut next = self.head.clone();
        next.state = TakeState::Saved;
        self.publish(next)
    }
    pub fn fail(&mut self, message: &str) {
        self.faulted = true;
        let mut next = self.head.clone();
        next.state = TakeState::Failed;
        next.error = Some(message.chars().take(400).collect());
        // Publishing failure may fail on a removed/full drive. The old durable
        // published head remains the recovery boundary; callers still expose failure.
        // A directory-sync error after rename has an uncertain acknowledgement,
        // but can only reference already-fsynced chunks; inspect resolves it.
        let _ = self.publish(next);
    }
    /// Read-only snapshot; validates the latest chunk of each track. Historical
    /// chunks are independently verified when opened, without loading a 24h index.
    pub fn inspect(root: &Path) -> Result<(RecordingHeader, RecordingHead)> {
        root_dir(root)?;
        let header: RecordingHeader = json(&root.join("take.json"))?;
        check_header(&header)?;
        let head: RecordingHead = json(&root.join("head.json"))?;
        if head.tracks.len() != header.tracks.len() || head.revision == 0 {
            return Err(Error::Invalid("take head"));
        }
        for (i, c) in head.tracks.iter().enumerate() {
            if let Some(c) = c {
                if c.track != i as u32 || c.index >= MAX_CHUNKS {
                    return Err(Error::Invalid("take chunk identity"));
                }
                Self::read_chunk(root, &head, c.track, c.index)?;
            }
        }
        Ok((header, head))
    }
    /// Lock must be free: never mutate a take owned by a running recorder.
    pub fn recover(root: &Path) -> Result<RecordingHead> {
        root_dir(root)?;
        regular(&root.join("owner.lock"))?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("owner.lock"))
            .map_err(io)?;
        lock.try_lock().map_err(|_| Error::Busy)?;
        let (header, head) = Self::inspect(root)?;
        if head.state != TakeState::Recording {
            return Ok(head);
        }
        // A torn pending head and orphan chunks are intentionally not adopted.
        let pending = root.join("head.pending");
        if pending.exists() {
            fs::rename(
                &pending,
                root.join(format!("head-interrupted-{}.json", head.revision)),
            )
            .map_err(io)?;
        }
        let mut store = Self {
            root: root.into(),
            init: vec![],
            stream_ends: vec![],
            header,
            head,
            faulted: true,
            _lock: lock,
        };
        let mut next = store.head.clone();
        next.state = TakeState::Interrupted;
        next.error = Some("Recording interrupted; committed chunks retained".into());
        store.publish(next)?;
        Ok(store.head)
    }
    pub fn read_chunk(
        root: &Path,
        snapshot: &RecordingHead,
        track: u32,
        index: u64,
    ) -> Result<(Chunk, PathBuf)> {
        let c = Self::chunk_metadata(root, snapshot, track, index)?;
        let path = root.join(media_name(track, index));
        regular(&path)?;
        let mut f = File::open(&path).map_err(io)?;
        if f.metadata().map_err(io)?.len() != c.bytes {
            return Err(Error::Invalid("committed chunk length"));
        }
        let mut hash = Sha256::new();
        let mut scratch = [0; 65536];
        loop {
            let n = f.read(&mut scratch).map_err(io)?;
            if n == 0 {
                break;
            }
            hash.update(&scratch[..n]);
        }
        if format!("{:x}", hash.finalize()) != c.sha256 {
            return Err(Error::Invalid("committed chunk digest"));
        }
        Ok((c, path))
    }
    /// Control/IO lane only. This indexes the frozen checkpoint; it does NOT
    /// grant access to media bytes. Decoders must still call read_chunk.
    pub fn chunk_metadata(
        root: &Path,
        snapshot: &RecordingHead,
        track: u32,
        index: u64,
    ) -> Result<Chunk> {
        root_dir(root)?;
        let cap = snapshot
            .tracks
            .get(track as usize)
            .and_then(Option::as_ref)
            .ok_or(Error::Unavailable)?;
        if index > cap.index {
            return Err(Error::Unavailable);
        }
        let c: Chunk = json(&root.join(meta_name(track, index)))?;
        if c.track != track
            || c.index != index
            || c.bytes == 0
            || c.bytes > (MAX_SEGMENT_BYTES + 65536) as u64
            || c.sha256.len() != 64
            || !c.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || c.spans.iter().any(|s| {
                s.start < Time::ZERO
                    || s.duration <= Time::ZERO
                    || !matches!(s.media.as_str(), "audio" | "video")
            })
            || c.spans.len() == 2 && c.spans[0].media == c.spans[1].media
            || c.gaps_before.len() > 2
            || c.gaps_before
                .iter()
                .any(|g| g.start < Time::ZERO || g.end <= g.start)
            || c.spans.is_empty()
            || c.spans.len() > 2
            || c.end()? <= c.start()
            || (index == cap.index && &c != cap)
        {
            return Err(Error::Invalid("committed chunk metadata"));
        }
        Ok(c)
    }
}
