mod marquee;
mod headline;
mod glb;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod virtual_camera;
#[cfg(debug_assertions)]
mod authoring_bench;
mod posters;
mod inspect_picture;
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
mod authored_set;
mod assistant_log;
mod assistant_image;
mod clips;
mod studio_audio;
mod dj_visual;
mod broadcast;
mod starter_sets;
mod speaker_split;
mod host_director;
mod show_playback;
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
mod set_slots;
mod platform;
mod presentation;
mod recording;
mod take_playback;
mod rune_studio;
mod visual_fixture;
mod visuals;
mod workspace;
use anyhow::{Context, Result};

use std::{
    path::PathBuf,

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
        #[cfg(debug_assertions)]
        Some("--copy-guest-link") => {
            let room_root = root();
            let project: model::RoomProject = serde_json::from_slice(&std::fs::read(room_root.join("room.json"))?)?;
            boomin_account::link_dev_room(&workspace_root(), &room_root, &project.room, &project.production.title)?;
            room_share::copy_url(&room_share::link(&room_root, room_share::LinkKind::Guest)?)?;
            println!("Guest invitation copied");
            return Ok(());
        }
        Some("--assistant-log") => return assistant_log::print(&root(), args.get(2).map_or("latest", String::as_str)),
        Some("--export-authored-set") => {
            anyhow::ensure!(args.len()==4,"Expected set ID and new package folder");
            return authored_set::package::export(&root(),&args[2],std::path::Path::new(&args[3]));
        }
        Some("--import-authored-set") => {
            anyhow::ensure!((3..=4).contains(&args.len()),"Expected package folder and optional new set ID");
            return authored_set::package::import(&root(),std::path::Path::new(&args[2]),args.get(3).map(String::as_str));
        }
        Some("--rehearse-authored-set") => {
            anyhow::ensure!((4..=5).contains(&args.len()), "Expected design JSON, preview directory and optionally a new rehearsal studio directory");
            // A portable rehearsal starts from generated sources. Exporting it cannot carry
            // device assignments, recordings, credentials or projects from the running studio.
            let mut room: model::RoomProject = if args.get(4).is_some() {
                model::RoomProject::demo()
            } else {
                serde_json::from_slice(&std::fs::read(root().join("room.json"))?)?
            };
            let design: serde_json::Value=serde_json::from_slice(&std::fs::read(&args[2])?)?;
            let id=design["id"].as_str().context("Missing set ID")?.to_owned();
            authored_set::prepare(&room, design)?.install(&mut room)?;
            render_graph::inspect(&room.production.sets[&id])?;
            posters::authored_pairs(&room,&id,std::path::Path::new(&args[3]), |_| Ok(()))?;
            if let Some(dir) = args.get(4) {
                use std::io::Write;
                room.room.clone_from(&id);
                room.production.title = id.replace('-', " ");
                room.mount_set(Some(id), None)?;
                let bytes = serde_json::to_vec_pretty(&room)?;
                std::fs::create_dir(dir).context("Choose a new rehearsal studio directory")?;
                let mut file = tempfile::NamedTempFile::new_in(dir)?;
                file.write_all(&bytes)?;
                file.persist_noclobber(std::path::Path::new(dir).join("room.json"))?;
            }
            return Ok(());
        }
        #[cfg(debug_assertions)]
        Some("--qualify-author-load") => return authoring_bench::loaded(&args[2..]),
        #[cfg(debug_assertions)]
        Some("--benchmark-author-edits") => return authoring_bench::run(&args[2..]),
        #[cfg(debug_assertions)]
        Some("--rehearse-layout-cues") => return engine::motion_rehearsal::run(&args[2..]),
        Some("--inspect-set-picture") => {
            anyhow::ensure!(args.len() == 4, "Expected query JSON file and output directory");
            let room = serde_json::from_slice(&std::fs::read(root().join("room.json"))?)?;
            let query = serde_json::from_slice(&std::fs::read(&args[2])?)?;
            println!("{}", inspect_picture::capture(&root(), &room, query, std::path::Path::new(&args[3]))?);
            return Ok(());
        }
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
    rune_studio::run();
    Ok(())
}
