//! Isolated diagnostic OBS ingest. Callback arrival stamps are an experiment,
//! not a sender capture clock or production synchronization qualification.
#[path = "../../../src-tauri/src/live/ffi.rs"]
mod ffi;
use anyhow::{bail, ensure, Result};
use std::{
    ffi::{c_void, CStr, CString},
    path::Path,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
extern "C" {
    fn guest_obs_register();
    fn guest_obs_init_main();
    fn guest_obs_pump();
    fn guest_obs_now_ns() -> u64;
    fn guest_obs_thread_count() -> u64;
    fn guest_obs_fd_count() -> u64;
    fn producer_guest_ingest_video(
        source: *mut ffi::obs_source_t,
        y: *const u8,
        y_len: usize,
        u: *const u8,
        u_len: usize,
        v: *const u8,
        v_len: usize,
        width: u32,
        height: u32,
        ys: u32,
        us: u32,
        vs: u32,
        timestamp: u64,
    ) -> bool;
    fn producer_guest_ingest_audio(
        source: *mut ffi::obs_source_t,
        pcm: *const i16,
        sample_count: usize,
        channels: u32,
        timestamp: u64,
    ) -> bool;
    fn obs_source_set_async_unbuffered(source: *mut ffi::obs_source_t, unbuffered: bool);
    fn obs_source_set_async_decoupled(source: *mut ffi::obs_source_t, decoupled: bool);
    fn obs_add_safe_module(name: *const std::ffi::c_char);
    fn obs_output_add_packet_callback(
        output: *mut ffi::obs_output_t,
        callback: PacketCallback,
        param: *mut c_void,
    );
    fn obs_output_remove_packet_callback(
        output: *mut ffi::obs_output_t,
        callback: PacketCallback,
        param: *mut c_void,
    );
    fn obs_encoder_get_priming_samples(encoder: *const ffi::obs_encoder_t) -> u32;
    fn obs_add_raw_audio_callback(
        mix: usize,
        conversion: *const c_void,
        callback: extern "C" fn(*mut c_void, usize, *mut ffi::audio_data),
        param: *mut c_void,
    );
    fn obs_remove_raw_audio_callback(
        mix: usize,
        callback: extern "C" fn(*mut c_void, usize, *mut ffi::audio_data),
        param: *mut c_void,
    );
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
        self.write_interleaved(pcm, 1, at);
    }
    pub fn write_interleaved(&self, pcm: &[i16], channels: u32, at: Instant) {
        assert!((channels == 1 || channels == 2) && pcm.len().is_multiple_of(channels as usize));
        let timestamp =
            self.origin_ns + at.saturating_duration_since(self.origin).as_nanos() as u64;
        unsafe {
            assert!(
                producer_guest_ingest_audio(
                    self.source as *mut ffi::obs_source_t,
                    pcm.as_ptr(),
                    pcm.len(),
                    channels,
                    timestamp,
                ),
                "Invalid native guest PCM submission"
            );
        }
    }
}

// Borrowed output handle: delivery workers must join before Recorder releases it.
#[derive(Clone)]
pub struct VideoWriter {
    source: usize,
    origin: Instant,
    origin_ns: u64,
}
impl VideoWriter {
    pub fn timestamp_base(&self) -> (Instant, u64) {
        (self.origin, self.origin_ns)
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
            assert!(
                producer_guest_ingest_video(
                    self.source as *mut ffi::obs_source_t,
                    planes.0.as_ptr(),
                    planes.0.len(),
                    planes.1.as_ptr(),
                    planes.1.len(),
                    planes.2.as_ptr(),
                    planes.2.len(),
                    width,
                    height,
                    strides.0,
                    strides.1,
                    strides.2,
                    self.origin_ns + at.saturating_duration_since(self.origin).as_nanos() as u64,
                ),
                "Invalid native guest I420 submission"
            );
        }
    }
}

