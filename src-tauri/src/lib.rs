mod boomin;
mod client;
mod error;
mod ipc;
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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = store::open(&data_dir.join("producer.db"))
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            app.manage(AppState {
                db: Mutex::new(conn),
                pending_auth: Mutex::new(None),
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
            ipc::upload_media,
            ipc::list_jobs,
            ipc::submit_post,
            ipc::outbox_inspect,
            ipc::resume_outbox,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
