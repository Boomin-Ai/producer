//! Producer Live — libobs host (LIVE-REVIEW.md). Compiled against the engine
//! artifact when present (`have_engine` cfg set by build.rs); otherwise the
//! stubs keep the app building and the IPC surface truthful about it.

pub mod commands;
pub mod creds;
#[cfg(have_engine)]
pub mod engine;
#[cfg(have_engine)]
mod ffi;
#[cfg(have_engine)]
pub mod graph;
#[cfg(have_engine)]
pub mod multi;
#[cfg(have_engine)]
pub mod stream;

use std::path::{Path, PathBuf};

/// Kick server normalization, available with or without the engine so the
/// destination editor can validate at save time (F7 template).
pub fn normalize_kick_server_checked(url: &str) -> Result<String, String> {
    let mut s = url.trim().trim_end_matches('/').to_string();
    if !(s.starts_with("rtmps://") || s.starts_with("rtmp://")) {
        return Err(format!("kick server must be rtmp(s)://…, got {s}"));
    }
    if !s.ends_with("/app") {
        s.push_str("/app");
    }
    Ok(s)
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match serde_json::to_string_pretty(value) {
        Ok(json) => {
            let _ = std::fs::write(path, &json);
        }
        Err(e) => eprintln!("[live] report serialize failed: {e}"),
    }
}

/// App-facing facade over the LiveEngine. Exists in both cfg variants so
/// AppState and the IPC commands never need cfg switches.
pub struct Live {
    #[cfg(have_engine)]
    handle: Option<engine::LiveHandle>,
}

impl Live {
    pub fn disabled() -> Self {
        Live {
            #[cfg(have_engine)]
            handle: None,
        }
    }

