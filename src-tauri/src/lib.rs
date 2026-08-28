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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = store::open(&data_dir.join("producer.db"))
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            app.manage(AppState {
                db: Mutex::new(conn),
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
            ipc::submit_post,
            ipc::outbox_inspect,
            ipc::resume_outbox,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
