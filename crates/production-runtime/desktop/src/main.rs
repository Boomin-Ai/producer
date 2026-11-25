mod marquee;
mod headline;
mod glb;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod virtual_camera;
mod posters;
mod render_graph;
mod weather;
mod room_share;
mod stage_history;
mod take_control;
mod p0_call;
mod producer_rtc;
mod rtc_signaling;
mod program_clock;
mod assets;
mod assistant;
mod assistant_log;
mod assistant_image;
mod clips;
mod studio_audio;
mod dj_visual;
mod broadcast;
mod starter_sets;
mod studio_presets;
mod boomin_account;
#[path = "../../../../src-tauri/src/boomin.rs"]
mod boomin;
mod error {
    #[derive(Debug, thiserror::Error)]
    pub enum EngineError {
        #[error("{0}")]
        Other(String),
        #[error(transparent)]
        Http(#[from] reqwest::Error),
    }
    pub type EngineResult<T> = Result<T, EngineError>;
}
#[path = "../../../../src-tauri/src/clips_media.rs"]
mod clips_media;
mod engine;
mod ipc;
mod model;
mod platform;
mod presentation;
mod recording;
mod take_playback;
mod ui;
mod visual_fixture;
mod visuals;
mod workspace;
use anyhow::Result;
use gpui::{px, size, App, AppContext, Bounds, TitlebarOptions, WindowBounds, WindowOptions};
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex},
    time::{Duration, Instant},
};
static ACTIVE_ROOT:std::sync::RwLock<Option<PathBuf>>=std::sync::RwLock::new(None);
fn root()->PathBuf{ACTIVE_ROOT.read().unwrap().clone().unwrap_or_else(workspace_root)}
fn workspace_root() -> PathBuf {
    std::env::var_os("PRODUCER_NATIVE_ROOM_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            #[cfg(debug_assertions)]
            {
                let exe = std::env::current_exe().ok()?;
                let resources = exe.parent()?.parent()?.join("Resources");
                let profile = PathBuf::from(std::fs::read_to_string(resources.join("witness-profile")).ok()?.trim());
                return (profile.is_absolute() && profile.join("p0-request-microphone").is_file()).then_some(profile);
            }
            #[cfg(not(debug_assertions))]
            None
        })
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").expect("User home directory"))
                .join(if cfg!(debug_assertions) { "Library/Application Support/Producer Native Dev" } else { "Library/Application Support/ai.boomin.producer/native" })
        })
}
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        #[cfg(debug_assertions)]
        Some("--assistant-sign-in") => return assistant::sign_in_check(),
        Some("--assistant-log") => return assistant_log::print(&root(), args.get(2).map_or("latest", String::as_str)),
        Some("--check-set-graph") => {
            anyhow::ensure!(args.len()==4, "Expected set ID and draft JSON path");
            let room: model::RoomProject = serde_json::from_slice(&std::fs::read(root().join("room.json"))?)?;
            let draft = serde_json::from_slice(&std::fs::read(&args[3])?)?;
            engine::set_edit_project(&room, &args[2], &draft)?;
            println!("{}", serde_json::to_string_pretty(&render_graph::inspect(&draft)?)?);
            return Ok(());
        }
        Some("--set-filmstrip") => return posters::filmstrip(&args[2..]),
        Some("--set-posters") => return posters::run(&args[2..], false, false),
        Some("--output-graph-rehearsal") => return posters::run(&args[2..], true, true),
        Some("--render-graph-rehearsal") => return posters::run(&args[2..], true, false),
        _ => {}
    }
    if args.get(1).map(String::as_str)==Some("--forecast-refresh") { return weather::refresh(&root()); }
    if args.get(1).map(String::as_str) == Some("--print-room-link") {
        println!("{}",room_share::link(&root(),room_share::LinkKind::Room)?);
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("--import-worker") {
        return assets::import_worker(
            std::path::Path::new(
                args.get(2)
                    .ok_or_else(|| anyhow::anyhow!("Missing source"))?,
            ),
            std::path::Path::new(
                args.get(3)
                    .ok_or_else(|| anyhow::anyhow!("Missing destination"))?,
            ),
        );
    }
    if args.get(1).map(String::as_str) == Some("--inspect-mov") {
        let path = std::path::Path::new(
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("Missing movie path"))?,
        );
        let mut movie = platform::Movie::open(path)?;
        let frame = movie.frame(movie.start, 1);
        println!(
            "{}",
            serde_json::json!({"duration":movie.duration,"start":movie.start,"frame":frame.as_ref().map(|f|(f.width,f.height))})
        );
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("--visual-fixture") {
        let p = visual_fixture::project(args.get(2).map(String::as_str) == Some("light"));
        p.compile()?;
        println!("{}", serde_json::to_string_pretty(&p)?);
        return Ok(());
    }
    let root = root();
    if args.get(1).map(String::as_str) == Some("--inspect-take") {
        let name = args
            .get(2)
            .ok_or_else(|| anyhow::anyhow!("Missing local take name"))?;
        let track = args
            .get(3)
            .ok_or_else(|| anyhow::anyhow!("Missing track"))?
            .parse()?;
        let mut reader = take_playback::TakeDecoder::open(&root, name, track, None)?;
        let mut samples = Vec::new();
        for (i, at) in args.iter().skip(4).enumerate() {
            let at: f64 = at.parse()?;
            let frame = reader.frame(at, i as u64 + 1)?;
            let mut pcm = [0.; 960];
            reader.read(at, i as u64 + 1, &mut pcm)?;
            samples.push(serde_json::json!({"at":at,"frame":frame.as_ref().map(|f|[f.width,f.height]),"audioRms":(pcm.iter().map(|v|v*v).sum::<f32>()/960.).sqrt()}));
        }
        println!("{}", serde_json::json!({"samples":samples}));
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("--request") {
        return ipc::request(
            &root,
            args.get(2)
                .ok_or_else(|| anyhow::anyhow!("Expected JSON command"))?,
        );
    }
    #[cfg(all(debug_assertions, target_os = "macos"))]
    if root.join("p0-request-microphone").is_file() && args.len() == 1 {
        use std::ffi::CString;
        unsafe extern "C" { fn nr_request_witness_microphone(path: *const std::ffi::c_char); }
        let receipt = CString::new(root.join("p0-microphone-status").as_os_str().as_encoded_bytes())?;
        unsafe { nr_request_witness_microphone(receipt.as_ptr()); }
    }
    // Register the native application before filesystem or device permissions can prompt.
    let shared = Arc::new(Mutex::new(None::<Arc<engine::Handle>>));
    let shutdown = shared.clone();
    let application=gpui_platform::application();

    let pending=Arc::new(Mutex::new(None::<String>));
    let before_launch=pending.clone();
    application.on_open_urls(move |urls|{
        for item in urls {
            let Ok(url)=url::Url::parse(&item) else {continue};
            if url.scheme()!="producer-rtc" || url.host_str()!=Some("join"){continue;}
            let Some((_,link))=url.query_pairs().find(|(k,_)|k=="url") else {continue};
            if crate::rtc_signaling::parse(&link).is_err(){continue;}
            *before_launch.lock().unwrap()=Some(link.into_owned());
        }
    });
    application.run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1440.), px(940.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_background:gpui::WindowBackgroundAppearance::Transparent,
                titlebar: Some(TitlebarOptions {
                    title: None, appears_transparent:true, traffic_light_position:Some(gpui::point(px(9.),px(9.))),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |window, cx| {
                use raw_window_handle::{HasWindowHandle,RawWindowHandle};
                if let Ok(handle)=HasWindowHandle::window_handle(&*window){
                    if let RawWindowHandle::AppKit(view)=handle.as_raw(){
                        unsafe extern "C"{fn nr_shell_vibrancy(view:*mut std::ffi::c_void);}
                        unsafe{nr_shell_vibrancy(view.ns_view.as_ptr());}
                    }
                }
                cx.new(|cx| ui::shell::Shell::new(root, shared.clone(), pending, cx))
            },
        )
        .expect("native dev window");
        cx.activate(true);
    });
    if let Some(shutdown) = shutdown.lock().unwrap().as_ref() {
        shutdown.closed.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !shutdown.done.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    Ok(())
}
