//! Producer Live — libobs host (LIVE-REVIEW.md). Compiled against the engine
//! artifact when present (`have_engine` cfg set by build.rs); otherwise the
//! stub keeps the app building on machines/CI without the engine.

#[cfg(have_engine)]
pub mod engine;
#[cfg(have_engine)]
mod ffi;

use std::path::Path;

/// Run the engine bootstrap and persist the discovery report. Called once at
/// app startup; also the workhorse for self-test mode.
#[cfg(have_engine)]
pub fn startup_probe(report_path: &Path) {
    let report_path = report_path.to_path_buf();
    std::thread::spawn(move || {
        let (_cmd_tx, report_rx) = engine::spawn();
        if let Ok(report) = report_rx.recv() {
            if let Some(dir) = report_path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            match serde_json::to_string_pretty(&report) {
                Ok(json) => {
                    let _ = std::fs::write(&report_path, &json);
                    eprintln!(
                        "[live] engine bootstrap ok={} backend={:?} report={}",
                        report.ok,
                        report.graphics_backend,
                        report_path.display()
                    );
                }
                Err(e) => eprintln!("[live] report serialize failed: {e}"),
            }
        }
        // _cmd_tx dropped: engine thread shuts libobs down cleanly.
    });
}

#[cfg(not(have_engine))]
pub fn startup_probe(_report_path: &Path) {
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
