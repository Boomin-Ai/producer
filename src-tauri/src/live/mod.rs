//! Producer Live — libobs host (LIVE-REVIEW.md). Compiled against the engine
//! artifact when present (`have_engine` cfg set by build.rs); otherwise the
//! stub keeps the app building on machines/CI without the engine.

#[cfg(have_engine)]
pub mod creds;
#[cfg(have_engine)]
pub mod engine;
#[cfg(have_engine)]
mod ffi;
#[cfg(have_engine)]
pub mod graph;
#[cfg(have_engine)]
pub mod stream;

use std::path::Path;

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

/// Bootstrap the engine on its owner thread and persist the discovery report.
/// When the app was launched with `--live-capture-probe` (M-L2 acceptance
/// harness), also put SCK display + mic sources live in the graph and write
/// the capture evidence report.
#[cfg(have_engine)]
pub fn startup_probe(report_dir: &Path) {
    let report_dir = report_dir.to_path_buf();
    let args: Vec<String> = std::env::args().collect();
    let run_capture_probe = args.iter().any(|a| a == "--live-capture-probe");
    // --live-first-light <credential_id>: M-L3 harness. The argument is an
    // opaque keychain credential ID, never a key (§8).
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
            if !report.ok && (run_capture_probe || first_light_cred.is_some()) {
                eprintln!("[live] skipping live harness: bootstrap not ok");
                return;
            }
            if run_capture_probe {
                let capture = graph::capture_probe(std::time::Duration::from_secs(8));
                write_json(&report_dir.join("capture-report.json"), &capture);
                eprintln!(
                    "[live] capture probe ok={} size={:?} frames={} audio_cbs={}",
                    capture.ok,
                    capture.screen_source_size,
                    capture.rendered_frames,
                    capture.mic_audio_callbacks
                );
            }
            if let Some(cred) = first_light_cred {
                let fl = stream::run_first_light(&cred, &report_dir);
                write_json(&report_dir.join("first-light-report.json"), &fl);
                eprintln!(
                    "[live] first light ok={} encoder={} frames={} dropped={}",
                    fl.ok, fl.encoder_used, fl.total_frames, fl.dropped_frames
                );
            }
            // Engine stays initialized for the app's lifetime; teardown comes
            // with the M-L5 host contract.
        })
        .expect("spawn live-engine thread");
}

#[cfg(not(have_engine))]
pub fn startup_probe(_report_dir: &Path) {
    eprintln!("[live] engine artifact not bundled at build time; live disabled");
}

/// PRODUCER_LIVE_SELFTEST=1 entry: bootstrap headless, print the JSON report
/// on stdout, exit 0 iff every M-L1 required ID was discovered.
/// The main thread pumps the run loop so UI tasks marshalled by the engine
/// thread (§5.1) can drain even with no AppKit app running.
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
