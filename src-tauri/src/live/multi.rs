//! Multistream session: N simultaneous RTMP pushes from ONE shared encoder
//! pair, configured via the D2 policy intersection BEFORE start — never a
//! hardcoded common bitrate, and no service ever mutates a live shared
//! encoder. Kick is the F7 product template: a named destination over
//! rtmp_custom, ~20 lines of config, not an integration.
//!
//! M-L5 shape: `Session` is owned and pumped by the LiveEngine thread
//! (engine.rs). obs_output signals publish immutable events into the
//! session's channel (§5.1); the session does no file or IPC I/O itself.

use std::ffi::{CStr, CString};
use std::os::raw::{c_int, c_void};
use std::ptr;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{creds, ffi};

const VT_H264_HW: &str = "com.apple.videotoolbox.videoencoder.ave.avc";
const MAX_STREAM_SECS: u64 = 12 * 60 * 60; // backstop only; UI/harness stop explicitly
const BASE_VIDEO_KBPS: i64 = 4500;
const BASE_AUDIO_KBPS: i64 = 160;

/// The base video bitrate the policy intersection starts from, keyed by the
/// canvas libobs is actually running. 720p/1080p keep the 4500 kbps every
/// service accepts; 2160p starts at 20000 (30fps) / 30000 (60fps) and lets
/// each destination's service policy cap it down (D2) — never a hardcoded
/// common bitrate, still.
fn base_video_kbps(height: u32, fps: i32) -> i64 {
    match height {
        2160 if fps >= 60 => 30000,
        2160 => 20000,
        _ => BASE_VIDEO_KBPS,
    }
}

