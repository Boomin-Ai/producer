//! Local-file-only FFmpeg adapter. CPU RGBA proof; not GPU/zero-copy qualification.
use crate::{
    player::{Cancellation, DecodeStatistics, Decoder, Player},
    Error, Result, VideoFrame, MAX_HEIGHT, MAX_WIDTH,
};
use ffmpeg::{
    format::Pixel,
    media::Type,
    software::scaling::{context::Context as Scaler, flag::Flags},
    util::frame::video::Video,
};
use ffmpeg_next as ffmpeg;
use producer_production_contract::Time;
use std::path::{Path, PathBuf};

/// Native file selection yields this grant; document JSON never resolves arbitrary paths.
#[derive(Clone)]
pub struct LocalAsset {
    path: PathBuf,
    available_end: Option<Time>,
    min_bytes: u64,
}
impl LocalAsset {
    pub fn grant(path: &Path) -> Result<Self> {
        let path = path
            .canonicalize()
            .map_err(|e| Error::Decode(e.to_string()))?;
        let metadata = path.metadata().map_err(|e| Error::Decode(e.to_string()))?;
        if !metadata.is_file() || metadata.len() > 128 * 1024 * 1024 || path.to_str().is_none() {
            return Err(Error::Limit("local regular asset <=128 MiB"));
        }
        Ok(Self {
            path,
            available_end: None,
            min_bytes: 0,
        })
    }
    pub(crate) fn committed(path: &Path, end: Time, bytes: u64) -> Result<Self> {
        if end <= Time::ZERO || bytes == 0 {
            return Err(Error::Unavailable);
        }
        let mut asset = Self::grant(path)?;
        asset.available_end = Some(end);
        asset.min_bytes = bytes;
        Ok(asset)
    }
    pub fn open_player(self) -> Result<Player> {
        Player::start(move || NativeDecoder::open(self))
    }
}
pub struct NativeDecoder {
    input: ffmpeg::format::context::Input,
    decoder: ffmpeg::decoder::Video,
    scaler: Option<Scaler>,
    stream: usize,
    timebase: ffmpeg::Rational,
    draining: bool,
    packet_work: usize,
    available_end: Option<Time>,
    available_start: Option<Time>,
    frame_work: usize,
    statistics: DecodeStatistics,
    cached: Option<(Video, Time, Time)>,
    lookahead: Option<(Video, Time)>,
    rgba_scratch: Video,
}
fn err(e: ffmpeg::Error) -> Error {
    Error::Decode(e.to_string())
}
impl NativeDecoder {
    pub fn open(asset: LocalAsset) -> Result<Self> {
        ffmpeg::init().map_err(err)?;
        if asset
            .path
            .metadata()
            .map_err(|e| Error::Decode(e.to_string()))?
            .len()
            < asset.min_bytes
        {
            return Err(Error::Unavailable);
        }
        let mut options = ffmpeg::Dictionary::new();
        options.set("probesize", "1048576");
        options.set("analyzeduration", "1000000");
        options.set("max_streams", "8");
        options.set("protocol_whitelist", "file");
        let input = ffmpeg::format::input_with_dictionary(&asset.path, options).map_err(err)?;
        if input.streams().len() > 8 {
            return Err(Error::Limit("streams"));
        }
        let stream = input
            .streams()
            .best(Type::Video)
            .ok_or(Error::Invalid("no video stream"))?;
        let index = stream.index();
        let timebase = stream.time_base();
        if timebase.0 <= 0 || timebase.1 <= 0 {
            return Err(Error::Invalid("timebase"));
        }
        let mut available_end =
            if stream.duration() > 0 && stream.start_time() != ffmpeg::ffi::AV_NOPTS_VALUE {
                Time::try_ratio(
                    (stream.start_time() as i128 + stream.duration() as i128) * timebase.0 as i128,
                    timebase.1 as i128,
                )
            } else {
                None
            };
        if let Some(end) = asset.available_end {
            available_end = Some(available_end.map_or(end, |probed| probed.min(end)));
        }
        let available_start = if stream.start_time() != ffmpeg::ffi::AV_NOPTS_VALUE {
            Time::try_ratio(
                stream.start_time() as i128 * timebase.0 as i128,
                timebase.1 as i128,
            )
        } else {
            None
        };
        let mut context =
            ffmpeg::codec::context::Context::from_parameters(stream.parameters()).map_err(err)?;
        // Bound allocations before the decoder sees a coded sequence header.
        unsafe {
            (*context.as_mut_ptr()).max_pixels = i64::from(MAX_WIDTH) * i64::from(MAX_HEIGHT);
        }
        context.set_threading(ffmpeg::codec::threading::Config {
            kind: ffmpeg::codec::threading::Type::None,
            count: 1,
        });
        let decoder = context.decoder().video().map_err(err)?;
        if decoder.width() > MAX_WIDTH || decoder.height() > MAX_HEIGHT {
            return Err(Error::Limit("dimensions"));
        }
        Ok(Self {
            input,
            decoder,
            scaler: None,
            stream: index,
            timebase,
            draining: false,
            packet_work: 0,
            available_end,
            available_start,
            frame_work: 0,
            statistics: DecodeStatistics::default(),
            cached: None,
            lookahead: None,
            rgba_scratch: Video::empty(),
        })
    }
    fn time(&self, ticks: i64) -> Result<Time> {
        Time::try_ratio(
            ticks as i128 * self.timebase.0 as i128,
            self.timebase.1 as i128,
        )
        .ok_or(Error::Invalid("source PTS"))
    }
    fn next(&mut self, cancel: &Cancellation) -> Result<Option<Video>> {
        loop {
            cancel.check()?;
            let mut frame = Video::empty();
            match self.decoder.receive_frame(&mut frame) {
                Ok(()) => {
                    self.statistics.decoded_frames = self
                        .statistics
                        .decoded_frames
                        .checked_add(1)
                        .ok_or(Error::Limit("decoded frame counter"))?;
                    self.frame_work += 1;
                    if self.frame_work > 4096 {
                        return Err(Error::Limit("decoded frame work"));
                    }
                    return Ok(Some(frame));
                }
                Err(ffmpeg::Error::Eof) => return Ok(None),
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => {}
                Err(e) => return Err(err(e)),
            }
            if self.draining {
                return Err(Error::Invalid("decoder requested packets after drain"));
            }
            self.packet_work += 1;
            if self.packet_work > 50_000 {
                return Err(Error::Limit("packet work"));
            }
            let mut packet = ffmpeg::Packet::empty();
            match packet.read(&mut self.input) {
                Ok(()) => {
                    if packet.size() > 8 * 1024 * 1024 {
                        return Err(Error::Limit("packet bytes"));
                    }
                    if packet.stream() == self.stream {
                        self.decoder.send_packet(&packet).map_err(err)?;
                    }
                }
                Err(ffmpeg::Error::Eof) => {
                    self.decoder.send_eof().map_err(err)?;
                    self.draining = true;
                }
                Err(e) => return Err(err(e)),
            }
        }
    }
    fn rgba(&mut self, frame: &Video, start: Time, end: Time) -> Result<VideoFrame> {
        if frame.width() > MAX_WIDTH || frame.height() > MAX_HEIGHT {
            return Err(Error::Limit("dynamic dimensions"));
        }
        let end = self
            .available_end
            .map_or(end, |available| available.min(end));
        let mut result = VideoFrame::allocate(start, end, frame.width(), frame.height())?;
        if self.scaler.as_ref().is_none_or(|s| {
            s.input().format != frame.format()
                || s.input().width != frame.width()
                || s.input().height != frame.height()
        }) {
            self.scaler = Some(
                Scaler::get(
                    frame.format(),
                    frame.width(),
                    frame.height(),
                    Pixel::RGBA,
                    frame.width(),
                    frame.height(),
                    Flags::BILINEAR,
                )
                .map_err(err)?,
            );
        }
        let scaler = self.scaler.as_mut().unwrap();
        if self.rgba_scratch.width() != frame.width()
            || self.rgba_scratch.height() != frame.height()
        {
            self.rgba_scratch = Video::empty();
        }
        scaler.run(frame, &mut self.rgba_scratch).map_err(err)?;
        let rgba = &self.rgba_scratch;
        let row_bytes = frame.width() as usize * 4;
        for (y, row) in result.rgba_mut().chunks_exact_mut(row_bytes).enumerate() {
            let start = y * rgba.stride(0);
            row.copy_from_slice(&rgba.data(0)[start..start + row_bytes]);
        }
        Ok(result)
    }
}
impl NativeDecoder {
    fn locate(
        &mut self,
        at: Time,
        anchor: Option<Time>,
        cancel: &Cancellation,
    ) -> Result<Option<VideoFrame>> {
        cancel.check()?;
        if let Some(anchor) = anchor {
            self.statistics.seek_calls = self
                .statistics
                .seek_calls
                .checked_add(1)
                .ok_or(Error::Limit("seek counter"))?;
            let micros = (anchor.ticks() as i128 * 1_000_000).div_euclid(anchor.rate() as i128);
            let micros = i64::try_from(micros).map_err(|_| Error::Invalid("seek time"))?;
            self.input.seek(micros, ..micros).map_err(err)?;
            self.decoder.flush();
            self.draining = false;
            self.cached = None;
            self.lookahead = None;
        }
        let mut previous: Option<(Video, Time)> = None;
        for _ in 0..4096 {
            let next = match self.lookahead.take() {
                Some((frame, _)) => Some(frame),
                None => self.next(cancel)?,
            };
            match next {
                Some(frame) => {
                    let start =
                        self.time(frame.timestamp().ok_or(Error::Invalid("missing PTS"))?)?;
                    if let Some((prev, prev_start)) = previous.take() {
                        if start <= prev_start {
                            return Err(Error::Invalid("non-increasing decoded PTS"));
                        }
                        if at < start {
                            let output = self.rgba(&prev, prev_start, start)?;
                            self.cached = Some((prev, prev_start, start));
                            self.lookahead = Some((frame, start));
                            return Ok(Some(output));
                        }
                    }
                    if start > at {
                        return Ok(None);
                    }
                    previous = Some((frame, start));
                }
                None => {
                    let (frame, start) = previous.ok_or(Error::Unavailable)?;
                    let duration = frame.packet().duration;
                    if duration <= 0 {
                        return Err(Error::Invalid("missing final frame duration"));
                    }
                    let end = start
                        .checked_add(self.time(duration)?)
                        .map_err(|_| Error::Invalid("frame end"))?;
                    if at >= end {
                        return Err(Error::Unavailable);
                    }
                    let output = self.rgba(&frame, start, end)?;
                    self.cached = Some((frame, start, end));
                    return Ok(Some(output));
                }
            }
        }
        Err(Error::Limit("decoded frame work"))
    }
}

