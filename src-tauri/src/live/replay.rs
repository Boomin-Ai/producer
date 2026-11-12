//! Opt-in encoded replay buffers. All lifecycle calls stay on the engine owner.
//! OBS writes saves asynchronously; callbacks only publish atomic receipts.
use super::{encoders, ffi};
use crate::clips::{ClipFile, ClipOutput, ClipSettings, ClipStatus};
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
    fn failed(&self) -> bool {
        self.signals.stop.load(Ordering::Acquire) != i64::MIN
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
            // Force-stop disconnects the encoded packet callback before memory is freed.
            // OBS release joins its save writer; the atomic callback box outlives release.
            let handler = ffi::obs_output_get_signal_handler(self.output);
            let data = (&*self.signals as *const Signals).cast_mut().cast();
            ffi::signal_handler_disconnect(handler, c("saved").as_ptr(), saved, data);
            ffi::signal_handler_disconnect(handler, c("stop").as_ptr(), stopped, data);
            if ffi::obs_output_active(self.output) {
                ffi::obs_output_force_stop(self.output);
            }
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
pub struct Replay {
    room: String,
    settings: ClipSettings,
    started: Instant,
    buffers: Vec<Buffer>,
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
        Ok(Self {
            room,
            settings,
            started: Instant::now(),
            buffers,
            pending: None,
            error: None,
        })
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
            if self.started.elapsed() < Duration::from_secs(2)
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
        // A partial dual-output failure is not an active capture session.
        // Disconnect both packet streams immediately; keep their owner alive
        // until OBS's asynchronous file writer has drained or the room exits.
        for buffer in &self.buffers {
            unsafe {
                if ffi::obs_output_active(buffer.output) {
                    ffi::obs_output_force_stop(buffer.output);
                }
            }
        }
        self.error = Some(error.clone());
        if let Some(p) = self.pending.take() {
            let _ = p.reply.send(Err(error));
        }
    }
    pub fn poll(&mut self) {
        if self.error.is_none() {
            if let Some(b) = self.buffers.iter().find(|b| b.failed()) {
                self.fail(b.error("Rolling capture stopped unexpectedly"));
                return;
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