    /// (id, preset, server, credential_id) rows → go live.
    #[cfg(have_engine)]
    pub fn go_live_specs(
        &self,
        specs: Vec<(String, String, Option<String>, String)>,
    ) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("live engine not running")?;
        let destinations = specs
            .into_iter()
            .map(
                |(id, preset, server, credential_id)| multi::DestinationSpec {
                    id,
                    kind: preset,
                    credential_id,
                    server,
                },
            )
            .collect();
        handle.go_live(multi::MultiConfig { destinations })
    }
    #[cfg(not(have_engine))]
    pub fn go_live_specs(
        &self,
        _specs: Vec<(String, String, Option<String>, String)>,
    ) -> Result<(), String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn stop_live(&self) -> Result<(), String> {
        self.handle
            .as_ref()
            .ok_or("live engine not running")?
            .stop_live()
    }
    #[cfg(not(have_engine))]
    pub fn stop_live(&self) -> Result<(), String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn status(&self) -> serde_json::Value {
        match &self.handle {
            Some(h) => {
                let mut v =
                    serde_json::to_value(h.snapshot.lock().unwrap().clone()).unwrap_or_default();
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "stage_transparent".into(),
                        serde_json::Value::Bool(
                            engine::STAGE_TRANSPARENT.load(std::sync::atomic::Ordering::SeqCst),
                        ),
                    );
                }
                v
            }
            None => serde_json::json!({ "engine_ready": false, "disabled": true }),
        }
    }
    #[cfg(not(have_engine))]
    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({ "engine_ready": false, "disabled": true, "reason": "engine not bundled" })
    }

    /// Quit path (§5.5: closing Producer ends the stream). Bounded by the
    /// engine's own stop wait (≤ ~15s with an active session, instant idle).
    #[cfg(have_engine)]
    pub fn shutdown(&self) {
        if let Some(h) = &self.handle {
            h.shutdown();
        }
    }
    #[cfg(not(have_engine))]
    pub fn shutdown(&self) {}

    #[cfg(have_engine)]
    pub fn set_sources(&self, screen: bool, camera: bool, mic: bool) -> Result<(), String> {
        self.handle
            .as_ref()
            .ok_or("live engine not running")?
            .set_sources(screen, camera, mic)
    }
    #[cfg(not(have_engine))]
    pub fn set_sources(&self, _s: bool, _c: bool, _m: bool) -> Result<(), String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn set_mic_audio(&self, volume: Option<f32>, muted: Option<bool>) -> Result<(), String> {
        self.handle
            .as_ref()
            .ok_or("live engine not running")?
            .set_mic_audio(volume, muted)
    }
    #[cfg(not(have_engine))]
    pub fn set_mic_audio(&self, _v: Option<f32>, _m: Option<bool>) -> Result<(), String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn set_video(&self, height: u32, fps: u32) -> Result<(), String> {
        self.handle
            .as_ref()
            .ok_or("live engine not running")?
            .set_video(height, fps)
    }
    #[cfg(not(have_engine))]
    pub fn set_video(&self, _h: u32, _f: u32) -> Result<(), String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn set_overlay(
        &self,
        window_id: Option<u32>,
        color_key: bool,
        url: Option<String>,
    ) -> Result<(), String> {
        let spec = match (url, window_id) {
            (Some(url), _) if !url.trim().is_empty() => graph::OverlaySpec::Browser {
                url: url.trim().into(),
            },
            (_, Some(id)) => graph::OverlaySpec::Window { id, color_key },
            _ => graph::OverlaySpec::None,
        };
        self.handle
            .as_ref()
            .ok_or("live engine not running")?
            .set_overlay(spec)
    }
    #[cfg(not(have_engine))]
    pub fn set_overlay(&self, _w: Option<u32>, _k: bool, _u: Option<String>) -> Result<(), String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn list_windows(&self) -> Result<serde_json::Value, String> {
        let mut buf = vec![0u8; 256 * 1024];
        let ok = unsafe {
            ffi::producer_list_windows(
                buf.as_mut_ptr() as *mut std::os::raw::c_char,
                buf.len() as i32,
            )
        };
        if ok == 0 {
            return Err("window enumeration failed".into());
        }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        serde_json::from_slice(&buf[..end]).map_err(|e| format!("window list parse: {e}"))
    }
    #[cfg(not(have_engine))]
    pub fn list_windows(&self) -> Result<serde_json::Value, String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn attach_preview(
        &self,
        window: usize,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<(), String> {
        self.handle
            .as_ref()
            .ok_or("live engine not running")?
            .attach_preview(window, engine::PreviewRect { x, y, w, h })
    }
    #[cfg(not(have_engine))]
    pub fn attach_preview(
        &self,
        _win: usize,
        _x: f64,
        _y: f64,
        _w: f64,
        _h: f64,
    ) -> Result<(), String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn move_preview(&self, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
        self.handle
            .as_ref()
            .ok_or("live engine not running")?
            .move_preview(engine::PreviewRect { x, y, w, h })
    }
    #[cfg(not(have_engine))]
    pub fn move_preview(&self, _x: f64, _y: f64, _w: f64, _h: f64) -> Result<(), String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn set_preview_hidden(&self, hidden: bool) -> Result<(), String> {
        self.handle
            .as_ref()
            .ok_or("live engine not running")?
            .set_preview_hidden(hidden)
    }
    #[cfg(not(have_engine))]
    pub fn set_preview_hidden(&self, _h: bool) -> Result<(), String> {
        Ok(())
    }

    #[cfg(have_engine)]
    pub fn detach_preview(&self) -> Result<(), String> {
        self.handle
            .as_ref()
            .ok_or("live engine not running")?
            .detach_preview()
    }
    #[cfg(not(have_engine))]
    pub fn detach_preview(&self) -> Result<(), String> {
        Ok(())
    }
}

/// TCC status for the coach (M-L6). Names, not booleans, so the UI can
/// distinguish "never asked" from "denied" — the coach copy differs.
pub fn permissions() -> serde_json::Value {
    #[cfg(have_engine)]
    unsafe {
        fn name(status: i32) -> &'static str {
            match status {
                3 => "granted",
                2 => "denied",
                1 => "restricted",
                _ => "not_determined",
            }
        }
        return serde_json::json!({
            "screen": if ffi::producer_screen_capture_preflight() == 1 { "granted" } else { "denied_or_not_determined" },
            "camera": name(ffi::producer_av_authorization_status(0)),
            "mic": name(ffi::producer_av_authorization_status(1)),
        });
    }
    #[cfg(not(have_engine))]
    serde_json::json!({ "screen": "unknown", "camera": "unknown", "mic": "unknown" })
}