// MOV keyframe indexes can be ordered by DTS. B-frame display PTS may land
// after the target: back off and preroll, never substitute a future frame.
impl Decoder for NativeDecoder {
    fn statistics(&self) -> DecodeStatistics {
        self.statistics
    }
    fn seek(&mut self, at: Time, cancel: &Cancellation) -> Result<VideoFrame> {
        cancel.check()?;
        if self.available_end.is_some_and(|end| at >= end)
            || self.available_start.is_some_and(|start| at < start)
        {
            return Err(Error::Unavailable);
        }
        self.packet_work = 0;
        self.frame_work = 0;
        if let Some((frame, start, end)) = self.cached.take() {
            if start <= at && at < end {
                let result = self.rgba(&frame, start, end);
                self.cached = Some((frame, start, end));
                return result;
            }
            let near_forward = at >= end
                && at
                    .checked_sub(end)
                    .map_err(|_| Error::Invalid("forward offset"))?
                    <= Time::seconds(1);
            if near_forward && self.lookahead.is_some() {
                if let Some(frame) = self.locate(at, None, cancel)? {
                    return Ok(frame);
                }
            }
        }
        for backoff in [0, 1, 2, 4, 8, 16] {
            cancel.check()?;
            let mut anchor = at
                .checked_sub(Time::seconds(backoff))
                .map_err(|_| Error::Invalid("seek anchor"))?;
            if let Some(start) = self.available_start {
                anchor = anchor.max(start);
            }
            if let Some(frame) = self.locate(at, Some(anchor), cancel)? {
                return Ok(frame);
            }
        }
        Err(Error::Limit("keyframe preroll"))
    }
}