static PIPELINE_PROBES_ALIVE: AtomicU64 = AtomicU64::new(0);
static PIPELINE_PROBES_CREATED: AtomicU64 = AtomicU64::new(0);
static PIPELINE_PROBES_DESTROYED: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Copy, Default)]
struct RawMarker {
    timestamp_ns: u64,
    observed_ns: u64,
}
struct RawVideoState {
    markers: [RawMarker; 64],
    used: usize,
    active: bool,
    overflow: u64,
}
// Pinned public layouts from OBS 32.1.2 libobs/obs-encoder.h.
#[repr(C)]
struct EncoderPacket {
    data: *mut u8,
    size: usize,
    pts: i64,
    dts: i64,
    timebase_num: i32,
    timebase_den: i32,
    kind: i32,
    keyframe: bool,
    dts_usec: i64,
    sys_dts_usec: i64,
    priority: i32,
    drop_priority: i32,
    track_idx: usize,
    encoder: *mut ffi::obs_encoder_t,
}
#[repr(C)]
struct EncoderPacketTime {
    pts: i64,
    cts: u64,
    fer: u64,
    ferc: u64,
    pir: u64,
}
type PacketCallback =
    extern "C" fn(*mut ffi::obs_output_t, *mut EncoderPacket, *mut EncoderPacketTime, *mut c_void);
