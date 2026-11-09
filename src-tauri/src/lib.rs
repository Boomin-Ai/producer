mod boomin;
mod cache;
mod chat;
mod client;
mod dj;
mod error;
mod firewall;
mod http_transport;
mod ipc;
mod live;
mod outbox;
mod performance_share;
mod performance_trace;
mod recordings;
mod rtc_appearance;
#[cfg(feature = "guest-rtc-pilot")]
mod rtc_control;
mod rtc_ipc;
#[cfg(feature = "guest-rtc-pilot")]
mod rtc_owner;
mod set_library;
mod set_media;
mod soundboard;
mod soundboard_remote;
mod storage;
mod store;
mod submit;
mod vault;
#[cfg(target_os = "macos")]
mod window;

use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
    pub rtc_appearance: std::sync::Arc<tokio::sync::Mutex<Option<rtc_appearance::AppearanceOwner>>>,
    #[cfg(feature = "guest-rtc-pilot")]
    pub rtc_host: std::sync::Arc<tokio::sync::Mutex<Option<rtc_owner::HostOwner>>>,
    #[cfg(feature = "guest-rtc-pilot")]
    pub rtc_host_epoch: std::sync::Arc<std::sync::atomic::AtomicU64>,
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

fn observe_command_dispatch<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let stage = match invoke.message.command() {
            "live_engine_status" => Some("native.engine_status.received"),
            "live_rtc_start" => Some("native.rtc.start.received"),
            "live_rtc_stop" => Some("native.rtc.stop.received"),
            "live_home_glass" => Some("native.window.home_glass.received"),
            "live_portrait_stop" => Some("native.portrait.stop.received"),
            _ => None,
        };
        if let Some(stage) = stage {
            performance_trace::native_stage(stage, std::time::Duration::ZERO, None);
        }
        handler(invoke)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(
        feature = "sets-v2-dev",
        have_engine,
        debug_assertions,
        target_os = "macos"
    ))]
    if std::env::var("PRODUCER_THUMB_RESTORE_SELFTEST").as_deref() == Ok("1") {
        // libobs stays on one worker while Cocoa tasks have a live main queue.
        // Rust's unit-test runner blocks that queue while joining its workers.
        std::thread::spawn(|| {
            let result = std::panic::catch_unwind(live::graph::thumbnail_restore_selftest);
            std::process::exit(if result.is_ok() { 0 } else { 1 });
        });
        extern "C" {
            fn dispatch_main() -> !;
        }
        unsafe {
            dispatch_main();
        }
    }
    #[cfg(feature = "guest-rtc-production")]
    {
        // Configure the timestamped SDK adapter before any native factory is
        // created. Production users do not need shell environment flags.
        std::env::set_var("LIVEKIT_LAB_TIMED_MIXER", "1");
        std::env::set_var("LIVEKIT_LAB_RTCP_PROBE", "1");
    }
    #[cfg(all(
        feature = "guest-rtc-pilot",
        have_engine,
        debug_assertions,
        target_os = "macos"
    ))]
    if std::env::var("PRODUCER_RTC_THUMB_PROOF").as_deref() == Ok("1") {
        live::graph::thumbnail_selftest();
        return;
    }
    #[cfg(all(
        feature = "guest-rtc-pilot",
        have_engine,
        debug_assertions,
        target_os = "macos"
    ))]
    if std::env::var("PRODUCER_RTC_TAP_PROOF").as_deref() == Ok("1") {
        live::rtc_program::tap_selftest();
        return;
    }

    #[cfg(all(
        feature = "guest-rtc-pilot",
        have_engine,
        debug_assertions,
        target_os = "macos"
    ))]
    if std::env::var("PRODUCER_RTC_PROGRAM_PROOF").as_deref() == Ok("1") {
        if let Err(message) = rtc_owner::program_selftest() {
            eprintln!("{message}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(all(feature = "guest-rtc-pilot", debug_assertions))]
    if let Some(path) = std::env::var_os("PRODUCER_RTC_CONNECTION_PROOF") {
        if let Err(message) = rtc_owner::selftest(std::path::Path::new(&path)) {
            eprintln!("{message}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(all(feature = "guest-rtc-pilot", debug_assertions))]
    if let Some(path) = std::env::var_os("PRODUCER_RTC_CONTROL_PROOF") {
        if let Err(message) = rtc_control::selftest(std::path::Path::new(&path)) {
            eprintln!("{message}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(all(have_engine, debug_assertions))]
    if std::env::var_os("PRODUCER_PROGRAM_SELFTEST").is_some() {
        live::program_audio::verification::run();
    }
    #[cfg(all(have_engine, debug_assertions))]
    if std::env::var_os("PRODUCER_DJ_SELFTEST").is_some() {
        live::dj::selftest_main();
    }
    #[cfg(all(have_engine, debug_assertions))]
    if std::env::var_os("PRODUCER_SOUNDBOARD_SELFTEST").is_some() {
        live::soundboard::selftest();
    }
    // Headless engine self-test (M-L1 acceptance harness): bootstrap libobs,
    // print the discovery report, exit — no window, no webview.
    if std::env::var("PRODUCER_LIVE_SELFTEST").is_ok() {
        live::selftest_main();
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            set_media::init(app.handle()).map_err(std::io::Error::other)?;
            #[cfg(debug_assertions)]
            if std::env::var_os("PRODUCER_SET_OUTPUT_PROBE").is_some() {
                if let Some(window) = app.get_webview_window("main") {
                    window.navigate(
                        "http://localhost:1420/scripts/native-probe.html"
                            .parse()
                            .unwrap(),
                    )?;
                }
            }
            // The window glass belongs to the app shell, including builds
            // without the live engine used for frontend development.
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(ns) = window.ns_window() {
                        window::apply_vibrancy(ns);
                    }
                }
            }
            #[cfg(all(feature = "guest-rtc-pilot", debug_assertions))]
            if std::env::var("PRODUCER_RTC_ROOM_DEV_FIXTURE").as_deref() == Ok("1")
                && app.config().identifier != "ai.boomin.producer.rtc-pilot"
            {
                return Err(std::io::Error::other(
                    "RTC development requires its isolated app identifier",
                )
                .into());
            }
            #[cfg(feature = "sets-v2-dev")]
            if app.config().identifier != "ai.boomin.producer.sets-v2-dev" {
                return Err(std::io::Error::other(
                    "Sets v2 development requires its isolated app identifier",
                )
                .into());
            }
            #[cfg(feature = "sets-v2-dev")]
            {
                // Plain cargo staging embeds an older frontend. Always load the
                // live frontend in this isolated development-only app, including
                // normal reopen; inspection must preserve the configured room.
                if let Some(window) = app.get_webview_window("main") {
                    let probe = std::env::var("PRODUCER_SETS_V2_UI_PROBE").as_deref() == Ok("1");
                    let url = if !probe {
                        "http://localhost:1436/?roomInspect=1"
                    } else if std::env::var("PRODUCER_SETS_V2_APPLY_PROBE").as_deref() == Ok("1") {
                        "http://localhost:1436/?roomInspect=1&roomApplyCheck=1"
                    } else if std::env::var("PRODUCER_SETS_V2_INSPECT").as_deref() == Ok("1") {
                        "http://localhost:1436/?roomInspect=1"
                    } else if std::env::var("PRODUCER_SETS_V2_COLOR_PROBE").as_deref() == Ok("1") {
                        "http://localhost:1436/?roomSmoke=1&roomShowcase=1&roomColor=1"
                    } else if std::env::var("PRODUCER_SETS_V2_SHOWCASE_PROBE").as_deref() == Ok("1")
                    {
                        "http://localhost:1436/?roomSmoke=1&roomShowcase=1"
                    } else if std::env::var("PRODUCER_SETS_V2_RESOLUTION_PROBE").as_deref()
                        == Ok("1")
                    {
                        "http://localhost:1436/?roomSmoke=1&roomResolution=1"
                    } else if std::env::var("PRODUCER_SETS_V2_TIMING_PROBE").as_deref() == Ok("1") {
                        "http://localhost:1436/?roomSmoke=1&roomTiming=1"
                    } else {
                        "http://localhost:1436/?roomSmoke=1"
                    };
                    window.navigate(url.parse().unwrap())?;
                }
            }
            let data_dir = app.path().app_data_dir()?;
            #[cfg(feature = "sets-v2-dev")]
            let data_dir = data_dir.join("sets-v2-dev");
            #[cfg(feature = "portrait-camera-dev")]
            let data_dir = data_dir.join("portrait-camera-dev");
            std::fs::create_dir_all(&data_dir)?;
            let conn = store::open(&data_dir.join("producer.db"))
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            recordings::recover(&conn).map_err(|e| std::io::Error::other(e.to_string()))?;
            #[cfg(all(feature = "guest-rtc-pilot", debug_assertions))]
            rtc_ipc::seed_dev_room(&conn, &app.config().identifier)
                .map_err(std::io::Error::other)?;

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
                #[cfg(all(feature = "guest-rtc-pilot", have_engine))]
                rtc_appearance: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
                #[cfg(feature = "guest-rtc-pilot")]
                rtc_host: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
                #[cfg(feature = "guest-rtc-pilot")]
                rtc_host_epoch: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
                db: Mutex::new(conn),
                pending_auth: Mutex::new(None),
                live,
                chat: chat::ChatHub::new(app.handle().clone()),
            });

            #[cfg(all(have_engine, target_os = "macos", feature = "portrait-camera-dev"))]
            if let Some(report) = std::env::var_os("PRODUCER_PORTRAIT_CAMERA_PROBE") {
                live::portrait_camera_probe::start(app.handle().clone(), report.into());
            }

            if let Err(error) = performance_trace::init(app.handle()) {
                eprintln!("Performance diagnostics unavailable: {error}");
            }
            if let Err(error) = performance_share::init(app.handle()) {
                eprintln!("Performance sharing unavailable: {error}");
            }
            soundboard_remote::start(app.handle().clone());

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
        .invoke_handler(observe_command_dispatch(tauri::generate_handler![
            performance_trace::performance_trace_config,
            performance_trace::performance_trace_set_consent,
            performance_trace::performance_trace_write,
            performance_trace::performance_trace_export,
            performance_share::performance_trace_save_export,
            performance_share::performance_trace_upload,
            performance_share::performance_trace_configure_sharing,
            performance_share::performance_trace_revoke,
            rtc_ipc::live_rtc_start,
            rtc_ipc::live_rtc_enabled,
            rtc_ipc::live_rtc_stop,
            rtc_appearance::live_appearance_enabled,
            rtc_appearance::live_appearance_start,
            rtc_appearance::live_appearance_status,
            rtc_appearance::live_appearance_controls,
            rtc_appearance::live_appearance_preview,
            rtc_appearance::live_appearance_stop,
            set_media::set_media_import,
            set_media::set_media_resolve,
            set_library::set_library_list,
            set_library::set_library_read,
            set_library::set_library_save,
            ipc::list_endpoints,
            ipc::add_endpoint,
            ipc::remove_endpoint,
            cache::manager_cache_scope,
            cache::manager_cache_get,
            cache::manager_cache_set,
            storage::producer_storage_usage,
            ipc::pref_get,
            ipc::pref_set,
            recordings::recordings_list,
            recordings::recordings_sync,
            recordings::recording_by_path,
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
            ipc::endpoint_request,
            ipc::room_guest_order,
            ipc::room_mod_link,
            ipc::room_control_session,
            ipc::room_channel_ticket,
            ipc::room_publish_scenes,
            ipc::room_scene_cut,
            ipc::room_contributions,
            ipc::room_run,
            ipc::room_overlay,
            ipc::room_interactions,
            ipc::room_interaction_create,
            ipc::room_interaction_transition,
            ipc::room_audience_link,
            live::bridge::overlay_bridge_start,
            live::bridge::chat_overlay_start,
            live::bridge::chat_overlay_update,
            live::bridge::overlay_bridge_set,
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
            live::commands::live_attach_preview,
            live::commands::live_move_preview,
            live::commands::live_detach_preview,
            live::commands::live_release_idle_room,
            live::commands::live_permissions,
            live::commands::live_set_thumb_rate,
            live::commands::live_set_preview_sources,
            live::commands::live_set_program_thumb,
            live::commands::ui_log,
            live::commands::ui_diagnostics,
            live::commands::live_home_glass,
            live::commands::live_request_permission,
            live::commands::live_set_overlay,
            live::commands::live_set_studio,
            live::commands::live_list_windows,
            live::commands::live_screen_coach,
            live::commands::firstlight_resume,
            live::commands::live_set_video,
            live::commands::live_set_transform,
            live::commands::live_apply_scene,
            live::commands::live_set_status,
            live::commands::live_set_v2,
            live::commands::live_set_v2_enabled,
            live::commands::live_set_v2_capabilities,
            live::commands::live_set_v2_scene3d_enabled,
            live::commands::live_set_source_create,
            live::commands::live_set_v2_report,
            live::commands::live_set_v2_smoke_enabled,
            live::commands::live_set_v2_dev_workspace,
            live::commands::live_portrait_room,
            live::commands::live_portrait_state,
            live::commands::live_select_output,
            live::commands::live_virtual_cam_mirror,
            live::commands::live_program_video_wanted,
            live::commands::live_program_video_read,
            live::commands::live_portrait_transform,
            live::commands::live_portrait_preview,
            live::commands::live_portrait_apply,
            live::commands::live_portrait_warm,
            live::commands::live_portrait_stop,
            live::commands::live_portrait_frame,
            live::commands::live_set_apply,
            live::commands::live_set_warm,
            live::commands::live_set_return,
            live::commands::live_restore_room,
            live::commands::live_replace_source,
            live::commands::live_transcription_start,
            live::commands::live_transcription_stop,
            live::commands::live_program_audio_start,
            live::commands::live_program_audio_read,
            live::commands::live_program_audio_stop,
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
            live::commands::live_vcam_setup,
            live::commands::live_vcam_output,
            live::commands::live_filters,
            live::commands::live_set_opacity,
            live::commands::live_set_source_audio,
            dj::dj_library,
            dj::dj_import,
            dj::dj_save_playlist,
            dj::dj_update_track,
            dj::dj_analyze,
            dj::dj_match_tempo,
            dj::dj_control,
            soundboard::soundboard_activate,
            soundboard::soundboard_control,
            soundboard::soundboard_library,
            soundboard::soundboard_import,
            soundboard::soundboard_save,
            soundboard::soundboard_pairing,
            soundboard::soundboard_hotkeys,
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
        ]))
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
                #[cfg(feature = "guest-rtc-pilot")]
                tauri::RunEvent::ExitRequested { api, .. } => {
                    static CLOSING: std::sync::atomic::AtomicU8 =
                        std::sync::atomic::AtomicU8::new(0);
                    if CLOSING.load(std::sync::atomic::Ordering::Acquire) != 2 {
                        api.prevent_exit();
                        if CLOSING
                            .compare_exchange(
                                0,
                                1,
                                std::sync::atomic::Ordering::AcqRel,
                                std::sync::atomic::Ordering::Acquire,
                            )
                            .is_ok()
                        {
                            let app = app.clone();
                            // Await native observers/SDK close off the macOS main
                            // thread before the existing engine shutdown path.
                            tauri::async_runtime::spawn(async move {
                                let state = app.state::<AppState>();
                                let _ = rtc_appearance::stop_all(&state).await;
                                let _ = rtc_ipc::stop_host(&state).await;
                                CLOSING.store(2, std::sync::atomic::Ordering::Release);
                                app.exit(0);
                            });
                        }
                    }
                }
                tauri::RunEvent::Exit => {
                    let state = app.state::<AppState>();
                    state.chat.disconnect_all();
                    state.live.shutdown();
                }
                _ => {}
            }
        });
}
