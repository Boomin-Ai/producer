mod boomin;
mod chat;
mod client;
mod error;
mod firewall;
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
    /// Platform chat readers (host-side sockets; see chat::mod docs).
    pub chat: chat::ChatHub,
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Real glass base coat (see shim.m): must run at startup so the
            // home rail's gutter shows the desktop before any room attaches.
            #[cfg(all(target_os = "macos", have_engine))]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(ns) = window.ns_window() {
                        unsafe { live::ffi::producer_apply_window_vibrancy(ns) };
                    }
                }
            }
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
                chat: chat::ChatHub::new(app.handle().clone()),
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
            ipc::pref_get,
            ipc::pref_set,
            ipc::endpoint_channels,
            ipc::boomin_request_otp,
            ipc::boomin_connect,
            ipc::boomin_select_brand,
            ipc::boomin_list_brands,
            ipc::boomin_add_brand,
            ipc::connect_channel,
            ipc::disconnect_channel,
            ipc::network_join,
            ipc::network_invite_email,
            ipc::network_status,
            ipc::network_invitations,
            ipc::network_invite,
            ipc::network_invitation_action,
            ipc::network_lookup,
            ipc::console_open,
            ipc::network_live_rooms,
            ipc::network_enter_room,
            ipc::network_deals,
            ipc::network_propose_deal,
            ipc::network_deal_action,
            ipc::network_deal_enter,
            live::commands::copy_text,
            ipc::room_set_visibility,
            ipc::room_set_default,
            ipc::live_room_open_report,
            ipc::room_register,
            firewall::firewall_status,
            firewall::firewall_allow,
            ipc::room_list_server,
            ipc::room_set_title,
            ipc::room_delete,
            ipc::room_guest_invite,
            ipc::room_guests,
            ipc::room_guest_admit,
            ipc::room_set_stage,
            ipc::room_guest_revoke,
            ipc::room_join_link,
            ipc::room_access,
            ipc::room_guest_order,
            ipc::network_connections,
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
            live::commands::live_set_sources,
            live::commands::live_attach_preview,
            live::commands::live_move_preview,
            live::commands::live_detach_preview,
            live::commands::live_permissions,
            live::commands::live_set_thumb_rate,
            live::commands::live_home_glass,
            live::commands::live_request_permission,
            live::commands::live_set_overlay,
            live::commands::live_list_windows,
            live::commands::live_screen_coach,
            live::commands::firstlight_resume,
            live::commands::live_set_mic_audio,
            live::commands::live_set_video,
            live::commands::live_set_transform,
            live::commands::live_set_selection,
            live::commands::live_preview_cutouts,
            live::commands::live_source_devices,
            live::commands::live_add_source,
            live::commands::live_remove_source,
            live::commands::live_pick_file,
            live::commands::live_play_stinger,
            live::commands::live_prepare_stinger,
            live::commands::live_vcam_status,
            live::commands::live_vcam_activate,
            live::commands::live_vcam_output,
            live::commands::live_filters,
            live::commands::live_set_opacity,
            live::commands::live_set_source_audio,
            live::commands::live_set_sync_offset,
            live::commands::live_start_recording,
            live::commands::live_stop_recording,
            live::commands::live_reveal_file,
            live::commands::live_stop_stinger,
            live::commands::live_set_source_device,
            live::commands::live_preview_hidden,
            live::commands::live_open_chat,
            live::commands::live_list_rooms,
            live::commands::live_create_room,
            live::commands::live_update_room,
            live::commands::live_delete_room,
            chat::commands::chat_connect,
            chat::commands::chat_disconnect,
            chat::commands::chat_status,
            chat::commands::kick_resolve_chatroom,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                // Dock click must ALWAYS raise the main window. macOS skips
                // the default raise when the app already has a visible
                // window — the First Light drag chip (a floating NSPanel)
                // counts as one, leaving the main window buried.
                // (Reopen only exists on macOS/iOS.)
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(win) = app.webview_windows().into_values().next() {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                // §5.5: no daemon — closing Producer ends the stream. The
                // engine bounds the stop wait itself (≤ ~15s with an active
                // session).
                tauri::RunEvent::Exit => {
                    let state = app.state::<AppState>();
                    state.chat.disconnect_all();
                    state.live.shutdown();
                }
                _ => {}
            }
        });
}