#[derive(serde::Serialize)]
struct PacketStamp {
    video: bool,
    pts: i64,
    dts: i64,
    timebase_num: i32,
    timebase_den: i32,
    dts_usec: i64,
    sys_dts_usec: i64,
    observed_ns: u64,
    composition_ns: Option<u64>,
    encode_request_ns: Option<u64>,
    encode_complete_ns: Option<u64>,
    interleave_ns: Option<u64>,
}
struct PacketState {
    stamps: Vec<PacketStamp>,
    overflow: u64,
}
struct RawVideoProbe {
    state: Mutex<RawVideoState>,
    audio_state: Mutex<RawVideoState>,
    audio_frames: AtomicU64,
    frames: AtomicU64,
    contention: AtomicU64,
    registered: AtomicBool,
    packet_output: AtomicUsize,
    packet_count: AtomicU64,
    packet_state: Mutex<PacketState>,
}
impl RawVideoProbe {
    fn new() -> Self {
        PIPELINE_PROBES_ALIVE.fetch_add(1, Ordering::Relaxed);
        PIPELINE_PROBES_CREATED.fetch_add(1, Ordering::Relaxed);
        Self {
            state: Mutex::new(RawVideoState {
                markers: [RawMarker::default(); 64],
                used: 0,
                active: false,
                overflow: 0,
            }),
            audio_state: Mutex::new(RawVideoState {
                markers: [RawMarker::default(); 64],
                used: 0,
                active: false,
                overflow: 0,
            }),
            audio_frames: AtomicU64::new(0),
            frames: AtomicU64::new(0),
            contention: AtomicU64::new(0),
            registered: AtomicBool::new(false),
            packet_output: AtomicUsize::new(0),
            packet_count: AtomicU64::new(0),
            packet_state: Mutex::new(PacketState {
                stamps: Vec::with_capacity(8192),
                overflow: 0,
            }),
        }
    }
    fn remove(&self) {
        let output = self.packet_output.swap(0, Ordering::AcqRel);
        if output != 0 {
            unsafe {
                obs_output_remove_packet_callback(
                    output as *mut ffi::obs_output_t,
                    encoded_packet_probe,
                    self as *const Self as *mut c_void,
                );
            }
        }
        if self.registered.swap(false, Ordering::AcqRel) {
            unsafe {
                obs_remove_raw_audio_callback(
                    0,
                    raw_audio_probe,
                    self as *const Self as *mut c_void,
                );
                ffi::obs_remove_raw_video_callback(
                    raw_video_probe,
                    self as *const Self as *mut c_void,
                );
            }
        }
    }
    fn report(&self) -> serde_json::Value {
        let state = self.state.lock().unwrap();
        let audio = self.audio_state.lock().unwrap();
        let packets = self.packet_state.lock().unwrap();
        serde_json::json!({"frames":self.frames.load(Ordering::Relaxed),"contention_dropped":self.contention.load(Ordering::Relaxed),
            "registered":self.registered.load(Ordering::Acquire),"capacity":64,"overflow":state.overflow,
            "audio_frames":self.audio_frames.load(Ordering::Relaxed), "audio_marker_window_ms":10,
            "audio_overflow":audio.overflow,
            "packet_probe":{"capacity":8192,"registered":self.packet_output.load(Ordering::Acquire)!=0,
                "count":self.packet_count.load(Ordering::Relaxed),"overflow":packets.overflow,"stamps":packets.stamps},
            "audio_markers":audio.markers[..audio.used].iter().map(|m|serde_json::json!({"timestamp_ns":m.timestamp_ns,"observed_ns":m.observed_ns})).collect::<Vec<_>>(),
            "markers":state.markers[..state.used].iter().map(|m|serde_json::json!({"timestamp_ns":m.timestamp_ns,"observed_ns":m.observed_ns})).collect::<Vec<_>>()})
    }
}
impl Drop for RawVideoProbe {
    fn drop(&mut self) {
        self.remove();
        PIPELINE_PROBES_ALIVE.fetch_sub(1, Ordering::Relaxed);
        PIPELINE_PROBES_DESTROYED.fetch_add(1, Ordering::Relaxed);
    }
}
extern "C" fn raw_video_probe(param: *mut c_void, frame: *mut ffi::video_data) {
    if param.is_null() || frame.is_null() {
        return;
    }
    // The lab fixes the raw mix to NV12 320x180. Read luma only; retain no frame pointers.
    let (probe, frame) = unsafe { (&*(param as *const RawVideoProbe), &*frame) };
    if frame.data[0].is_null() || frame.linesize[0] < 320 {
        return;
    }
    probe.frames.fetch_add(1, Ordering::Relaxed);
    let Ok(mut state) = probe.state.try_lock() else {
        probe.contention.fetch_add(1, Ordering::Relaxed);
        return;
    };
    let mut sum = 0u64;
    let mut count = 0u64;
    for y in (0..180).step_by(4) {
        for x in (0..320).step_by(4) {
            sum += u64::from(unsafe { *frame.data[0].add(y * frame.linesize[0] as usize + x) });
            count += 1;
        }
    }
    let active = sum / count > 180;
    if active && !state.active {
        if state.used < 64 {
            let slot = state.used;
            state.markers[slot] = RawMarker {
                timestamp_ns: frame.timestamp,
                observed_ns: unsafe { guest_obs_now_ns() },
            };
            state.used += 1;
        } else {
            state.overflow += 1;
        }
    }
    state.active = active;
}
// OBS's lab mix is float planar, 48 kHz stereo. Observe plane zero in bounded
// 10 ms windows; copy only marker timestamps and never retain the audio pointer.
extern "C" fn raw_audio_probe(param: *mut c_void, mix: usize, data: *mut ffi::audio_data) {
    if param.is_null() || data.is_null() || mix != 0 {
        return;
    }
    let (probe, data) = unsafe { (&*(param as *const RawVideoProbe), &*data) };
    if data.data[0].is_null() || data.frames > 4096 {
        return;
    }
    probe.audio_frames.fetch_add(1, Ordering::Relaxed);
    let Ok(mut state) = probe.audio_state.try_lock() else {
        probe.contention.fetch_add(1, Ordering::Relaxed);
        return;
    };
    let samples =
        unsafe { std::slice::from_raw_parts(data.data[0] as *const f32, data.frames as usize) };
    for (index, window) in samples.chunks(480).enumerate() {
        let rms = (window.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>() / window.len() as f64)
            .sqrt();
        let active = rms > 2000.0 / 32768.0;
        if active && !state.active {
            if state.used < 64 {
                let slot = state.used;
                state.markers[slot] = RawMarker {
                    timestamp_ns: data.timestamp + (index * 480) as u64 * 1_000_000_000 / 48000,
                    observed_ns: unsafe { guest_obs_now_ns() },
                };
                state.used += 1;
            } else {
                state.overflow += 1;
            }
        }
        state.active = active;
    }
}
// Synchronous pre-mux callback: copy bounded timestamp metadata only. No packet
// payloads are retained or modified; the OBS output pointer is a non-owning edge.
extern "C" fn encoded_packet_probe(
    _output: *mut ffi::obs_output_t,
    packet: *mut EncoderPacket,
    time: *mut EncoderPacketTime,
    param: *mut c_void,
) {
    if packet.is_null() || param.is_null() {
        return;
    }
    let (probe, packet) = unsafe { (&*(param as *const RawVideoProbe), &*packet) };
    probe.packet_count.fetch_add(1, Ordering::Relaxed);
    let Ok(mut state) = probe.packet_state.try_lock() else {
        probe.contention.fetch_add(1, Ordering::Relaxed);
        return;
    };
    if state.stamps.len() == 8192 {
        state.overflow += 1;
        return;
    }
    let time = unsafe { time.as_ref() };
    state.stamps.push(PacketStamp {
        video: packet.kind == 1,
        pts: packet.pts,
        dts: packet.dts,
        timebase_num: packet.timebase_num,
        timebase_den: packet.timebase_den,
        dts_usec: packet.dts_usec,
        sys_dts_usec: packet.sys_dts_usec,
        observed_ns: unsafe { guest_obs_now_ns() },
        composition_ns: time.map(|t| t.cts),
        encode_request_ns: time.map(|t| t.fer),
        encode_complete_ns: time.map(|t| t.ferc),
        interleave_ns: time.map(|t| t.pir),
    });
}
pub fn pipeline_probe_lifecycle() -> serde_json::Value {
    serde_json::json!({"alive":PIPELINE_PROBES_ALIVE.load(Ordering::Relaxed),"created":PIPELINE_PROBES_CREATED.load(Ordering::Relaxed),"destroyed":PIPELINE_PROBES_DESTROYED.load(Ordering::Relaxed)})
}

