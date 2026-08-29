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
    pub fn go_live_specs(&self, specs: Vec<(String, String, Option<String>, String)>) -> Result<(), String> {
        let handle = self.handle.as_ref().ok_or("live engine not running")?;
        let destinations = specs
            .into_iter()
            .map(|(id, preset, server, credential_id)| multi::DestinationSpec {
                id,
                kind: preset,
                credential_id,
                server,
            })
            .collect();
        handle.go_live(multi::MultiConfig { destinations })
    }
    #[cfg(not(have_engine))]
    pub fn go_live_specs(&self, _specs: Vec<(String, String, Option<String>, String)>) -> Result<(), String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn stop_live(&self) -> Result<(), String> {
        self.handle.as_ref().ok_or("live engine not running")?.stop_live()
    }
    #[cfg(not(have_engine))]
    pub fn stop_live(&self) -> Result<(), String> {
        Err("live engine not bundled in this build".into())
    }

    #[cfg(have_engine)]
    pub fn status(&self) -> serde_json::Value {
        match &self.handle {
            Some(h) => serde_json::to_value(h.snapshot.lock().unwrap().clone()).unwrap_or_default(),
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

    let handle = engine::start(move |ev| {
        let _ = app.emit("live://event", ev);
        match ev {
            engine::LiveEvent::EngineReady { ok, .. } => {
                if harness && *ok {
                    let cfg_path = harness_dir.join("multi-config.json");
                    match std::fs::read_to_string(&cfg_path)
                        .map_err(|e| e.to_string())
                        .and_then(|s| serde_json::from_str::<multi::MultiConfig>(&s).map_err(|e| e.to_string()))
                    {
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

    Live { handle: Some(handle) }
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
