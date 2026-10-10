//! Isolated diagnostic OBS ingest. Callback arrival stamps are an experiment,
//! not a sender capture clock or production synchronization qualification.
#[path = "../../../src-tauri/src/live/ffi.rs"]
mod ffi;
use anyhow::{bail, ensure, Result};
use std::{
    ffi::{c_void, CStr, CString},
    path::Path,
    ptr,
    sync::atomic::{AtomicBool, AtomicI64, Ordering},
    time::{Duration, Instant},
};
extern "C" {
    fn guest_obs_register();
    fn guest_obs_init_main();
    fn guest_obs_pump();
    fn guest_obs_now_ns() -> u64;
    fn guest_obs_video(
        source: *mut ffi::obs_source_t,
        y: *const u8,
        u: *const u8,
        v: *const u8,
        width: u32,
        height: u32,
        ys: u32,
        us: u32,
        vs: u32,
        timestamp: u64,
    );
    fn guest_obs_audio(
        source: *mut ffi::obs_source_t,
        pcm: *const i16,
        samples: u32,
        timestamp: u64,
    );
    fn obs_source_set_async_unbuffered(source: *mut ffi::obs_source_t, unbuffered: bool);
    fn obs_add_safe_module(name: *const std::ffi::c_char);
}
pub fn init_main() {
    unsafe {
        guest_obs_init_main();
    }
}
pub fn pump_main() {
    unsafe {
        guest_obs_pump();
    }
}
fn c(s: &str) -> CString {
    CString::new(s).expect("fixed lab string")
}
struct Stop {
    done: AtomicBool,
    code: AtomicI64,
}
extern "C" fn stopped(data: *mut c_void, call: *mut ffi::calldata_t) {
    unsafe {
        let stop = &*(data as *const Stop);
        let mut code = -1i64;
        ffi::calldata_get_data(
            call,
            c("code").as_ptr(),
            &mut code as *mut i64 as *mut c_void,
            8,
        );
        stop.code.store(code, Ordering::Relaxed);
        stop.done.store(true, Ordering::Release);
    }
}
// OBS's source audio output API accepts calls from the source's capture thread.
// AudioTap joins its worker before Recorder releases this source.
#[derive(Clone)]
pub struct AudioWriter {
    source: usize,
    origin: Instant,
    origin_ns: u64,
}
impl AudioWriter {
    pub fn write(&self, pcm: &[i16], at: Instant) {
        let timestamp =
            self.origin_ns + at.saturating_duration_since(self.origin).as_nanos() as u64;
        unsafe {
            guest_obs_audio(
                self.source as *mut ffi::obs_source_t,
                pcm.as_ptr(),
                pcm.len() as u32,
                timestamp,
            );
        }
    }
}

