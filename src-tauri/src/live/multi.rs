//! M-L4 multistream: N simultaneous RTMP pushes from ONE shared encoder
//! pair, configured via the D2 policy intersection BEFORE start — never a
//! hardcoded common bitrate, and no service ever mutates a live shared
//! encoder. Per-destination status flows from obs_output signals as
//! immutable events (§5.1). Kick is the F7 product template: a named
//! destination over rtmp_custom, ~20 lines of config, not an integration.

use std::ffi::{CStr, CString};
use std::os::raw::{c_int, c_void};
use std::path::Path;
use std::ptr;
use std::sync::mpsc::Sender;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{creds, ffi, graph};

const VT_H264_HW: &str = "com.apple.videotoolbox.videoencoder.ave.avc";
const MAX_STREAM_SECS: u64 = 45 * 60;
const BASE_VIDEO_KBPS: i64 = 4500;
const BASE_AUDIO_KBPS: i64 = 160;

#[derive(Debug, Clone, Deserialize)]
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

/// The Kick destination template (F7): Kick is not in OBS's service catalog;
/// its own docs point OBS users at Custom RTMP with an IVS ingest URL.
/// Normalize what users paste: trim, drop trailing slashes, ensure the IVS
/// `/app` application path.
fn normalize_kick_server(url: &str) -> Result<String, String> {
    let mut s = url.trim().trim_end_matches('/').to_string();
    if !(s.starts_with("rtmps://") || s.starts_with("rtmp://")) {
        return Err(format!("kick server must be rtmp(s)://…, got {s}"));
    }
    if !s.ends_with("/app") {
        s.push_str("/app");
    }
    Ok(s)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
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

/// Create the obs_service for a destination spec, key resolved from the
/// keychain at creation time (§8).
unsafe fn create_service(spec: &DestinationSpec, secret: &str) -> Result<*mut ffi::obs_service_t, String> {
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
            ffi::obs_data_set_string(settings, cstr("service").as_ptr(), cstr("YouTube - RTMPS").as_ptr());
            ffi::obs_data_set_string(
                settings,
                cstr("server").as_ptr(),
                cstr("rtmps://a.rtmps.youtube.com:443/live2").as_ptr(),
            );
            "rtmp_common"
        }
        "kick" | "custom" => {
            let raw = spec.server.as_deref().ok_or("kick/custom destination needs a server URL")?;
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
/// encoder settings, read the caps (F12), and fold them into the shared
/// intersection profile. Returns (video_kbps, audio_kbps, readouts).
unsafe fn policy_intersection(
    dests: &[DestRuntime],
    fps: i32,
    notes: &mut Vec<String>,
) -> Result<(i64, i64, Vec<PolicyReadout>), String> {
    let mut video_kbps = BASE_VIDEO_KBPS;
    let mut audio_kbps = BASE_AUDIO_KBPS;
    let mut readouts = Vec::new();

    for d in dests {
        let v = ffi::obs_data_create();
        ffi::obs_data_set_string(v, cstr("rate_control").as_ptr(), cstr("CBR").as_ptr());
        ffi::obs_data_set_int(v, cstr("bitrate").as_ptr(), BASE_VIDEO_KBPS);
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
            return Err(format!("destination {} caps fps at {max_fps}, graph runs {fps}", d.spec.id));
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
        return Err(format!("policy intersection collapsed to {video_kbps} kbps — unacceptable"));
    }
    notes.push(format!("D2 intersection: video {video_kbps} kbps, audio {audio_kbps} kbps @ {fps} fps"));
    Ok((video_kbps, audio_kbps, readouts))
}

#[derive(Debug, Clone, Serialize)]
struct MultiStatus<'a> {
    elapsed_secs: f64,
    destinations: &'a [DestStatus],
}

/// Run the multistream session. Engine thread only, capture sources attached.
pub fn multi_stream(config: MultiConfig, report_dir: &Path) -> MultiReport {
    let mut report = MultiReport {
        ok: false,
        encoder_used: String::new(),
        rate_control: "CBR".into(),
        shared_video_kbps: 0,
        shared_audio_kbps: 0,
        policy: Vec::new(),
        destinations: Vec::new(),
        streamed_secs: 0.0,
        events: Vec::new(),
        notes: Vec::new(),
    };
    let status_path = report_dir.join("multi-status.json");
    let stop_file = report_dir.join("multi.stop");
    let _ = std::fs::remove_file(&stop_file);

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
        if dests.len() != config.destinations.len() {
            report.notes.push("not all destinations constructed; aborting".into());
            for d in &dests {
                ffi::obs_service_release(d.service);
            }
            *EVENT_TX.lock().unwrap() = None;
            return report;
        }

        // D2: intersection BEFORE the shared encoder exists, never after.
        let (video_kbps, audio_kbps, readouts) = match policy_intersection(&dests, 30, &mut report.notes) {
            Ok(r) => r,
            Err(e) => {
                report.notes.push(e);
                for d in &dests {
                    ffi::obs_service_release(d.service);
                }
                *EVENT_TX.lock().unwrap() = None;
                return report;
            }
        };
        report.policy = readouts;
        report.shared_video_kbps = video_kbps;
        report.shared_audio_kbps = audio_kbps;

        let venc_settings = ffi::obs_data_create();
        ffi::obs_data_set_string(venc_settings, cstr("rate_control").as_ptr(), cstr("CBR").as_ptr());
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
            report.notes.push("VT unavailable; shared encoder = obs_x264 (A7 fallback)".into());
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
            return report;
        }
        ffi::obs_encoder_set_video(venc, ffi::obs_get_video());
        ffi::obs_encoder_set_audio(aenc, ffi::obs_get_audio());

        // One rtmp_output per destination, ALL bound to the same encoders (F5).
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
            ffi::signal_handler_connect(sh, cstr("reconnect_success").as_ptr(), on_reconnect_success, idx);
            d.output = output;
        }

        let t0 = Instant::now();
        for d in dests.iter_mut() {
            let started = ffi::obs_output_start(d.output);
            d.status.phase = if started { Phase::Connecting } else { Phase::Stopped };
            report
                .events
                .push(format!("{}: obs_output_start returned {started}", d.spec.id));
        }

        let mut stop_requested_at: Option<Instant> = None;
        loop {
            while let Ok(ev) = rx.try_recv() {
                let (i, line) = match ev {
                    Ev::Start(i) => {
                        dests[i].status.phase = Phase::Live;
                        if dests[i].status.went_live_at_secs.is_none() {
                            dests[i].status.went_live_at_secs = Some(t0.elapsed().as_secs_f64());
                        }
                        (i, "live".to_string())
                    }
                    Ev::Reconnect(i) => {
                        dests[i].status.phase = Phase::Reconnecting;
                        dests[i].status.reconnects += 1;
                        (i, "reconnecting".to_string())
                    }
                    Ev::ReconnectSuccess(i) => {
                        dests[i].status.phase = Phase::Live;
                        (i, "reconnected".to_string())
                    }
                    Ev::Stop(i, code) => {
                        dests[i].status.phase = Phase::Stopped;
                        dests[i].status.stop_code = Some(code);
                        (i, format!("stopped code={code}"))
                    }
                };
                report
                    .events
                    .push(format!("{}: {} at {:.1}s", dests[i].spec.id, line, t0.elapsed().as_secs_f64()));
            }

            for d in dests.iter_mut() {
                if d.status.phase != Phase::Stopped {
                    d.status.active = ffi::obs_output_active(d.output);
                    d.status.total_frames = ffi::obs_output_get_total_frames(d.output);
                    d.status.dropped_frames = ffi::obs_output_get_frames_dropped(d.output);
                    d.status.congestion = ffi::obs_output_get_congestion(d.output);
                    let err = ffi::obs_output_get_last_error(d.output);
                    if !err.is_null() {
                        let redacted = creds::redact(&CStr::from_ptr(err).to_string_lossy(), &d.secret);
                        d.status.last_error = Some(redacted);
                    }
                }
            }
            let statuses: Vec<DestStatus> = dests.iter().map(|d| d.status.clone()).collect();
            if let Ok(json) = serde_json::to_string_pretty(&MultiStatus {
                elapsed_secs: t0.elapsed().as_secs_f64(),
                destinations: &statuses,
            }) {
                let _ = std::fs::write(&status_path, json);
            }

            let all_stopped = dests.iter().all(|d| d.status.phase == Phase::Stopped);
            if all_stopped {
                break;
            }
            if stop_requested_at.is_none()
                && (stop_file.exists() || t0.elapsed() > Duration::from_secs(MAX_STREAM_SECS))
            {
                stop_requested_at = Some(Instant::now());
                report
                    .events
                    .push(format!("stop requested at {:.1}s", t0.elapsed().as_secs_f64()));
                for d in dests.iter() {
                    if d.status.phase != Phase::Stopped {
                        ffi::obs_output_stop(d.output);
                    }
                }
            }
            // bounded wait: force-exit if stop signals don't land in 20s
            if let Some(at) = stop_requested_at {
                if at.elapsed() > Duration::from_secs(20) {
                    report.notes.push("stop signals incomplete after bound; releasing anyway".into());
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }

        report.streamed_secs = t0.elapsed().as_secs_f64();
        for d in dests.iter() {
            ffi::obs_output_release(d.output);
            ffi::obs_service_release(d.service);
        }
        ffi::obs_encoder_release(venc);
        ffi::obs_encoder_release(aenc);
        report.destinations = dests.iter().map(|d| d.status.clone()).collect();
    }

    *EVENT_TX.lock().unwrap() = None;
    let _ = std::fs::remove_file(&stop_file);
    report.ok = report
        .destinations
        .iter()
        .all(|d| d.went_live_at_secs.is_some() && d.total_frames > 0);
    report
}

