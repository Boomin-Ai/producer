//! M-L3 first light: encoders → service → rtmp_output → start, all OBS code
//! (F4 chain), driven from the live-engine thread under the §5.1 invariant.
//! Output signals publish immutable events through a channel; nothing in a
//! callback touches engine or app state.

use std::ffi::{CStr, CString};
use std::os::raw::c_void;
use std::path::Path;
use std::ptr;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{creds, ffi, graph};

const VT_H264_HW: &str = "com.apple.videotoolbox.videoencoder.ave.avc";
const MAX_STREAM_SECS: u64 = 600;

#[derive(Debug, Clone, Serialize)]
pub enum StreamEvent {
    Started,
    Stopped { code: i64 },
    Reconnecting,
    Reconnected,
}

static EVENT_TX: Mutex<Option<Sender<StreamEvent>>> = Mutex::new(None);

fn emit(event: StreamEvent) {
    if let Ok(guard) = EVENT_TX.lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(event);
        }
    }
}

extern "C" fn on_start(_data: *mut c_void, _cd: *mut ffi::calldata_t) {
    emit(StreamEvent::Started);
}
extern "C" fn on_stop(_data: *mut c_void, cd: *mut ffi::calldata_t) {
    let mut code: i64 = -1;
    let name = CString::new("code").unwrap();
    unsafe {
        ffi::calldata_get_data(cd, name.as_ptr(), &mut code as *mut i64 as *mut c_void, 8);
    }
    emit(StreamEvent::Stopped { code });
}
extern "C" fn on_reconnect(_data: *mut c_void, _cd: *mut ffi::calldata_t) {
    emit(StreamEvent::Reconnecting);
}
extern "C" fn on_reconnect_success(_data: *mut c_void, _cd: *mut ffi::calldata_t) {
    emit(StreamEvent::Reconnected);
}

#[derive(Debug, Clone, Serialize)]
pub struct FirstLightReport {
    pub ok: bool,
    pub encoder_used: String,
    pub service: String,
    pub server: String,
    pub events: Vec<String>,
    pub streamed_secs: f64,
    pub total_frames: i32,
    pub dropped_frames: i32,
    pub last_error: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct StreamStatus {
    phase: &'static str,
    active: bool,
    elapsed_secs: f64,
    total_frames: i32,
    dropped_frames: i32,
}

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap()
}

fn write_status(path: &Path, status: &StreamStatus) {
    if let Ok(json) = serde_json::to_string_pretty(status) {
        let _ = std::fs::write(path, json);
    }
}

