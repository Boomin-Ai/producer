mod assets;
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
fn root() -> PathBuf {
    std::env::var_os("PRODUCER_NATIVE_ROOM_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").expect("User home directory"))
                .join("Library/Application Support/Producer Native Dev")
        })
}
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
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
    // Register the native application before filesystem or device permissions can prompt.
    let shared = Arc::new(Mutex::new(None::<Arc<engine::Handle>>));
    let shutdown = shared.clone();
    gpui_platform::application().run(move |cx: &mut App| {
        let handle = match engine::start(root.clone()).and_then(|handle| {
            ipc::serve(&root, handle.clone())?;
            Ok(handle)
        }) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("Native room startup: {e:#}");
                cx.quit();
                return;
            }
        };
        *shared.lock().unwrap() = Some(handle.clone());
        let bounds = Bounds::centered(None, size(px(1440.), px(940.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("Producer Native Dev".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            |_, cx| cx.new(|cx| ui::Room::new(handle, cx)),
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