/// Make the webview see-through so the preview can sit BEHIND it, and
/// report whether WebKit allowed it. Main thread, synchronous — the answer
/// must be known before the UI decides how to paint the stage.
#[cfg(have_engine)]
pub fn prepare_stage(ns_window: usize) -> bool {
    let ok =
        unsafe { ffi::producer_preview_prepare_window(ns_window as *mut std::ffi::c_void) } == 1;
    engine::STAGE_TRANSPARENT.store(ok, std::sync::atomic::Ordering::SeqCst);
    ok
}
#[cfg(not(have_engine))]
pub fn prepare_stage(_ns_window: usize) -> bool {
    false
}

/// Fire the system prompt for a permission (mic/camera prompt in place;
/// screen registers the app in System Settings — relaunch needed after).
pub fn request_permission(kind: &str) -> Result<(), String> {
    #[cfg(have_engine)]
    unsafe {
        match kind {
            "camera" => ffi::producer_av_request_access(0),
            "mic" => ffi::producer_av_request_access(1),
            "screen" => ffi::producer_screen_capture_request(),
            other => return Err(format!("unknown permission {other}")),
        }
        return Ok(());
    }
    #[cfg(not(have_engine))]
    {
        let _ = kind;
        Err("live engine not bundled in this build".into())
    }
}

/// First Light onboarding: the floating drag chip that carries the app
/// bundle into System Settings' Screen Recording list, plus a deep link to
/// that pane. macOS never lets an app grant itself Screen Recording — the
/// drag is the smoothest way to hand the user that step.
pub fn screen_grant_coach(action: &str) -> Result<(), String> {
    #[cfg(have_engine)]
    unsafe {
        match action {
            "chip_show" => ffi::producer_drag_chip_show(),
            "chip_hide" => ffi::producer_drag_chip_hide(),
            "open_settings" => ffi::producer_open_screen_settings(),
            other => return Err(format!("unknown coach action {other}")),
        }
        return Ok(());
    }
    #[cfg(not(have_engine))]
    {
        let _ = action;
        Err("live engine not bundled in this build".into())
    }
}

/// Start the LiveEngine for the app: events flow to the webview as
/// `live://event`, the snapshot backs `live_engine_status`, and when the app
/// was launched with `--live-multistream` the M-L4/M-L5 harness rides the
/// same engine path (config in, report/status files out).
#[cfg(have_engine)]
pub fn init(app: tauri::AppHandle, report_dir: PathBuf) -> Live {
    use tauri::Emitter;

    let harness = std::env::args().any(|a| a == "--live-multistream");
    let harness_dir = report_dir.clone();

    let handle = engine::start(report_dir.join("module-config"), move |ev| {
        let _ = app.emit("live://event", ev);
        match ev {
            engine::LiveEvent::EngineReady { ok, .. } => {
                if harness && *ok {
                    let cfg_path = harness_dir.join("multi-config.json");
                    match std::fs::read_to_string(&cfg_path)
                        .map_err(|e| e.to_string())
                        .and_then(|s| {
                            serde_json::from_str::<multi::MultiConfig>(&s)
                                .map_err(|e| e.to_string())
                        }) {
                        Ok(cfg) => {
                            // Sent from the engine thread's own sink; the
                            // command is picked up on the next loop turn.
                            if let Some(h) = HARNESS_CMD.lock().unwrap().as_ref() {
                                let _ = h.send(cfg);
                            }
                        }
                        Err(e) => eprintln!("[live] harness config error: {e}"),
                    }
                }
            }
            engine::LiveEvent::Status {
                elapsed_secs,
                destinations,
            } => {
                if harness {
                    write_json(
                        &harness_dir.join("multi-status.json"),
                        &serde_json::json!({ "elapsed_secs": elapsed_secs, "destinations": destinations }),
                    );
                }
            }
            engine::LiveEvent::SessionEnded { report } => {
                if harness {
                    write_json(&harness_dir.join("multi-report.json"), report);
                }
            }
            _ => {}
        }
    });

    if harness {
        // Bridge: config parsed inside the sink is forwarded to the engine's
        // command channel by this relay, keeping the sink non-reentrant.
        let (tx, rx) = std::sync::mpsc::channel::<multi::MultiConfig>();
        *HARNESS_CMD.lock().unwrap() = Some(tx);
        let stop_file = report_dir.join("multi.stop");
        let _ = std::fs::remove_file(&stop_file);
        let go = handle_proxy(&handle);
        std::thread::spawn(move || {
            if let Ok(cfg) = rx.recv() {
                if let Err(e) = go.go_live(cfg) {
                    eprintln!("[live] harness go-live failed: {e}");
                    return;
                }
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if stop_file.exists() {
                        let _ = go.stop_live();
                        let _ = std::fs::remove_file(&stop_file);
                        break;
                    }
                }
            }
        });
    }

    Live {
        handle: Some(handle),
    }
}

