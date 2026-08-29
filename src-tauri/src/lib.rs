mod boomin;
mod client;
mod error;
mod ipc;
mod live;
mod outbox;
mod store;
mod submit;
mod vault;

use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    /// Mid-sign-in hosted auth (api_root, token) held engine-side between
    /// OTP verification and workspace selection — never enters the webview.
    pub pending_auth: Mutex<Option<(String, String)>>,
    /// LiveEngine facade (LIVE-REVIEW.md §5.1): commands in, events out via
    /// the `live://event` channel; stream keys never pass through here.
    pub live: live::Live,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Headless engine self-test (M-L1 acceptance harness): bootstrap libobs,
    // print the discovery report, exit — no window, no webview.
    if std::env::var("PRODUCER_LIVE_SELFTEST").is_ok() {
        live::selftest_main();
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = store::open(&data_dir.join("producer.db"))
                .map_err(|e| std::io::Error::other(e.to_string()))?;

            // Live engine. Legacy evidence harnesses (--live-capture-probe /
            // --live-first-light) bootstrap on a bare thread; every other
            // launch gets the real LiveEngine (M-L5 host contract), which
            // also carries the --live-multistream harness.
            let live = if live::legacy_harness_requested() {
                live::startup_probe(&data_dir.join("live"));
                live::Live::disabled()
            } else {
                live::init(app.handle().clone(), data_dir.join("live"))
            };

            app.manage(AppState {
                db: Mutex::new(conn),
                pending_auth: Mutex::new(None),
                live,
            });

            // Resume any submissions a crash left unacknowledged.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                if let Err(e) = submit::submit_pending(&state.db, None).await {
                    eprintln!("outbox resume failed: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::list_endpoints,
            ipc::add_endpoint,
            ipc::remove_endpoint,
            ipc::endpoint_channels,
            ipc::boomin_request_otp,
            ipc::boomin_connect,
            ipc::boomin_select_brand,
            ipc::connect_channel,
            ipc::upload_media,
            ipc::list_jobs,
            ipc::submit_post,
            ipc::outbox_inspect,
            ipc::resume_outbox,
            live::commands::live_list_destinations,
            live::commands::live_upsert_destination,
            live::commands::live_delete_destination,
            live::commands::live_go_live,
            live::commands::live_stop,
            live::commands::live_engine_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // §5.5: no daemon — closing Producer ends the stream. The engine
            // bounds the stop wait itself (≤ ~15s with an active session).
            if let tauri::RunEvent::Exit = event {
                app.state::<AppState>().live.shutdown();
            }
        });
}