/// The --live-multistream entry: attach capture, read config, run.
pub fn run_multistream(report_dir: &Path) -> MultiReport {
    let cfg_path = report_dir.join("multi-config.json");
    let cfg: MultiConfig = match std::fs::read_to_string(&cfg_path)
        .map_err(|e| e.to_string())
        .and_then(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
    {
        Ok(c) => c,
        Err(e) => {
            return MultiReport {
                ok: false,
                encoder_used: String::new(),
                rate_control: "CBR".into(),
                shared_video_kbps: 0,
                shared_audio_kbps: 0,
                policy: Vec::new(),
                destinations: Vec::new(),
                streamed_secs: 0.0,
                events: Vec::new(),
                notes: vec![format!("config read failed ({}): {e}", cfg_path.display())],
            }
        }
    };
    if let Err(e) = graph::attach_capture_sources() {
        return MultiReport {
            ok: false,
            encoder_used: String::new(),
            rate_control: "CBR".into(),
            shared_video_kbps: 0,
            shared_audio_kbps: 0,
            policy: Vec::new(),
            destinations: Vec::new(),
            streamed_secs: 0.0,
            events: Vec::new(),
            notes: vec![format!("capture attach failed: {e}")],
        };
    }
    multi_stream(cfg, report_dir)
}
