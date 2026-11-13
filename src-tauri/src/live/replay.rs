//! Opt-in encoded replay buffers. All lifecycle calls stay on the engine owner.
//! OBS writes saves asynchronously; callbacks only publish atomic receipts.
use super::{encoders, ffi};
use crate::clips::{ClipFile, ClipOutput, ClipSettings, ClipStatus, ClipTrackStatus};
use serde_json::{json, Value};
use std::{
    ffi::{c_void, CStr, CString},
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
fn c(s: &str) -> CString {
    CString::new(s).expect("validated replay string")
}
// Exact OBS 32.1.2 callback/calldata.h ABI. OBS owns the allocation.
#[repr(C)]
#[derive(Default)]
struct CallData {
    stack: *mut u8,
    size: usize,
    capacity: usize,
    fixed: bool,
}
impl Drop for CallData {
    fn drop(&mut self) {
        if !self.fixed {
            unsafe { ffi::bfree(self.stack.cast()) }
        }
    }
}
impl CallData {
    fn raw(&mut self) -> *mut ffi::calldata_t {
        (self as *mut Self).cast()
    }
}
struct Signals {
    saved: AtomicBool,
    stop: AtomicI64,
}
extern "C" fn saved(data: *mut c_void, _: *mut ffi::calldata_t) {
    unsafe { &*(data as *const Signals) }
        .saved
        .store(true, Ordering::Release);
}
extern "C" fn stopped(data: *mut c_void, cd: *mut ffi::calldata_t) {
    let mut code = -1i64;
    unsafe {
        ffi::calldata_get_data(
            cd,
            b"code\0".as_ptr().cast(),
            (&mut code as *mut i64).cast(),
            8,
        );
        (&*(data as *const Signals))
            .stop
            .store(code, Ordering::Release);
    }
}
struct Buffer {
    output: *mut ffi::obs_output_t,
    video: *mut ffi::obs_encoder_t,
    audio: *mut ffi::obs_encoder_t,
    input: *mut ffi::video_t,
    input_baseline: u32,
    skipped_baseline: u32,
    kind: ClipOutput,
    signals: Box<Signals>,
}
impl Buffer {
    unsafe fn start(
        kind: ClipOutput,
        seconds: u32,
        memory_mb: u32,
        bitrate: i64,
        video: *mut ffi::video_t,
    ) -> Result<Self, String> {
        if video.is_null() {
            return Err("This output canvas is not ready".into());
        }
        let name = format!("Producer Clips {kind:?}");
        let vs = ffi::obs_data_create();
        encoders::apply_video_defaults(vs, &encoders::chosen().id, bitrate);
        // Replay capture needs packets promptly, rather than a look-ahead
        // queue. Scope this to Clips; streaming/recording keep their profiles.
        #[cfg(target_os = "macos")]
        if encoders::family(&encoders::chosen().id) == encoders::Family::VideoToolbox {
            ffi::obs_data_set_bool(vs, c("bframes").as_ptr(), false);
        }
        let a = ffi::obs_data_create();
        ffi::obs_data_set_int(a, c("bitrate").as_ptr(), 192);
        let (venc, _) = encoders::create_video(&format!("{name} H264"), vs);
        let aenc = ffi::obs_audio_encoder_create(
            c(encoders::audio_id()).as_ptr(),
            c(&format!("{name} AAC")).as_ptr(),
            a,
            0,
            ptr::null_mut(),
        );
        ffi::obs_data_release(vs);
        ffi::obs_data_release(a);
        if venc.is_null() || aenc.is_null() {
            if !venc.is_null() {
                ffi::obs_encoder_release(venc)
            }
            if !aenc.is_null() {
                ffi::obs_encoder_release(aenc)
            }
            return Err("Could not create Clips encoders".into());
        }
        ffi::obs_encoder_set_video(venc, video);
        ffi::obs_encoder_set_audio(aenc, ffi::obs_get_audio());
        let settings = ffi::obs_data_create();
        ffi::obs_data_set_int(settings, c("max_time_sec").as_ptr(), seconds as i64);
        ffi::obs_data_set_int(settings, c("max_size_mb").as_ptr(), memory_mb as i64);
        ffi::obs_data_set_string(settings, c("extension").as_ptr(), c("mp4").as_ptr());
        ffi::obs_data_set_bool(settings, c("allow_spaces").as_ptr(), true);
        let output = ffi::obs_output_create(
            c("replay_buffer").as_ptr(),
            c(&name).as_ptr(),
            settings,
            ptr::null_mut(),
        );
        ffi::obs_data_release(settings);
        if output.is_null() {
            ffi::obs_encoder_release(venc);
            ffi::obs_encoder_release(aenc);
            return Err("This native engine does not include replay-buffer capture".into());
        }
        ffi::obs_output_set_media(output, video, ffi::obs_get_audio());
        ffi::obs_output_set_video_encoder(output, venc);
        ffi::obs_output_set_audio_encoder(output, aenc, 0);
        let signals = Box::new(Signals {
            saved: AtomicBool::new(false),
            stop: AtomicI64::new(i64::MIN),
        });
        let signal_data = (&*signals as *const Signals).cast_mut().cast();
        ffi::signal_handler_connect(
            ffi::obs_output_get_signal_handler(output),
            c("saved").as_ptr(),
            saved,
            signal_data,
        );
        ffi::signal_handler_connect(
            ffi::obs_output_get_signal_handler(output),
            c("stop").as_ptr(),
            stopped,
            signal_data,
        );
        let buffer = Self {
            output,
            video: venc,
            audio: aenc,
            input: video,
            input_baseline: ffi::video_output_get_total_frames(video),
            skipped_baseline: ffi::video_output_get_skipped_frames(video),
            kind,
            signals,
        };
        if !ffi::obs_output_start(output) {
            return Err(buffer.error("Rolling capture could not start"));
        }
        Ok(buffer)
    }
    fn error(&self, fallback: &str) -> String {
        unsafe {
            let p = ffi::obs_output_get_last_error(self.output);
            if p.is_null() {
                fallback.into()
            } else {
                let s = CStr::from_ptr(p).to_string_lossy();
                if s.is_empty() {
                    fallback.into()
                } else {
                    s.into_owned()
                }
            }
        }
    }
    fn frames(&self) -> u64 {
        unsafe { ffi::obs_output_get_total_frames(self.output).max(0) as u64 }
    }
    fn status(&self) -> ClipTrackStatus {
        unsafe {
            ClipTrackStatus {
                output: self.kind,
                captured_frames: self.frames(),
                encoded_frames: ffi::obs_encoder_get_encoded_frames(self.video),
                input_frames: ffi::video_output_get_total_frames(self.input)
                    .wrapping_sub(self.input_baseline),
                input_skipped_frames: ffi::video_output_get_skipped_frames(self.input)
                    .wrapping_sub(self.skipped_baseline),
                video_active: ffi::obs_encoder_active(self.video),
                audio_active: ffi::obs_encoder_active(self.audio),
            }
        }
    }
    fn failed(&self) -> bool {
        self.signals.stop.load(Ordering::Acquire) != i64::MIN
    }
    unsafe fn abort(&self) {
        if ffi::obs_output_active(self.output) && !self.failed() {
            // replay_buffer's stop hook only marks a stop timestamp: even
            // force_stop waits for its NEXT encoded packet to end capture.
            // A startup failure has no such packet. Signal terminal stop so
            // libobs disconnects encoders and joins its normal teardown worker
            // before callback data/encoder refs are released.
            ffi::obs_output_signal_stop(self.output, 0);
        }
    }
    unsafe fn save(&self, job: &str, directory: &str) -> Result<(), String> {
        self.signals.saved.store(false, Ordering::Release);
        let settings = ffi::obs_data_create();
        ffi::obs_data_set_string(settings, c("directory").as_ptr(), c(directory).as_ptr());
        // An unguessable job name per output prevents overwriting earlier clips.
        ffi::obs_data_set_string(
            settings,
            c("format").as_ptr(),
            c(&format!("Producer Clip {job} {:?}", self.kind)).as_ptr(),
        );
        ffi::obs_output_update(self.output, settings);
        ffi::obs_data_release(settings);
        let mut cd = CallData::default();
        if !ffi::proc_handler_call(
            ffi::obs_output_get_proc_handler(self.output),
            c("save").as_ptr(),
            cd.raw(),
        ) {
            return Err("The replay save procedure is unavailable".into());
        }
        Ok(())
    }
    unsafe fn receipt(&self) -> Result<ClipFile, String> {
        let mut cd = CallData::default();
        let mut path = ptr::null();
        if !ffi::proc_handler_call(
            ffi::obs_output_get_proc_handler(self.output),
            c("get_last_replay").as_ptr(),
            cd.raw(),
        ) || !ffi::calldata_get_string(cd.raw(), c("path").as_ptr(), &mut path)
            || path.is_null()
        {
            return Err("The clip writer did not return a file".into());
        }
        let path = CStr::from_ptr(path).to_string_lossy().into_owned();
        if path.is_empty() {
            return Err("The clip writer returned an empty path".into());
        }
        Ok(ClipFile {
            path,
            output: self.kind,
            duration_ms: 0,
        })
    }
}
impl Drop for Buffer {
    fn drop(&mut self) {
        unsafe {
            // Release joins data-capture teardown and the save writer. The
            // callback box remains alive until both joins complete.
            self.abort();
            let handler = ffi::obs_output_get_signal_handler(self.output);
            let data = (&*self.signals as *const Signals).cast_mut().cast();
            ffi::signal_handler_disconnect(handler, c("saved").as_ptr(), saved, data);
            ffi::signal_handler_disconnect(handler, c("stop").as_ptr(), stopped, data);
            ffi::obs_output_release(self.output);
            ffi::obs_encoder_release(self.video);
            ffi::obs_encoder_release(self.audio);
        }
    }
}
struct Pending {
    reply: mpsc::Sender<Result<Value, String>>,
    started: Instant,
}
struct Preparing {
    landscape: *mut ffi::video_t,
    portrait: *mut ffi::video_t,
    baseline: u32,
    bitrate: i64,
}
pub struct Replay {
    room: String,
    settings: ClipSettings,
    started: Instant,
    buffers: Vec<Buffer>,
    preparing: Option<Preparing>,
    pending: Option<Pending>,
    error: Option<String>,
}
impl Replay {
    pub unsafe fn start(
        room: String,
        settings: ClipSettings,
        bitrate: i64,
        landscape: *mut ffi::video_t,
        portrait: *mut ffi::video_t,
    ) -> Result<Self, String> {
        settings.validate()?;
        if settings.output != ClipOutput::Landscape && portrait.is_null() {
            return Err("The vertical canvas is not ready".into());
        }
        // Portrait's raw preview already keeps its video output active. Let
        // that new canvas produce fresh frames before initializing a paired
        // audio/video clock. This runs on later owner ticks, never by sleeping
        // on the engine or starting an encoder against a cold canvas.
        let preparing = (settings.output != ClipOutput::Landscape).then(|| Preparing {
            landscape,
            portrait,
            baseline: ffi::video_output_get_total_frames(portrait),
            bitrate,
        });
        let buffers = if preparing.is_none() {
            Self::start_buffers(&settings, bitrate, landscape, portrait)?
        } else {
            Vec::new()
        };
        Ok(Self {
            room,
            settings,
            started: Instant::now(),
            buffers,
            preparing,
            pending: None,
            error: None,
        })
    }
    unsafe fn start_buffers(
        settings: &ClipSettings,
        bitrate: i64,
        landscape: *mut ffi::video_t,
        portrait: *mut ffi::video_t,
    ) -> Result<Vec<Buffer>, String> {
        let mut buffers = Vec::new();
        let count = if settings.output == ClipOutput::Both {
            2
        } else {
            1
        };
        if settings.output != ClipOutput::Portrait {
            buffers.push(Buffer::start(
                ClipOutput::Landscape,
                settings.seconds,
                settings.memory_mb / count,
                bitrate,
                landscape,
            )?)
        }
        if settings.output != ClipOutput::Landscape {
            buffers.push(Buffer::start(
                ClipOutput::Portrait,
                settings.seconds,
                settings.memory_mb / count,
                bitrate,
                portrait,
            )?)
        }
        Ok(buffers)
    }
    pub fn room(&self) -> &str {
        &self.room
    }
    pub fn portrait(&self) -> bool {
        self.settings.output != ClipOutput::Landscape
    }
    pub fn status(&self) -> ClipStatus {
        ClipStatus {
            enabled: self.error.is_none(),
            saving: self.pending.is_some(),
            room_id: Some(self.room.clone()),
            settings: self.settings.clone(),
            elapsed_seconds: self.started.elapsed().as_secs(),
            video_frames: self.buffers.iter().map(Buffer::frames).min().unwrap_or(0),
            tracks: self.buffers.iter().map(Buffer::status).collect(),
            error: self.error.clone(),
        }
    }
    pub fn save(&mut self, job: &str, directory: &str, reply: mpsc::Sender<Result<Value, String>>) {
        let check = (|| {
            if self.pending.is_some() {
                return Err("A clip is already saving".to_string());
            }
            if let Some(e) = &self.error {
                return Err(e.clone());
            }
            if self.preparing.is_some()
                || self.buffers.is_empty()
                || self.started.elapsed() < Duration::from_secs(2)
                || self.buffers.iter().any(|b| b.frames() == 0)
            {
                return Err("Wait for the first two seconds of rolling capture".into());
            }
            if uuid::Uuid::parse_str(job).is_err()
                || directory.contains('\0')
                || !std::path::Path::new(directory).is_absolute()
            {
                return Err("Invalid clip destination".into());
            }
            Ok(())
        })();
        if let Err(e) = check {
            let _ = reply.send(Err(e));
            return;
        }
        self.pending = Some(Pending {
            reply,
            started: Instant::now(),
        });
        for b in &self.buffers {
            if let Err(e) = unsafe { b.save(job, directory) } {
                self.fail(e);
                break;
            }
        }
    }
    fn fail(&mut self, error: String) {
        self.preparing = None;
        // A partial dual-output failure is not an active capture session.
        // Disconnect both packet streams immediately; keep their owner alive
        // until OBS's asynchronous file writer has drained or the room exits.
        for buffer in &self.buffers {
            unsafe {
                buffer.abort();
            }
        }
        self.error = Some(error.clone());
        if let Some(p) = self.pending.take() {
            let _ = p.reply.send(Err(error));
        }
    }
    pub fn poll(&mut self) {
        if let Some(preparing) = self.preparing.as_ref() {
            let frames = unsafe { ffi::video_output_get_total_frames(preparing.portrait) }
                .wrapping_sub(preparing.baseline);
            if frames < 2 {
                if self.started.elapsed() >= Duration::from_secs(10) {
                    self.fail("The vertical canvas has not produced fresh video. Wait for the room preview, then try capture again.".into());
                }
                return;
            }
            let preparing = self.preparing.take().unwrap();
            match unsafe {
                Self::start_buffers(
                    &self.settings,
                    preparing.bitrate,
                    preparing.landscape,
                    preparing.portrait,
                )
            } {
                Ok(buffers) => {
                    self.buffers = buffers;
                    self.started = Instant::now();
                }
                Err(error) => {
                    self.fail(error);
                    return;
                }
            }
        }
        if self.error.is_none() {
            if let Some(b) = self.buffers.iter().find(|b| b.failed()) {
                self.fail(b.error("Rolling capture stopped unexpectedly"));
                return;
            }
            if self.started.elapsed() >= Duration::from_secs(10) {
                if let Some(b) = self.buffers.iter().find(|b| b.frames() == 0) {
                    let track = b.status();
                    eprintln!("[clips] startup stalled output={:?} input={} skipped={} encoded={} video_active={} audio_active={}", track.output, track.input_frames, track.input_skipped_frames, track.encoded_frames, track.video_active, track.audio_active);
                    self.fail(format!(
                        "{} capture did not receive frames. Stop and try rolling capture again.",
                        if b.kind == ClipOutput::Portrait {
                            "Vertical"
                        } else {
                            "Landscape"
                        }
                    ));
                    return;
                }
            }
        }
        let Some(p) = self.pending.as_ref() else {
            return;
        };
        if self
            .buffers
            .iter()
            .all(|b| b.signals.saved.load(Ordering::Acquire))
        {
            let result = self
                .buffers
                .iter()
                .map(|b| unsafe { b.receipt() })
                .collect::<Result<Vec<_>, _>>()
                .map(|files| json!({"files":files}));
            let p = self.pending.take().unwrap();
            let _ = p.reply.send(result);
        } else if p.started.elapsed() > Duration::from_secs(60) {
            self.fail("The clip writer did not confirm its save. Check the recording folder, then stop and restart rolling capture.".into())
        }
    }
}
impl Drop for Replay {
    fn drop(&mut self) {
        if let Some(p) = self.pending.take() {
            let _=p.reply.send(Err("Rolling capture closed before this save was confirmed. Check the recording folder for a recovered file.".into()));
        }
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires a native graphics engine and recording muxer; run alone"]
    fn native_dual_clips_start_rearm_and_save_without_audio_sources() {
        let temp =
            std::env::temp_dir().join(format!("producer-clips-proof-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        super::super::engine::persist_video(&temp, 720, 30);
        let report = super::super::engine::bootstrap_with_config(&temp);
        assert!(report.ok, "native bootstrap: {report:?}");
        let mut graph = super::super::graph::SceneGraph::create().unwrap();
        graph
            .add_extra(
                "clip-proof",
                "Clips proof",
                &super::super::graph::ExtraSpec::Color {
                    color: "#008877".into(),
                },
            )
            .unwrap();
        // A capture can be closed before its first packet. Replay's normal
        // stop callback waits for another packet, so exercise the terminal
        // stop path before qualifying the longer save/rearm cycles below.
        for output in [ClipOutput::Portrait, ClipOutput::Both] {
            let mut replay = unsafe {
                Replay::start(
                    "early-stop".into(),
                    ClipSettings {
                        seconds: 3,
                        memory_mb: 64,
                        output,
                    },
                    2000,
                    ffi::obs_get_video(),
                    graph.portrait_video().unwrap(),
                )
            }
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(6);
            while replay.buffers.is_empty() {
                replay.poll();
                assert!(replay.error.is_none(), "warmup: {:?}", replay.status());
                assert!(Instant::now() < deadline, "vertical canvas did not warm");
                std::thread::sleep(Duration::from_millis(10));
            }
            let stopping = Instant::now();
            drop(replay);
            assert!(
                stopping.elapsed() < Duration::from_secs(3),
                "early Clips stop waited for a future packet: {output:?}"
            );
        }
        for cycle in 0..2 {
            // No mic, media or artificial tone: an empty program audio mix must
            // still let both encoded outputs start and produce valid files.
            let mut replay = unsafe {
                Replay::start(
                    "proof".into(),
                    ClipSettings {
                        seconds: 3,
                        memory_mb: 64,
                        output: ClipOutput::Both,
                    },
                    2000,
                    ffi::obs_get_video(),
                    graph.portrait_video().unwrap(),
                )
            }
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                replay.poll();
                let status = replay.status();
                assert!(status.error.is_none(), "startup: {status:?}");
                if status.elapsed_seconds >= 2 && status.video_frames > 0 {
                    break;
                }
                assert!(Instant::now() < deadline, "no captured frames: {status:?}");
                std::thread::sleep(Duration::from_millis(50));
            }
            let (tx, rx) = mpsc::channel();
            replay.save(
                &uuid::Uuid::new_v4().to_string(),
                temp.to_str().unwrap(),
                tx,
            );
            let deadline = Instant::now() + Duration::from_secs(12);
            let receipt = loop {
                replay.poll();
                if let Ok(receipt) = rx.try_recv() {
                    break receipt.unwrap();
                }
                assert!(
                    Instant::now() < deadline,
                    "clip save did not finalize: {:?}",
                    replay.status()
                );
                std::thread::sleep(Duration::from_millis(50));
            };
            let files: Vec<ClipFile> = serde_json::from_value(receipt["files"].clone()).unwrap();
            assert_eq!(files.len(), 2);
            drop(replay);
            for file in files {
                crate::recordings::validate_mp4(std::path::Path::new(&file.path)).unwrap();
                let probe = std::process::Command::new("ffprobe")
                    .args([
                        "-v",
                        "error",
                        "-count_frames",
                        "-show_streams",
                        "-of",
                        "json",
                    ])
                    .arg(&file.path)
                    .output()
                    .unwrap();
                assert!(
                    probe.status.success(),
                    "ffprobe: {}",
                    String::from_utf8_lossy(&probe.stderr)
                );
                let probe: Value = serde_json::from_slice(&probe.stdout).unwrap();
                let streams = probe["streams"].as_array().unwrap();
                let video = streams.iter().find(|s| s["codec_type"] == "video").unwrap();
                assert_eq!(video["codec_name"], "h264");
                assert!(
                    video["nb_read_frames"]
                        .as_str()
                        .unwrap()
                        .parse::<u64>()
                        .unwrap()
                        > 20
                );
                assert!(streams
                    .iter()
                    .any(|s| s["codec_type"] == "audio" && s["codec_name"] == "aac"));
                println!(
                    "PASS Clips cycle={cycle} output={:?} decoded_frames={}",
                    file.output, video["nb_read_frames"]
                );
            }
        }
        drop(graph);
    }
}