pub struct Recorder {
    source: *mut ffi::obs_source_t,
    output: *mut ffi::obs_output_t,
    video_encoder: *mut ffi::obs_encoder_t,
    audio_encoder: *mut ffi::obs_encoder_t,
    audio_priming_samples: u32,
    finalized_mp4: bool,
    origin: Instant,
    origin_ns: u64,
    stop: Box<Stop>,
    initialized: bool,
    raw_probe: Option<Box<RawVideoProbe>>,
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
            audio_priming_samples: 0,
            finalized_mp4: std::env::var("LIVEKIT_LAB_OBS_FINALIZED_MP4").as_deref() == Ok("1"),
            origin: Instant::now(),
            origin_ns: 0,
            stop: Box::new(Stop {
                done: AtomicBool::new(false),
                code: AtomicI64::new(i64::MIN),
            }),
            initialized: false,
            raw_probe: (std::env::var("LIVEKIT_LAB_OBS_PIPELINE_PROBE").as_deref() == Ok("1"))
                .then(|| Box::new(RawVideoProbe::new())),
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
                c("producer_guest_ingest").as_ptr(),
                c("Guest proof").as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
            );
            ensure!(!r.source.is_null(), "Guest source registration failed");
            if std::env::var("LIVEKIT_LAB_OBS_UNBUFFERED").as_deref() == Ok("1") {
                obs_source_set_async_unbuffered(r.source, true);
            }
            if std::env::var("LIVEKIT_LAB_SCHEDULE_HANDOFF").as_deref() == Ok("1") {
                obs_source_set_async_decoupled(r.source, true);
                obs_source_set_async_unbuffered(r.source, true);
            }
            ffi::obs_source_set_audio_mixers(r.source, 1);
            ffi::obs_set_output_source(0, r.source);
            if let Some(probe) = &r.raw_probe {
                ffi::obs_add_raw_video_callback(
                    ptr::null(),
                    raw_video_probe,
                    &**probe as *const RawVideoProbe as *mut c_void,
                );
                obs_add_raw_audio_callback(
                    0,
                    ptr::null(),
                    raw_audio_probe,
                    &**probe as *const RawVideoProbe as *mut c_void,
                );
                probe.registered.store(true, Ordering::Release);
            }
            if std::env::var("LIVEKIT_LAB_OBS_FAIL_AFTER_PROBE").as_deref() == Ok("1") {
                bail!("Injected lab failure after raw callback registration");
            }
            r.origin = Instant::now();
            r.origin_ns = guest_obs_now_ns();
            let y = vec![16u8; 320 * 180];
            let uv = vec![128u8; 160 * 90];
            ensure!(
                producer_guest_ingest_video(
                    r.source,
                    y.as_ptr(),
                    y.len(),
                    uv.as_ptr(),
                    uv.len(),
                    uv.as_ptr(),
                    uv.len(),
                    320,
                    180,
                    320,
                    160,
                    160,
                    r.origin_ns,
                ),
                "Native guest initial frame rejected"
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
                c(if r.finalized_mp4 {
                    "movflags=faststart"
                } else {
                    "movflags=frag_keyframe+empty_moov+default_base_moof"
                })
                .as_ptr(),
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
            if let Some(probe) = &r.raw_probe {
                obs_output_add_packet_callback(
                    r.output,
                    encoded_packet_probe,
                    &**probe as *const RawVideoProbe as *mut c_void,
                );
                probe
                    .packet_output
                    .store(r.output as usize, Ordering::Release);
                if std::env::var("LIVEKIT_LAB_OBS_FAIL_AFTER_PACKET_PROBE").as_deref() == Ok("1") {
                    bail!("Injected lab failure after packet callback registration");
                }
            }
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
            // Stop destroys encoder context data; query padding while active.
            r.audio_priming_samples = obs_encoder_get_priming_samples(r.audio_encoder);
        }
        Ok(r)
    }
    pub fn timestamp(&self, at: Instant) -> u64 {
        self.origin_ns + at.saturating_duration_since(self.origin).as_nanos() as u64
    }
    pub fn audio_writer(&self) -> AudioWriter {
        AudioWriter {
            source: self.source as usize,
            origin: self.origin,
            origin_ns: self.origin_ns,
        }
    }
    pub fn video_writer(&self) -> VideoWriter {
        VideoWriter {
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
        self.video_writer()
            .video(planes, width, height, strides, at);
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
        let raw_probe = if let Some(probe) = &self.raw_probe {
            probe.remove();
            let before = (
                probe.frames.load(Ordering::Acquire),
                probe.audio_frames.load(Ordering::Acquire),
                probe.packet_count.load(Ordering::Acquire),
            );
            for _ in 0..5 {
                self.pump();
                std::thread::sleep(Duration::from_millis(10));
            }
            let after = (
                probe.frames.load(Ordering::Acquire),
                probe.audio_frames.load(Ordering::Acquire),
                probe.packet_count.load(Ordering::Acquire),
            );
            ensure!(
                before == after,
                "Raw media callback remained active after unregister"
            );
            let mut report = probe.report();
            report["callbacks_quiescent_after_unregister"] = serde_json::json!(true);
            Some(report)
        } else {
            None
        };
        Ok(
            serde_json::json!({"raw_video_pipeline_probe":raw_probe,"audio_priming_samples":self.audio_priming_samples,"container_mode":if self.finalized_mp4 {"finalized-comparison"}else{"fragmented-default"},"stop_code":code,"frames":unsafe {ffi::obs_output_get_total_frames(self.output)},
            "clock":if std::env::var("LIVEKIT_LAB_AUDIO_MASTER").as_deref() == Ok("1") {
                "shared OBS monotonic anchor + continuous decoded audio sample timeline; sender-relative video mapping unqualified"
            } else { "shared OBS monotonic anchor + callback Instant elapsed; sender clock unqualified" },
            "recorded_av_analyzed":false,"async_video_unbuffered":std::env::var("LIVEKIT_LAB_OBS_UNBUFFERED").as_deref() == Ok("1") || std::env::var("LIVEKIT_LAB_SCHEDULE_HANDOFF").as_deref() == Ok("1"),"qualified":false}),
        )
    }
}
impl Drop for Recorder {
    fn drop(&mut self) {
        if let Some(probe) = &self.raw_probe {
            probe.remove();
        }
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

/// Real OBS success and cancellation workload; no camera, SFU or speaker output.
pub fn lifecycle(output: &Path) -> Result<()> {
    std::env::set_var("LIVEKIT_LAB_OBS_PIPELINE_PROBE", "1");
    let root = Path::new("runtime");
    std::fs::create_dir_all(root)?;
    let initial = (unsafe { guest_obs_thread_count() }, unsafe {
        guest_obs_fd_count()
    });
    ensure!(
        initial.0 != u64::MAX && initial.1 != u64::MAX,
        "Thread/FD probe unavailable"
    );
    let mut warm = None;
    let mut reports = Vec::new();
    for cycle in 0..4 {
        let path = root.join(format!("pipeline-lifecycle-{cycle}-{}.mp4", unsafe {
            guest_obs_now_ns()
        }));
        let recorder = Recorder::start(&path)?;
        let began = Instant::now();
        let white = [235u8; 320 * 180];
        let uv = [128u8; 160 * 90];
        let pcm = [0i16; 480];
        while began.elapsed() < Duration::from_millis(350) {
            recorder.video(
                (&white, &uv, &uv),
                320,
                180,
                (320, 160, 160),
                Instant::now(),
            );
            recorder.audio_writer().write(&pcm, Instant::now());
            recorder.pump();
            std::thread::sleep(Duration::from_millis(10));
        }
        let result = if cycle == 3 {
            None
        } else {
            Some(recorder.finish()?)
        };
        drop(recorder); // The fourth cycle cancels through Drop while output is active.
        for _ in 0..10 {
            pump_main();
            std::thread::sleep(Duration::from_millis(10));
        }
        let current = (unsafe { guest_obs_thread_count() }, unsafe {
            guest_obs_fd_count()
        });
        ensure!(
            current.0 != u64::MAX && current.1 != u64::MAX,
            "Thread/FD probe unavailable"
        );
        if let Some((threads, fds)) = warm {
            ensure!(
                current.0 <= threads + 2 && current.1 <= fds + 2,
                "OBS callback lifecycle thread/FD growth"
            );
        } else {
            warm = Some(current);
        }
        let counters = pipeline_probe_lifecycle();
        ensure!(
            counters["alive"] == 0 && counters["created"] == counters["destroyed"],
            "Raw callback observer retained"
        );
        reports.push(serde_json::json!({"cycle":cycle,"cancelled":cycle==3,"recording":path.file_name().unwrap().to_string_lossy(),
            "threads_after_shutdown":current.0,"fds_after_shutdown":current.1,"probe_lifecycle":counters,"finish":result}));
    }
    std::env::set_var("LIVEKIT_LAB_OBS_FAIL_AFTER_PACKET_PROBE", "1");
    let partial = Recorder::start(&root.join(format!("partial-init-{}.mp4", unsafe {
        guest_obs_now_ns()
    })));
    std::env::remove_var("LIVEKIT_LAB_OBS_FAIL_AFTER_PACKET_PROBE");
    ensure!(
        partial.is_err(),
        "Partial-initialization fault was not injected"
    );
    for _ in 0..10 {
        pump_main();
        std::thread::sleep(Duration::from_millis(10));
    }
    let partial_counts = (unsafe { guest_obs_thread_count() }, unsafe {
        guest_obs_fd_count()
    });
    let partial_lifecycle = pipeline_probe_lifecycle();
    ensure!(
        partial_counts.0 <= warm.unwrap().0 + 2 && partial_counts.1 <= warm.unwrap().1 + 2,
        "Partial initialization retained thread/FD resources"
    );
    ensure!(
        partial_lifecycle["alive"] == 0
            && partial_lifecycle["created"] == partial_lifecycle["destroyed"],
        "Partial initialization retained callback observer"
    );
    std::fs::write(
        output,
        serde_json::to_vec_pretty(
            &serde_json::json!({"cycles":reports,"initial_threads":initial.0,
        "initial_fds":initial.1,"warm_threads":warm.unwrap().0,"warm_fds":warm.unwrap().1,
        "hardware_capture":false,"speaker_playout":false,"success_and_drop_cancellation":true,
        "partial_initialization":{"injected_after_callback_registration":true,"injected_after_packet_callback_registration":true,
            "probe_lifecycle":partial_lifecycle,"threads_after_shutdown":partial_counts.0,"fds_after_shutdown":partial_counts.1}}),
        )?,
    )?;
    Ok(())
}
