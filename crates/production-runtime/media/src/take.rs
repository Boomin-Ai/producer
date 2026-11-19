//! First growing-take proof: raw video + PCM packet pair, worker/control lane only.
//! No capture/encoder callbacks are connected. Compressed recording is a separate gate.
use crate::{Error, Result};
use ffmpeg_next as ffmpeg;
use producer_production_contract::Time;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
static WRITER: AtomicBool = AtomicBool::new(false);
struct WriterPermit;
impl Drop for WriterPermit {
    fn drop(&mut self) {
        WRITER.store(false, Ordering::Release);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeManifest {
    pub revision: u64,
    pub available_end: Time,
    pub program_bytes: u64,
    pub original_bytes: u64,
    pub finished: bool,
}
fn io(e: impl std::fmt::Display) -> Error {
    Error::Decode(e.to_string())
}
struct Lane {
    context: ffmpeg::format::context::Output,
    path: PathBuf,
}
impl Lane {
    fn finish(&mut self) -> Result<()> {
        // The pinned MOV muxer returns the positive mfra size (e.g. 243), although
        // ffmpeg-next's wrapper accepts only zero. Treat negative codes as errors
        // and independently check AVIO; never retry a successfully written trailer.
        let code = unsafe { ffmpeg::ffi::av_write_trailer(self.context.as_mut_ptr()) };
        if code < 0 {
            return Err(io(ffmpeg::Error::from(code)));
        }
        Ok(())
    }
    fn open(path: PathBuf, input: &ffmpeg::format::context::Input) -> Result<Self> {
        let mut context = ffmpeg::format::output(&path).map_err(io)?;
        for stream in input.streams() {
            let mut output = context
                .add_stream(ffmpeg::encoder::find(ffmpeg::codec::Id::None))
                .map_err(io)?;
            output.set_parameters(stream.parameters());
            output.set_time_base(stream.time_base());
            unsafe {
                (*output.parameters().as_mut_ptr()).codec_tag = 0;
            }
        }
        let mut options = ffmpeg::Dictionary::new();
        options.set("movflags", "frag_custom+empty_moov+default_base_moof");
        context.write_header_with(options).map_err(io)?;
        Ok(Self { context, path })
    }
    fn packet(&mut self, mut packet: ffmpeg::Packet, timebase: ffmpeg::Rational) -> Result<()> {
        let stream = self
            .context
            .stream(packet.stream())
            .ok_or(Error::Invalid("take stream"))?;
        packet.rescale_ts(timebase, stream.time_base());
        packet.set_position(-1);
        packet.write_interleaved(&mut self.context).map_err(io)
    }
    fn sync_fragment(&mut self, finish_fragment: bool) -> Result<u64> {
        // Drain interleaving, finish a custom MOV fragment, then flush AVIO before fsync.
        unsafe {
            let context = self.context.as_mut_ptr();
            if finish_fragment {
                let code = ffmpeg::ffi::av_interleaved_write_frame(context, std::ptr::null_mut());
                if code < 0 {
                    return Err(io(ffmpeg::Error::from(code)));
                }
                let code = ffmpeg::ffi::av_write_frame(context, std::ptr::null_mut());
                if code < 0 {
                    return Err(io(ffmpeg::Error::from(code)));
                }
            }
            ffmpeg::ffi::avio_flush((*context).pb);
            if (*(*context).pb).error < 0 {
                return Err(io(ffmpeg::Error::from((*(*context).pb).error)));
            }
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.path)
            .map_err(io)?;
        file.sync_all().map_err(io)?;
        Ok(file.metadata().map_err(io)?.len())
    }
}
pub struct TakePair {
    root: PathBuf,
    program: Lane,
    original: Lane,
    timebases: Vec<ffmpeg::Rational>,
    ends: Vec<Time>,
    last: TakeManifest,
    faulted: bool,
    total_packet_bytes: usize,
    _permit: WriterPermit,
}
#[derive(Clone, Copy)]
pub enum TakeLane {
    Program,
    Original,
}
impl TakePair {
    /// A snapshot reader cannot seek into later, uncommitted footage as files grow.
    pub fn open_committed(&self, lane: TakeLane) -> Result<crate::player::Player> {
        let (path, bytes) = match lane {
            TakeLane::Program => (&self.program.path, self.last.program_bytes),
            TakeLane::Original => (&self.original.path, self.last.original_bytes),
        };
        crate::native::LocalAsset::committed(path, self.last.available_end, bytes)?.open_player()
    }
    /// Destination is a new child of a native-granted folder. Never overwrites an existing take.
    /// Initial profile intentionally accepts only one RAWVIDEO and one PCM_S16LE stream.
    pub fn create(root: &Path, input: &ffmpeg::format::context::Input) -> Result<Self> {
        if input.streams().len() != 2 {
            return Err(Error::Invalid("take requires raw video + PCM"));
        }
        let mut video = 0;
        let mut audio = 0;
        for stream in input.streams() {
            match stream.parameters().id() {
                ffmpeg::codec::Id::RAWVIDEO => video += 1,
                ffmpeg::codec::Id::PCM_S16LE => audio += 1,
                _ => return Err(Error::Invalid("take codec outside proof profile")),
            }
        }
        if video != 1 || audio != 1 {
            return Err(Error::Invalid("take streams"));
        }
        WRITER
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| Error::Limit("take writers"))?;
        let permit = WriterPermit;
        fs::create_dir(root).map_err(io)?;
        let program = Lane::open(root.join("program.mov"), input)?;
        let original = Lane::open(root.join("original.mov"), input)?;
        Ok(Self {
            root: root.into(),
            program,
            original,
            timebases: input.streams().map(|s| s.time_base()).collect(),
            ends: vec![Time::ZERO; 2],
            last: TakeManifest {
                revision: 0,
                available_end: Time::ZERO,
                program_bytes: 0,
                original_bytes: 0,
                finished: false,
            },
            faulted: false,
            total_packet_bytes: 0,
            _permit: permit,
        })
    }
    pub fn push(&mut self, program: ffmpeg::Packet, original: ffmpeg::Packet) -> Result<()> {
        if self.faulted || self.last.finished {
            return Err(Error::Closed);
        }
        let result = self.push_inner(program, original);
        if result.is_err() {
            self.faulted = true;
        }
        result
    }
    fn push_inner(&mut self, program: ffmpeg::Packet, original: ffmpeg::Packet) -> Result<()> {
        if program.stream() != original.stream()
            || program.pts() != original.pts()
            || program.dts() != original.dts()
            || program.duration() != original.duration()
        {
            return Err(Error::Invalid("pair packet clocks differ"));
        }
        let index = program.stream();
        let tb = *self
            .timebases
            .get(index)
            .ok_or(Error::Invalid("take stream index"))?;
        if program.duration() <= 0 || program.pts() != program.dts() {
            return Err(Error::Invalid("take proof requires ordered packets"));
        }
        let start = Time::try_ratio(
            i128::from(program.pts().ok_or(Error::Invalid("take PTS"))?) * i128::from(tb.0),
            i128::from(tb.1),
        )
        .ok_or(Error::Invalid("take timebase"))?;
        if start != self.ends[index] {
            return Err(Error::Invalid("non-contiguous take packets"));
        }
        let duration = Time::try_ratio(
            i128::from(program.duration()) * i128::from(tb.0),
            i128::from(tb.1),
        )
        .ok_or(Error::Invalid("take duration"))?;
        let end = start.checked_add(duration).map_err(io)?;
        self.total_packet_bytes = self
            .total_packet_bytes
            .checked_add(program.size())
            .and_then(|n| n.checked_add(original.size()))
            .filter(|n| *n <= 32 * 1024 * 1024)
            .ok_or(Error::Limit("take proof packet bytes"))?;
        self.program.packet(program, tb)?;
        self.original.packet(original, tb)?;
        self.ends[index] = end;
        Ok(())
    }
    pub fn committed(&self) -> &TakeManifest {
        &self.last
    }
    pub fn checkpoint(&mut self) -> Result<TakeManifest> {
        self.commit(false)
    }
    fn commit(&mut self, finished: bool) -> Result<TakeManifest> {
        if self.faulted || self.last.finished {
            return Err(Error::Closed);
        }
        let result = self.commit_inner(finished);
        if result.is_err() && result != Err(Error::Unavailable) {
            self.faulted = true;
        }
        result
    }
    fn commit_inner(&mut self, finished: bool) -> Result<TakeManifest> {
        let end = *self.ends.iter().min().unwrap();
        if end <= self.last.available_end && !finished {
            return Err(Error::Unavailable);
        }
        let program_bytes = self.program.sync_fragment(!finished)?;
        let original_bytes = self.original.sync_fragment(!finished)?;
        let next = TakeManifest {
            revision: self
                .last
                .revision
                .checked_add(1)
                .ok_or(Error::Limit("take revision"))?,
            available_end: end,
            program_bytes,
            original_bytes,
            finished,
        };
        let pending = self.root.join("manifest.pending");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(io)?;
        serde_json::to_writer(&mut file, &next).map_err(io)?;
        file.write_all(b"\n").map_err(io)?;
        file.sync_all().map_err(io)?;
        fs::rename(pending, self.root.join("manifest.json")).map_err(io)?;
        File::open(&self.root).map_err(io)?.sync_all().map_err(io)?;
        self.last = next.clone();
        Ok(next)
    }
    pub fn finish(mut self) -> Result<TakeManifest> {
        if self.faulted || self.last.finished {
            return Err(Error::Closed);
        }
        self.program.finish()?;
        self.original.finish()?;
        self.commit(true)
    }
}