/// Run first light against one Twitch destination. MUST run on the
/// live-engine thread, after bootstrap, with capture sources attached.
/// Streams until `stop_file` appears, the output stops itself, or
/// MAX_STREAM_SECS elapses.
pub fn first_light(credential_id: &str, report_dir: &Path) -> FirstLightReport {
    let mut report = FirstLightReport {
        ok: false,
        encoder_used: String::new(),
        service: "Twitch".into(),
        server: "auto".into(),
        events: Vec::new(),
        streamed_secs: 0.0,
        total_frames: 0,
        dropped_frames: 0,
        last_error: None,
        notes: Vec::new(),
    };
    let status_path = report_dir.join("first-light-status.json");
    let stop_file = report_dir.join("first-light.stop");
    let _ = std::fs::remove_file(&stop_file);

    // §8: resolve the secret now, hold it only in this frame, hand it to
    // libobs via obs_data, redact it from anything operator-facing.
    let key = match creds::resolve(credential_id) {
        Ok(k) => k,
        Err(e) => {
            report.notes.push(e);
            return report;
        }
    };

    let (tx, rx): (Sender<StreamEvent>, Receiver<StreamEvent>) = std::sync::mpsc::channel();
    *EVENT_TX.lock().unwrap() = Some(tx);

    unsafe {
        // Service first — D2: policy flows from the service to encoder
        // settings, applied before the encoders exist.
        let service_settings = ffi::obs_data_create();
        let k_service = cstr("service");
        let v_service = cstr("Twitch");
        let k_server = cstr("server");
        let v_server = cstr("auto");
        let k_key = cstr("key");
        let v_key = cstr(&key);
        ffi::obs_data_set_string(service_settings, k_service.as_ptr(), v_service.as_ptr());
        ffi::obs_data_set_string(service_settings, k_server.as_ptr(), v_server.as_ptr());
        ffi::obs_data_set_string(service_settings, k_key.as_ptr(), v_key.as_ptr());
        let service = ffi::obs_service_create(
            cstr("rtmp_common").as_ptr(),
            cstr("ML3 Twitch").as_ptr(),
            service_settings,
            ptr::null_mut(),
        );
        ffi::obs_data_release(service_settings);
        if service.is_null() {
            report.notes.push("obs_service_create failed".into());
            return report;
        }

        let venc_settings = ffi::obs_data_create();
        ffi::obs_data_set_string(venc_settings, cstr("rate_control").as_ptr(), cstr("CBR").as_ptr());
        ffi::obs_data_set_int(venc_settings, cstr("bitrate").as_ptr(), 4500);
        ffi::obs_data_set_int(venc_settings, cstr("keyint_sec").as_ptr(), 2);
        let aenc_settings = ffi::obs_data_create();
        ffi::obs_data_set_int(aenc_settings, cstr("bitrate").as_ptr(), 160);
        ffi::obs_service_apply_encoder_settings(service, venc_settings, aenc_settings);

        let mut venc = ffi::obs_video_encoder_create(
            cstr(VT_H264_HW).as_ptr(),
            cstr("ML3 VT H264").as_ptr(),
            venc_settings,
            ptr::null_mut(),
        );
        if venc.is_null() {
            report.notes.push("VideoToolbox encoder unavailable, using obs_x264".into());
            venc = ffi::obs_video_encoder_create(
                cstr("obs_x264").as_ptr(),
                cstr("ML3 x264").as_ptr(),
                venc_settings,
                ptr::null_mut(),
            );
            report.encoder_used = "obs_x264".into();
        } else {
            report.encoder_used = VT_H264_HW.into();
        }
        let aenc = ffi::obs_audio_encoder_create(
            cstr("CoreAudio_AAC").as_ptr(),
            cstr("ML3 AAC").as_ptr(),
            aenc_settings,
            0,
            ptr::null_mut(),
        );
        ffi::obs_data_release(venc_settings);
        ffi::obs_data_release(aenc_settings);
        if venc.is_null() || aenc.is_null() {
            report.notes.push("encoder creation failed".into());
            ffi::obs_service_release(service);
            return report;
        }
        ffi::obs_encoder_set_video(venc, ffi::obs_get_video());
        ffi::obs_encoder_set_audio(aenc, ffi::obs_get_audio());

        let output = ffi::obs_output_create(
            cstr("rtmp_output").as_ptr(),
            cstr("ML3 RTMP").as_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
        );
        if output.is_null() {
            report.notes.push("obs_output_create failed".into());
            ffi::obs_encoder_release(venc);
            ffi::obs_encoder_release(aenc);
            ffi::obs_service_release(service);
            return report;
        }
        ffi::obs_output_set_video_encoder(output, venc);
        ffi::obs_output_set_audio_encoder(output, aenc, 0);
        ffi::obs_output_set_service(output, service);

        let sh = ffi::obs_output_get_signal_handler(output);
        ffi::signal_handler_connect(sh, cstr("start").as_ptr(), on_start, ptr::null_mut());
        ffi::signal_handler_connect(sh, cstr("stop").as_ptr(), on_stop, ptr::null_mut());
        ffi::signal_handler_connect(sh, cstr("reconnect").as_ptr(), on_reconnect, ptr::null_mut());
        ffi::signal_handler_connect(sh, cstr("reconnect_success").as_ptr(), on_reconnect_success, ptr::null_mut());

        let started = ffi::obs_output_start(output);
        report.events.push(format!("obs_output_start returned {started}"));
        let t0 = Instant::now();
        let mut phase: &'static str = if started { "connecting" } else { "failed" };
        let mut stopped_code: Option<i64> = None;

        if started {
            loop {
                while let Ok(ev) = rx.try_recv() {
                    match &ev {
                        StreamEvent::Started => phase = "live",
                        StreamEvent::Reconnecting => phase = "reconnecting",
                        StreamEvent::Reconnected => phase = "live",
                        StreamEvent::Stopped { code } => {
                            stopped_code = Some(*code);
                        }
                    }
                    report.events.push(format!("{:?} at {:.1}s", ev, t0.elapsed().as_secs_f64()));
                }
                if stopped_code.is_some() {
                    break;
                }
                write_status(
                    &status_path,
                    &StreamStatus {
                        phase,
                        active: ffi::obs_output_active(output),
                        elapsed_secs: t0.elapsed().as_secs_f64(),
                        total_frames: ffi::obs_output_get_total_frames(output),
                        dropped_frames: ffi::obs_output_get_frames_dropped(output),
                    },
                );
                if stop_file.exists() || t0.elapsed() > Duration::from_secs(MAX_STREAM_SECS) {
                    report.events.push(format!("stop requested at {:.1}s", t0.elapsed().as_secs_f64()));
                    ffi::obs_output_stop(output);
                    // wait for the stop signal, bounded
                    let deadline = Instant::now() + Duration::from_secs(15);
                    while stopped_code.is_none() && Instant::now() < deadline {
                        if let Ok(StreamEvent::Stopped { code }) = rx.recv_timeout(Duration::from_millis(250)) {
                            stopped_code = Some(code);
                        }
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }

        report.streamed_secs = t0.elapsed().as_secs_f64();
        report.total_frames = ffi::obs_output_get_total_frames(output);
        report.dropped_frames = ffi::obs_output_get_frames_dropped(output);
        let err = ffi::obs_output_get_last_error(output);
        if !err.is_null() {
            report.last_error = Some(creds::redact(&CStr::from_ptr(err).to_string_lossy(), &key));
        }
        if let Some(code) = stopped_code {
            report.events.push(format!("stopped with code {code}"));
            // OBS_OUTPUT_SUCCESS == 0: a requested stop that ends with 0 is a
            // clean session.
            report.ok = code == 0 && report.total_frames > 0;
        }

        ffi::obs_output_release(output);
        ffi::obs_encoder_release(venc);
        ffi::obs_encoder_release(aenc);
        ffi::obs_service_release(service);
    }

    *EVENT_TX.lock().unwrap() = None;
    let _ = std::fs::remove_file(&stop_file);
    report
}

/// Attach capture sources and run first light (the --live-first-light entry).
pub fn run_first_light(credential_id: &str, report_dir: &Path) -> FirstLightReport {
    if let Err(e) = graph::attach_capture_sources() {
        return FirstLightReport {
            ok: false,
            encoder_used: String::new(),
            service: "Twitch".into(),
            server: "auto".into(),
            events: Vec::new(),
            streamed_secs: 0.0,
            total_frames: 0,
            dropped_frames: 0,
            last_error: None,
            notes: vec![format!("capture attach failed: {e}")],
        };
    }
    first_light(credential_id, report_dir)
}