#[cfg(have_engine)]
static HARNESS_CMD: std::sync::Mutex<Option<std::sync::mpsc::Sender<multi::MultiConfig>>> =
    std::sync::Mutex::new(None);

/// Cheap clonable proxy for the harness thread (LiveHandle itself stays in Live).
#[cfg(have_engine)]
fn handle_proxy(h: &engine::LiveHandle) -> engine::LiveProxy {
    h.proxy()
}

#[cfg(not(have_engine))]
pub fn init(_app: tauri::AppHandle, _report_dir: PathBuf) -> Live {
    eprintln!("[live] engine artifact not bundled at build time; live disabled");
    Live::disabled()
}

/// Legacy M-L2/M-L3 harnesses (--live-capture-probe / --live-first-light):
/// bootstrap on a bare engine thread and write evidence reports. Mutually
/// exclusive with init() — both paths call obs_startup.
#[cfg(have_engine)]
pub fn startup_probe(report_dir: &Path) {
    let report_dir = report_dir.to_path_buf();
    let args: Vec<String> = std::env::args().collect();
    let run_capture_probe = args.iter().any(|a| a == "--live-capture-probe");
    let first_light_cred = args
        .iter()
        .position(|a| a == "--live-first-light")
        .and_then(|i| args.get(i + 1).cloned());
    std::thread::Builder::new()
        .name("live-engine".into())
        .spawn(move || {
            let report = engine::bootstrap();
            write_json(&report_dir.join("engine-report.json"), &report);
            eprintln!(
                "[live] engine bootstrap ok={} backend={:?}",
                report.ok, report.graphics_backend
            );
            if !report.ok {
                eprintln!("[live] skipping live harness: bootstrap not ok");
                return;
            }
            if run_capture_probe {
                let capture = graph::capture_probe(std::time::Duration::from_secs(8));
                write_json(&report_dir.join("capture-report.json"), &capture);
            }
            if let Some(cred) = first_light_cred {
                let fl = stream::run_first_light(&cred, &report_dir);
                write_json(&report_dir.join("first-light-report.json"), &fl);
            }
        })
        .expect("spawn live-engine thread");
}

#[cfg(not(have_engine))]
pub fn startup_probe(_report_dir: &Path) {
    eprintln!("[live] engine artifact not bundled at build time; live disabled");
}

/// True when a legacy harness flag is present (init() must not also run).
pub fn legacy_harness_requested() -> bool {
    std::env::args().any(|a| a == "--live-capture-probe" || a == "--live-first-light")
}

/// PRODUCER_LIVE_SELFTEST=1 entry: bootstrap headless, print the JSON report
/// on stdout, exit 0 iff every M-L1 required ID was discovered.
#[cfg(have_engine)]
pub fn selftest_main() -> ! {
    let (tx, rx) = std::sync::mpsc::channel::<engine::EngineReport>();
    std::thread::Builder::new()
        .name("live-engine".into())
        .spawn(move || {
            let report = engine::bootstrap();
            let _ = tx.send(report);
        })
        .expect("spawn live-engine thread");

    let report = loop {
        match rx.try_recv() {
            Ok(r) => break r,
            Err(std::sync::mpsc::TryRecvError::Empty) => unsafe {
                ffi::CFRunLoopRunInMode(ffi::kCFRunLoopDefaultMode, 0.05, false);
            },
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                eprintln!("[live] engine thread died during bootstrap");
                std::process::exit(2);
            }
        }
    };
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    std::process::exit(if report.ok { 0 } else { 1 });
}

#[cfg(not(have_engine))]
pub fn selftest_main() -> ! {
    eprintln!("{{\"ok\":false,\"error\":\"built without engine artifact\"}}");
    std::process::exit(2);
}