pub struct Recorder {
    source: *mut ffi::obs_source_t,
    output: *mut ffi::obs_output_t,
    video_encoder: *mut ffi::obs_encoder_t,
    audio_encoder: *mut ffi::obs_encoder_t,
    origin: Instant,
    origin_ns: u64,
    stop: Box<Stop>,
    initialized: bool,
}
impl Recorder {
    pub fn start(path: &Path) -> Result<Self> {
        ensure!(
            !path.exists(),
            "OBS proof file already exists; choose a new lab filename"
        );
        ensure!(
            path.parent().is_some_and(|p| p.ends_with("runtime")),
            "Record only into the lab runtime directory"
        );
        let mut r = Self {
            source: ptr::null_mut(),
            output: ptr::null_mut(),
            video_encoder: ptr::null_mut(),
            audio_encoder: ptr::null_mut(),
            origin: Instant::now(),
            origin_ns: 0,
            stop: Box::new(Stop {
                done: AtomicBool::new(false),
                code: AtomicI64::new(i64::MIN),
            }),
            initialized: false,
        };
        unsafe {
            ensure!(
                ffi::obs_startup(c("en-US").as_ptr(), ptr::null(), ptr::null_mut()),
                "OBS startup failed"
            );
            r.initialized = true;
            let version = CStr::from_ptr(ffi::obs_get_version_string()).to_string_lossy();
            ensure!(
                version.starts_with("32.1.2"),
                "Unqualified OBS ABI: {version}"
            );
            guest_obs_register();
            for module in ["obs-ffmpeg", "obs-x264", "coreaudio-encoder"] {
                obs_add_safe_module(c(module).as_ptr());
            }
            ffi::obs_add_module_path(c("/Applications/Producer.app/Contents/PlugIns/%module%.plugin/Contents/MacOS").as_ptr(),
                c("/Applications/Producer.app/Contents/PlugIns/%module%.plugin/Contents/Resources").as_ptr());
            let mut video = ffi::obs_video_info {
                graphics_module: ptr::null(),
                fps_num: 30,
                fps_den: 1,
                base_width: 320,
                base_height: 180,
                output_width: 320,
                output_height: 180,
                output_format: ffi::VIDEO_FORMAT_NV12,
                adapter: 0,
                gpu_conversion: true,
                colorspace: ffi::VIDEO_CS_709,
                range: ffi::VIDEO_RANGE_PARTIAL,
                scale_type: ffi::OBS_SCALE_BILINEAR,
            };
            let graphics = c("libobs-metal.dylib");
            video.graphics_module = graphics.as_ptr();
            ensure!(
                ffi::obs_reset_video(&mut video) == 0,
                "OBS video reset failed"
            );
            ffi::obs_set_video_levels(300.0, 1000.0);
            ensure!(
                ffi::obs_reset_audio(&ffi::obs_audio_info {
                    samples_per_sec: 48000,
                    speakers: ffi::SPEAKERS_STEREO
                }),
                "OBS audio reset failed"
            );
            let mut failed = ffi::obs_module_failure_info {
                failed_modules: ptr::null_mut(),
                count: 0,
            };
            ffi::obs_load_all_modules2(&mut failed);
            ffi::obs_module_failure_info_free(&mut failed);
            ffi::obs_post_load_modules();
            r.source = ffi::obs_source_create(
                c("producer_guest_timing_proof").as_ptr(),
                c("Guest proof").as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
            );
            ensure!(!r.source.is_null(), "Guest source registration failed");
            if std::env::var("LIVEKIT_LAB_OBS_UNBUFFERED").as_deref() == Ok("1") {
                obs_source_set_async_unbuffered(r.source, true);
            }
            ffi::obs_source_set_audio_mixers(r.source, 1);
            ffi::obs_set_output_source(0, r.source);
            r.origin = Instant::now();
            r.origin_ns = guest_obs_now_ns();
            let y = vec![16u8; 320 * 180];
            let uv = vec![128u8; 160 * 90];
            guest_obs_video(
                r.source,
                y.as_ptr(),
                uv.as_ptr(),
                uv.as_ptr(),
                320,
                180,
                320,
                160,
                160,
                r.origin_ns,
            );
            let settings = ffi::obs_data_create();
            ffi::obs_data_set_int(settings, c("bitrate").as_ptr(), 1000);
            ffi::obs_data_set_string(settings, c("preset").as_ptr(), c("ultrafast").as_ptr());
            ffi::obs_data_set_int(settings, c("keyint_sec").as_ptr(), 1);
            r.video_encoder = ffi::obs_video_encoder_create(
                c("obs_x264").as_ptr(),
                c("Guest proof H264").as_ptr(),
                settings,
                ptr::null_mut(),
            );
            ffi::obs_data_release(settings);
            let settings = ffi::obs_data_create();
            ffi::obs_data_set_int(settings, c("bitrate").as_ptr(), 128);
            r.audio_encoder = ffi::obs_audio_encoder_create(
                c("ffmpeg_aac").as_ptr(),
                c("Guest proof AAC").as_ptr(),
                settings,
                0,
                ptr::null_mut(),
            );
            ffi::obs_data_release(settings);
            ensure!(
                !r.video_encoder.is_null() && !r.audio_encoder.is_null(),
                "OBS proof encoder creation failed"
            );
            ffi::obs_encoder_set_video(r.video_encoder, ffi::obs_get_video());
            ffi::obs_encoder_set_audio(r.audio_encoder, ffi::obs_get_audio());
            let settings = ffi::obs_data_create();
            ffi::obs_data_set_string(
                settings,
                c("path").as_ptr(),
                c(&path.to_string_lossy()).as_ptr(),
            );
            ffi::obs_data_set_string(
                settings,
                c("muxer_settings").as_ptr(),
                c("movflags=frag_keyframe+empty_moov+default_base_moof").as_ptr(),
            );
            r.output = ffi::obs_output_create(
                c("ffmpeg_muxer").as_ptr(),
                c("Guest proof recording").as_ptr(),
                settings,
                ptr::null_mut(),
            );
            ffi::obs_data_release(settings);
            ensure!(!r.output.is_null(), "OBS proof muxer creation failed");
            ffi::obs_output_set_video_encoder(r.output, r.video_encoder);
            ffi::obs_output_set_audio_encoder(r.output, r.audio_encoder, 0);
            ffi::signal_handler_connect(
                ffi::obs_output_get_signal_handler(r.output),
                c("stop").as_ptr(),
                stopped,
                &*r.stop as *const Stop as *mut c_void,
            );
            ensure!(
                ffi::obs_output_start(r.output),
                "OBS proof recording failed to start"
            );
        }
        Ok(r)
    }
    fn timestamp(&self, at: Instant) -> u64 {
        self.origin_ns + at.saturating_duration_since(self.origin).as_nanos() as u64
    }
    pub fn audio_writer(&self) -> AudioWriter {
        AudioWriter {
            source: self.source as usize,
            origin: self.origin,
            origin_ns: self.origin_ns,
        }
    }
    pub fn video(
        &self,
        planes: (&[u8], &[u8], &[u8]),
        width: u32,
        height: u32,
        strides: (u32, u32, u32),
        at: Instant,
    ) {
        unsafe {
            guest_obs_video(
                self.source,
                planes.0.as_ptr(),
                planes.1.as_ptr(),
                planes.2.as_ptr(),
                width,
                height,
                strides.0,
                strides.1,
                strides.2,
                self.timestamp(at),
            );
        }
    }
    pub fn pump(&self) {
        unsafe {
            guest_obs_pump();
        }
    }
    pub fn finish(&self) -> Result<serde_json::Value> {
        unsafe {
            ffi::obs_output_stop(self.output);
        }
        let began = Instant::now();
        while !self.stop.done.load(Ordering::Acquire) && began.elapsed() < Duration::from_secs(10) {
            self.pump();
            std::thread::sleep(Duration::from_millis(10));
        }
        if !self.stop.done.load(Ordering::Acquire) {
            bail!("OBS muxer stop timed out");
        }
        let code = self.stop.code.load(Ordering::Relaxed);
        ensure!(code == 0, "OBS stop code {code}");
        Ok(
            serde_json::json!({"stop_code":code,"frames":unsafe {ffi::obs_output_get_total_frames(self.output)},
            "clock":"shared OBS monotonic anchor + callback Instant elapsed; sender clock unqualified",
            "recorded_av_analyzed":false,"async_video_unbuffered":std::env::var("LIVEKIT_LAB_OBS_UNBUFFERED").as_deref() == Ok("1"),"qualified":false}),
        )
    }
}
impl Drop for Recorder {
    fn drop(&mut self) {
        unsafe {
            if !self.output.is_null() {
                if ffi::obs_output_active(self.output) {
                    let _ = self.finish();
                }
                ffi::obs_output_release(self.output);
            }
            if !self.video_encoder.is_null() {
                ffi::obs_encoder_release(self.video_encoder);
            }
            if !self.audio_encoder.is_null() {
                ffi::obs_encoder_release(self.audio_encoder);
            }
            if self.initialized {
                ffi::obs_set_output_source(0, ptr::null_mut());
            }
            if !self.source.is_null() {
                ffi::obs_source_release(self.source);
            }
            if self.initialized {
                ffi::obs_shutdown();
            }
        }
    }
}