/// The canvas libobs is running right now: (output height, fps). Falls back
/// to 720p30 if video was never reset — the engine's own boot default.
unsafe fn current_canvas() -> (u32, i32) {
    let mut ovi: std::mem::MaybeUninit<ffi::obs_video_info> = std::mem::MaybeUninit::zeroed();
    if ffi::obs_get_video_info(ovi.as_mut_ptr()) {
        let ovi = ovi.assume_init();
        let fps = if ovi.fps_den > 0 {
            (ovi.fps_num / ovi.fps_den) as i32
        } else {
            30
        };
        (ovi.output_height, fps.max(1))
    } else {
        (720, 30)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DestinationSpec {
    pub id: String,
    /// "twitch" | "youtube" | "kick" | "custom"
    pub kind: String,
    pub credential_id: String,
    /// Required for kick/custom: the ingest URL.
    #[serde(default)]
    pub server: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MultiConfig {
    pub destinations: Vec<DestinationSpec>,
}

/// The Kick destination template (F7): Kick's docs point OBS users at
/// Custom RTMP with an IVS ingest URL. Normalize what users paste.
pub fn normalize_kick_server(url: &str) -> Result<String, String> {
    let mut s = url.trim().trim_end_matches('/').to_string();
    if !(s.starts_with("rtmps://") || s.starts_with("rtmp://")) {
        return Err(format!("kick server must be rtmp(s)://…, got {s}"));
    }
    if !s.ends_with("/app") {
        s.push_str("/app");
    }
    Ok(s)
}

/// Transport-level phase. `Live` means the RTMP session is up and accepting
/// bytes — it is NOT platform confirmation (M-L4 finding: YouTube blackholes
/// an ESTABLISHED session after a key reset). UI copy must say "Sending".
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Connecting,
    Live,
    Reconnecting,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
pub struct DestStatus {
    pub id: String,
    pub phase: Phase,
    pub active: bool,
    pub total_frames: i32,
    pub dropped_frames: i32,
    pub bytes_sent: u64,
    pub congestion: f32,
    pub reconnects: u32,
    pub went_live_at_secs: Option<f64>,
    pub stop_code: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PolicyReadout {
    pub id: String,
    pub applied_video_kbps: i64,
    pub applied_audio_kbps: i64,
    pub max_video_kbps: i32,
    pub max_audio_kbps: i32,
    pub max_fps: i32,
    pub video_codecs: Vec<String>,
    pub resolution_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct MultiReport {
    pub ok: bool,
    pub encoder_used: String,
    pub rate_control: String,
    pub shared_video_kbps: i64,
    pub shared_audio_kbps: i64,
    pub policy: Vec<PolicyReadout>,
    pub destinations: Vec<DestStatus>,
    pub streamed_secs: f64,
    pub events: Vec<String>,
    pub notes: Vec<String>,
}

impl MultiReport {
    pub fn failed(notes: Vec<String>) -> Self {
        MultiReport {
            ok: false,
            encoder_used: String::new(),
            rate_control: "CBR".into(),
            shared_video_kbps: 0,
            shared_audio_kbps: 0,
            policy: Vec::new(),
            destinations: Vec::new(),
            streamed_secs: 0.0,
            events: Vec::new(),
            notes,
        }
    }
}

enum Ev {
    Start(usize),
    Stop(usize, i64),
    Reconnect(usize),
    ReconnectSuccess(usize),
}

static EVENT_TX: Mutex<Option<Sender<Ev>>> = Mutex::new(None);

fn emit(ev: Ev) {
    if let Ok(g) = EVENT_TX.lock() {
        if let Some(tx) = g.as_ref() {
            let _ = tx.send(ev);
        }
    }
}

extern "C" fn on_start(data: *mut c_void, _cd: *mut ffi::calldata_t) {
    emit(Ev::Start(data as usize));
}
extern "C" fn on_stop(data: *mut c_void, cd: *mut ffi::calldata_t) {
    let mut code: i64 = -1;
    let name = CString::new("code").unwrap();
    unsafe {
        ffi::calldata_get_data(cd, name.as_ptr(), &mut code as *mut i64 as *mut c_void, 8);
    }
    emit(Ev::Stop(data as usize, code));
}
extern "C" fn on_reconnect(data: *mut c_void, _cd: *mut ffi::calldata_t) {
    emit(Ev::Reconnect(data as usize));
}
extern "C" fn on_reconnect_success(data: *mut c_void, _cd: *mut ffi::calldata_t) {
    emit(Ev::ReconnectSuccess(data as usize));
}

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap()
}

struct DestRuntime {
    spec: DestinationSpec,
    service: *mut ffi::obs_service_t,
    output: *mut ffi::obs_output_t,
    secret: String,
    status: DestStatus,
}

unsafe fn create_service(
    spec: &DestinationSpec,
    secret: &str,
) -> Result<*mut ffi::obs_service_t, String> {
    let settings = ffi::obs_data_create();
    let k_key = cstr("key");
    let v_key = cstr(secret);
    ffi::obs_data_set_string(settings, k_key.as_ptr(), v_key.as_ptr());
    let service_id = match spec.kind.as_str() {
        "twitch" => {
            ffi::obs_data_set_string(settings, cstr("service").as_ptr(), cstr("Twitch").as_ptr());
            ffi::obs_data_set_string(settings, cstr("server").as_ptr(), cstr("auto").as_ptr());
            "rtmp_common"
        }
        "youtube" => {
            ffi::obs_data_set_string(
                settings,
                cstr("service").as_ptr(),
                cstr("YouTube - RTMPS").as_ptr(),
            );
            ffi::obs_data_set_string(
                settings,
                cstr("server").as_ptr(),
                cstr("rtmps://a.rtmps.youtube.com:443/live2").as_ptr(),
            );
            "rtmp_common"
        }
        "kick" | "custom" => {
            let raw = spec
                .server
                .as_deref()
                .ok_or("kick/custom destination needs a server URL")?;
            let server = if spec.kind == "kick" {
                normalize_kick_server(raw)?
            } else {
                raw.trim().to_string()
            };
            ffi::obs_data_set_string(settings, cstr("server").as_ptr(), cstr(&server).as_ptr());
            "rtmp_custom"
        }
        other => return Err(format!("unknown destination kind {other}")),
    };
    let service = ffi::obs_service_create(
        cstr(service_id).as_ptr(),
        cstr(&format!("svc-{}", spec.id)).as_ptr(),
        settings,
        ptr::null_mut(),
    );
    ffi::obs_data_release(settings);
    if service.is_null() {
        return Err(format!("obs_service_create failed for {}", spec.id));
    }
    Ok(service)
}

/// D2: run every destination's service policy over a fresh copy of the base
/// encoder settings, read the caps (F12), fold into the shared intersection.
unsafe fn policy_intersection(
    dests: &[DestRuntime],
    base_video_kbps: i64,
    fps: i32,
    notes: &mut Vec<String>,
) -> Result<(i64, i64, Vec<PolicyReadout>), String> {
    let mut video_kbps = base_video_kbps;
    let mut audio_kbps = BASE_AUDIO_KBPS;
    let mut readouts = Vec::new();

    for d in dests {
        let v = ffi::obs_data_create();
        ffi::obs_data_set_string(v, cstr("rate_control").as_ptr(), cstr("CBR").as_ptr());
        ffi::obs_data_set_int(v, cstr("bitrate").as_ptr(), base_video_kbps);
        ffi::obs_data_set_int(v, cstr("keyint_sec").as_ptr(), 2);
        let a = ffi::obs_data_create();
        ffi::obs_data_set_int(a, cstr("bitrate").as_ptr(), BASE_AUDIO_KBPS);

        ffi::obs_service_apply_encoder_settings(d.service, v, a);
        let applied_v = ffi::obs_data_get_int(v, cstr("bitrate").as_ptr());
        let applied_a = ffi::obs_data_get_int(a, cstr("bitrate").as_ptr());

        let (mut max_v, mut max_a, mut max_fps): (c_int, c_int, c_int) = (0, 0, 0);
        ffi::obs_service_get_max_bitrate(d.service, &mut max_v, &mut max_a);
        ffi::obs_service_get_max_fps(d.service, &mut max_fps);

        let mut codecs = Vec::new();
        let list = ffi::obs_service_get_supported_video_codecs(d.service);
        if !list.is_null() {
            let mut i = 0;
            while !(*list.add(i)).is_null() {
                codecs.push(CStr::from_ptr(*list.add(i)).to_string_lossy().into_owned());
                i += 1;
            }
        }
        if !codecs.is_empty() && !codecs.iter().any(|c| c == "h264") {
            return Err(format!(
                "destination {} does not support h264 (codecs: {codecs:?}); dedicated encoding required",
                d.spec.id
            ));
        }
        if max_fps > 0 && fps > max_fps {
            return Err(format!(
                "destination {} caps fps at {max_fps}, graph runs {fps}",
                d.spec.id
            ));
        }

        let mut res_list: *mut ffi::obs_service_resolution = ptr::null_mut();
        let mut res_count: usize = 0;
        ffi::obs_service_get_supported_resolutions(d.service, &mut res_list, &mut res_count);
        if !res_list.is_null() {
            ffi::bfree(res_list as *mut c_void);
        }

        if applied_v > 0 {
            video_kbps = video_kbps.min(applied_v);
        }
        if applied_a > 0 {
            audio_kbps = audio_kbps.min(applied_a);
        }
        if max_v > 0 {
            video_kbps = video_kbps.min(max_v as i64);
        }
        if max_a > 0 {
            audio_kbps = audio_kbps.min(max_a as i64);
        }

        readouts.push(PolicyReadout {
            id: d.spec.id.clone(),
            applied_video_kbps: applied_v,
            applied_audio_kbps: applied_a,
            max_video_kbps: max_v,
            max_audio_kbps: max_a,
            max_fps,
            video_codecs: codecs,
            resolution_count: res_count,
        });
        ffi::obs_data_release(v);
        ffi::obs_data_release(a);
    }
    if video_kbps < 1000 {
        return Err(format!(
            "policy intersection collapsed to {video_kbps} kbps — unacceptable"
        ));
    }
    notes.push(format!(
        "D2 intersection: video {video_kbps} kbps, audio {audio_kbps} kbps @ {fps} fps"
    ));
    Ok((video_kbps, audio_kbps, readouts))
}

/// A running multistream session, owned and pumped by the LiveEngine thread.
pub struct Session {
    dests: Vec<DestRuntime>,
    venc: *mut ffi::obs_encoder_t,
    aenc: *mut ffi::obs_encoder_t,
    rx: Receiver<Ev>,
    t0: Instant,
    stop_requested_at: Option<Instant>,
    report: MultiReport,
    done: bool,
}

// Raw libobs pointers are only ever touched from the engine thread; Session
// lives inside that thread's loop but must move into it at spawn time.
unsafe impl Send for Session {}

impl Session {
    /// Build services (resolving credentials from the keychain, §8), compute
    /// the D2 intersection, create the shared encoders, start every output.
    /// Engine thread only.
    pub fn start(config: MultiConfig) -> Result<Session, MultiReport> {
        let mut report = MultiReport::failed(Vec::new());
        report.rate_control = "CBR".into();
        let (tx, rx) = std::sync::mpsc::channel::<Ev>();
        *EVENT_TX.lock().unwrap() = Some(tx);

        let mut dests: Vec<DestRuntime> = Vec::new();
        unsafe {
            for spec in &config.destinations {
                let secret = match creds::resolve(&spec.credential_id) {
                    Ok(s) => s,
                    Err(e) => {
                        report.notes.push(e);
                        continue;
                    }
                };
                match create_service(spec, &secret) {
                    Ok(service) => dests.push(DestRuntime {
                        status: DestStatus {
                            id: spec.id.clone(),
                            phase: Phase::Idle,
                            active: false,
                            total_frames: 0,
                            dropped_frames: 0,
                            bytes_sent: 0,
                            congestion: 0.0,
                            reconnects: 0,
                            went_live_at_secs: None,
                            stop_code: None,
                            last_error: None,
                        },
                        spec: spec.clone(),
                        service,
                        output: ptr::null_mut(),
                        secret,
                    }),
                    Err(e) => report.notes.push(e),
                }
            }
            if dests.is_empty() || dests.len() != config.destinations.len() {
                report
                    .notes
                    .push("not all destinations constructed; aborting".into());
                for d in &dests {
                    ffi::obs_service_release(d.service);
                }
                *EVENT_TX.lock().unwrap() = None;
                return Err(report);
            }

            let (canvas_h, canvas_fps) = current_canvas();
            let base_kbps = base_video_kbps(canvas_h, canvas_fps);
            report.notes.push(format!(
                "canvas {canvas_h}p{canvas_fps}, base {base_kbps} kbps"
            ));
            let (video_kbps, audio_kbps, readouts) =
                match policy_intersection(&dests, base_kbps, canvas_fps, &mut report.notes) {
                    Ok(r) => r,
                    Err(e) => {
                        report.notes.push(e);
                        for d in &dests {
                            ffi::obs_service_release(d.service);
                        }
                        *EVENT_TX.lock().unwrap() = None;
                        return Err(report);
                    }
                };
            report.policy = readouts;
            report.shared_video_kbps = video_kbps;
            report.shared_audio_kbps = audio_kbps;

            let venc_settings = ffi::obs_data_create();
            ffi::obs_data_set_string(
                venc_settings,
                cstr("rate_control").as_ptr(),
                cstr("CBR").as_ptr(),
            );
            ffi::obs_data_set_int(venc_settings, cstr("bitrate").as_ptr(), video_kbps);
            ffi::obs_data_set_int(venc_settings, cstr("keyint_sec").as_ptr(), 2);
            let mut venc = ffi::obs_video_encoder_create(
                cstr(VT_H264_HW).as_ptr(),
                cstr("shared-vt-h264").as_ptr(),
                venc_settings,
                ptr::null_mut(),
            );
            report.encoder_used = VT_H264_HW.into();
            if venc.is_null() {
                report
                    .notes
                    .push("VT unavailable; shared encoder = obs_x264 (A7 fallback)".into());
                venc = ffi::obs_video_encoder_create(
                    cstr("obs_x264").as_ptr(),
                    cstr("shared-x264").as_ptr(),
                    venc_settings,
                    ptr::null_mut(),
                );
                report.encoder_used = "obs_x264".into();
            }
            let aenc_settings = ffi::obs_data_create();
            ffi::obs_data_set_int(aenc_settings, cstr("bitrate").as_ptr(), audio_kbps);
            let aenc = ffi::obs_audio_encoder_create(
                cstr("CoreAudio_AAC").as_ptr(),
                cstr("shared-aac").as_ptr(),
                aenc_settings,
                0,
                ptr::null_mut(),
            );
            ffi::obs_data_release(venc_settings);
            ffi::obs_data_release(aenc_settings);
            if venc.is_null() || aenc.is_null() {
                report.notes.push("shared encoder creation failed".into());
                for d in &dests {
                    ffi::obs_service_release(d.service);
                }
                *EVENT_TX.lock().unwrap() = None;
                return Err(report);
            }
            ffi::obs_encoder_set_video(venc, ffi::obs_get_video());
            ffi::obs_encoder_set_audio(aenc, ffi::obs_get_audio());

            for (i, d) in dests.iter_mut().enumerate() {
                let output = ffi::obs_output_create(
                    cstr("rtmp_output").as_ptr(),
                    cstr(&format!("out-{}", d.spec.id)).as_ptr(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                );
                ffi::obs_output_set_video_encoder(output, venc);
                ffi::obs_output_set_audio_encoder(output, aenc, 0);
                ffi::obs_output_set_service(output, d.service);
                let sh = ffi::obs_output_get_signal_handler(output);
                let idx = i as *mut c_void;
                ffi::signal_handler_connect(sh, cstr("start").as_ptr(), on_start, idx);
                ffi::signal_handler_connect(sh, cstr("stop").as_ptr(), on_stop, idx);
                ffi::signal_handler_connect(sh, cstr("reconnect").as_ptr(), on_reconnect, idx);
                ffi::signal_handler_connect(
                    sh,
                    cstr("reconnect_success").as_ptr(),
                    on_reconnect_success,
                    idx,
                );
                d.output = output;
            }

            let t0 = Instant::now();
            for d in dests.iter_mut() {
                let started = ffi::obs_output_start(d.output);
                d.status.phase = if started {
                    Phase::Connecting
                } else {
                    Phase::Stopped
                };
                report.events.push(format!(
                    "{}: obs_output_start returned {started}",
                    d.spec.id
                ));
            }

            Ok(Session {
                dests,
                venc,
                aenc,
                rx,
                t0,
                stop_requested_at: None,
                report,
                done: false,
            })
        }
    }

    /// Drain signal events and refresh per-destination telemetry. Returns
    /// true when every output has stopped (or the stop wait timed out).
    /// Engine thread only; call every few hundred ms.
    pub fn pump(&mut self) -> bool {
        if self.done {
            return true;
        }
        while let Ok(ev) = self.rx.try_recv() {
            let (i, line) = match ev {
                Ev::Start(i) => {
                    self.dests[i].status.phase = Phase::Live;
                    if self.dests[i].status.went_live_at_secs.is_none() {
                        self.dests[i].status.went_live_at_secs =
                            Some(self.t0.elapsed().as_secs_f64());
                    }
                    (i, "live".to_string())
                }
                Ev::Reconnect(i) => {
                    self.dests[i].status.phase = Phase::Reconnecting;
                    self.dests[i].status.reconnects += 1;
                    (i, "reconnecting".to_string())
                }
                Ev::ReconnectSuccess(i) => {
                    self.dests[i].status.phase = Phase::Live;
                    (i, "reconnected".to_string())
                }
                Ev::Stop(i, code) => {
                    self.dests[i].status.phase = Phase::Stopped;
                    self.dests[i].status.stop_code = Some(code);
                    (i, format!("stopped code={code}"))
                }
            };
            self.report.events.push(format!(
                "{}: {} at {:.1}s",
                self.dests[i].spec.id,
                line,
                self.t0.elapsed().as_secs_f64()
            ));
        }
        unsafe {
            for d in self.dests.iter_mut() {
                if d.status.phase != Phase::Stopped {
                    d.status.active = ffi::obs_output_active(d.output);
                    d.status.total_frames = ffi::obs_output_get_total_frames(d.output);
                    d.status.dropped_frames = ffi::obs_output_get_frames_dropped(d.output);
                    d.status.bytes_sent = ffi::obs_output_get_total_bytes(d.output);
                    d.status.congestion = ffi::obs_output_get_congestion(d.output);
                    let err = ffi::obs_output_get_last_error(d.output);
                    if !err.is_null() {
                        let redacted =
                            creds::redact(&CStr::from_ptr(err).to_string_lossy(), &d.secret);
                        d.status.last_error = Some(redacted);
                    }
                }
            }
        }

        let all_stopped = self.dests.iter().all(|d| d.status.phase == Phase::Stopped);
        if all_stopped {
            self.done = true;
            return true;
        }
        if self.stop_requested_at.is_none()
            && self.t0.elapsed() > Duration::from_secs(MAX_STREAM_SECS)
        {
            self.request_stop();
            self.report
                .notes
                .push("max stream duration backstop hit".into());
        }
        if let Some(at) = self.stop_requested_at {
            if at.elapsed() > Duration::from_secs(20) {
                self.report
                    .notes
                    .push("stop signals incomplete after bound; releasing anyway".into());
                self.done = true;
                return true;
            }
        }
        false
    }

    pub fn request_stop(&mut self) {
        if self.stop_requested_at.is_some() {
            return;
        }
        self.stop_requested_at = Some(Instant::now());
        self.report.events.push(format!(
            "stop requested at {:.1}s",
            self.t0.elapsed().as_secs_f64()
        ));
        unsafe {
            for d in self.dests.iter() {
                if d.status.phase != Phase::Stopped {
                    ffi::obs_output_stop(d.output);
                }
            }
        }
    }

    pub fn stopping(&self) -> bool {
        self.stop_requested_at.is_some()
    }

    pub fn elapsed_secs(&self) -> f64 {
        self.t0.elapsed().as_secs_f64()
    }

    pub fn statuses(&self) -> Vec<DestStatus> {
        self.dests.iter().map(|d| d.status.clone()).collect()
    }

    /// Release every OBS object and produce the final report. Engine thread.
    pub fn finish(mut self) -> MultiReport {
        self.report.streamed_secs = self.t0.elapsed().as_secs_f64();
        unsafe {
            for d in self.dests.iter() {
                ffi::obs_output_release(d.output);
                ffi::obs_service_release(d.service);
            }
            ffi::obs_encoder_release(self.venc);
            ffi::obs_encoder_release(self.aenc);
        }
        self.report.destinations = self.dests.iter().map(|d| d.status.clone()).collect();
        *EVENT_TX.lock().unwrap() = None;
        self.report.ok = self
            .report
            .destinations
            .iter()
            .all(|d| d.went_live_at_secs.is_some() && d.total_frames > 0);
        self.report
    }
}
