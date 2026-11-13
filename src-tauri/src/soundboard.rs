//! Persistent room boards and the shared UI / Stream Deck command boundary.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Instant;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::Emitter;
use tauri::Manager;
static STORE: Mutex<()> = Mutex::new(());
pub fn install_bundled(
    app: &tauri::AppHandle,
    assets: &[crate::builtin_audio::InstalledAudio],
) -> Result<(), String> {
    let _lock = STORE.lock().map_err(|e| e.to_string())?;
    let root = root(app)?;
    let mut sounds: Vec<Sound> = read(&root.join("library.json"))?;
    for a in assets.iter().filter(|a| a.kind == "effect") {
        if !sounds.iter().any(|s| s.id == a.sha256) {
            sounds.push(Sound {
                id: a.sha256.clone(),
                name: a.name.clone(),
                path: a.path.clone(),
            });
        }
    }
    save(&root.join("library.json"), &sounds)
}
static VISUAL_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static VISUAL: Mutex<Option<(Instant, SoundVisual)>> = Mutex::new(None);
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundVisual {
    pub sequence: u64,
    pub label: String,
    pub age_ms: u64,
}
pub fn visual_sequence() -> u64 {
    VISUAL_SEQUENCE.load(Ordering::Acquire)
}
pub fn visual_event() -> Option<SoundVisual> {
    let visual = VISUAL.lock().ok()?;
    let (at, event) = visual.as_ref()?;
    let age = at.elapsed().as_millis() as u64;
    (age < 3000).then(|| SoundVisual {
        age_ms: age,
        ..event.clone()
    })
}
pub fn clear_visual() {
    if let Ok(mut visual) = VISUAL.lock() {
        *visual = None;
        VISUAL_SEQUENCE.fetch_add(1, Ordering::Release);
    }
}
fn publish_visual(app: &tauri::AppHandle, room: &str, label: &str) {
    let event = {
        let Ok(active) = ACTIVE.lock() else { return };
        if active.as_deref() != Some(room) {
            return;
        }
        let Ok(mut visual) = VISUAL.lock() else {
            return;
        };
        let sequence = VISUAL_SEQUENCE.load(Ordering::Relaxed) + 1;
        let event = SoundVisual {
            sequence,
            label: label.chars().take(64).collect(),
            age_ms: 0,
        };
        *visual = Some((Instant::now(), event.clone()));
        VISUAL_SEQUENCE.store(sequence, Ordering::Release);
        event
    };
    let _ = app.emit("soundboard-trigger", event);
}
static GENERATION: AtomicU64 = AtomicU64::new(0);
static PREVIEW_GENERATION: AtomicU64 = AtomicU64::new(0);
pub fn preview_current(ticket: u64) -> bool {
    PREVIEW_GENERATION.load(Ordering::SeqCst) == ticket
}
pub fn cancel_previews() {
    PREVIEW_GENERATION.fetch_add(1, Ordering::SeqCst);
}
fn preview_ticket(request: &Request) -> Option<u64> {
    matches!(
        request.action.as_str(),
        "preview" | "stop_preview" | "stop_all"
    )
    .then(|| PREVIEW_GENERATION.fetch_add(1, Ordering::SeqCst) + 1)
}
static DECODE: Mutex<()> = Mutex::new(());
pub static ACTIVE: Mutex<Option<String>> = Mutex::new(None);
pub static REMOTE: OnceLock<Pairing> = OnceLock::new();
#[derive(Clone, Serialize, Deserialize)]
pub struct Sound {
    pub id: String,
    pub name: String,
    pub path: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Pad {
    pub id: String,
    pub name: String,
    pub color: String,
    pub mode: String,
    pub volume: f32,
    pub fade_ms: u32,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Board {
    pub pads: Vec<Pad>,
    pub volume: f32,
    pub monitor: bool,
}
impl Default for Board {
    fn default() -> Self {
        Self {
            pads: vec![],
            volume: 0.8,
            monitor: true,
        }
    }
}
#[derive(Clone, Serialize)]
pub struct Library {
    pub sounds: Vec<Sound>,
    pub board: Board,
}
#[derive(Clone, Serialize)]
pub struct Pairing {
    pub port: u16,
    pub token: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Request {
    pub room: String,
    pub action: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub value: Option<f32>,
}
#[derive(Default, Clone, Serialize)]
pub struct Status {
    pub room: String,
    pub playing: Vec<String>,
    pub previewing: Vec<String>,
    pub cached_bytes: usize,
    pub volume: f32,
    pub monitor: bool,
}
pub enum Native {
    Activate(String),
    Has(String, u64),
    Load(String, u64, Vec<f32>),
    Trigger(String, u64, i32, f32, u32, bool),
    Audition(String, u64, f32, u32, u64),
    StopPreview(String, u64),
    Stop(String),
    Mix(String, f32, bool),
    Status(String),
}
pub enum Reply {
    Status(Status),
    Cached(bool),
}
fn key(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub fn numeric(id: &str) -> Result<u64, String> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid sound ID".into());
    }
    u64::from_str_radix(&id[..16], 16).map_err(|e| e.to_string())
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let p = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("soundboard");
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}
fn read<T: serde::de::DeserializeOwned + Default>(p: &Path) -> Result<T, String> {
    if !p.exists() {
        return Ok(T::default());
    }
    serde_json::from_slice(&std::fs::read(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn save<T: Serialize>(p: &Path, value: &T) -> Result<(), String> {
    let t = p.with_extension("tmp");
    std::fs::write(&t, serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?; // serialize under STORE
    std::fs::rename(t, p).map_err(|e| e.to_string())
}
fn board_path(root: &Path, room: &str) -> PathBuf {
    root.join(format!("room-{}.json", key(room.as_bytes())))
}
fn validate(b: &Board) -> Result<(), String> {
    if b.pads.len() > 500 || !b.volume.is_finite() || !(0.0..=1.0).contains(&b.volume) {
        return Err("Invalid soundboard level or size".into());
    }
    let mut ids = std::collections::HashSet::new();
    for p in &b.pads {
        numeric(&p.id)?;
        if !ids.insert(&p.id)
            || p.name.len() > 160
            || !matches!(p.mode.as_str(), "restart" | "toggle" | "overlap" | "loop")
            || !p.volume.is_finite()
            || !(0.0..=1.0).contains(&p.volume)
            || p.fade_ms > 5000
            || p.color.len() != 7
            || !p.color.starts_with('#')
            || !p.color[1..].bytes().all(|x| x.is_ascii_hexdigit())
        {
            return Err("Invalid sound pad".into());
        }
    }
    Ok(())
}
fn library(app: &tauri::AppHandle, room: &str) -> Result<Library, String> {
    let _g = STORE.lock().map_err(|e| e.to_string())?;
    let r = root(app)?;
    Ok(Library {
        sounds: read(&r.join("library.json"))?,
        board: read(&board_path(&r, room))?,
    })
}
fn dispatch(app: &tauri::AppHandle, n: Native) -> Result<Reply, String> {
    let state = app.state::<crate::AppState>();
    state.live.clone_handle_for_soundboard()?(n)
}
fn mapped(app: &tauri::AppHandle, s: Status) -> Result<Status, String> {
    let lib = library(app, &s.room)?;
    let map = |items: Vec<String>| {
        items
            .into_iter()
            .filter_map(|n| {
                lib.sounds
                    .iter()
                    .find(|a| numeric(&a.id).ok().map(|v| v.to_string()) == Some(n.clone()))
                    .map(|a| a.id.clone())
            })
            .collect()
    };
    Ok(Status {
        playing: map(s.playing),
        previewing: map(s.previewing),
        ..s
    })
}
fn status(app: &tauri::AppHandle, n: Native) -> Result<Status, String> {
    match dispatch(app, n)? {
        Reply::Status(s) => mapped(app, s),
        _ => Err("Unexpected audio reply".into()),
    }
}
fn ensure_active(room: &str) -> Result<(), String> {
    if ACTIVE.lock().map_err(|e| e.to_string())?.as_deref() != Some(room) {
        return Err("This room is not active".into());
    }
    Ok(())
}
// Decode off the engine thread; at most 60 seconds stereo PCM per effect.
pub(crate) fn pcm(path: &Path) -> Result<Vec<f32>, String> {
    let mut input = vec![];
    let mut format = None;
    crate::dj::decode(path, |samples, rate, channels| {
        if channels == 0 || channels > 2 || rate == 0 {
            return Err("Sound effects must be mono or stereo".into());
        }
        if format.is_some_and(|f| f != (rate, channels)) {
            return Err("Audio format changes mid-file".into());
        }
        format = Some((rate, channels));
        if input.len() + samples.len() > rate as usize * channels * 60 {
            return Err("Sound effects must be 60 seconds or shorter; use DJ for music".into());
        }
        input.extend_from_slice(samples);
        Ok(true)
    })?;
    let (rate, ch) = format.ok_or("No decodable audio")?;
    let frames = input.len() / ch;
    if frames == 0 {
        return Err("Empty audio".into());
    }
    let count = frames * 48000 / rate as usize;
    let mut out = Vec::with_capacity(count * 2);
    for i in 0..count {
        let x = i as f64 * rate as f64 / 48000.;
        let a = x as usize;
        let b = (a + 1).min(frames - 1);
        let t = (x - a as f64) as f32;
        for c in 0..2 {
            let c = c.min(ch - 1);
            let v = input[a * ch + c] * (1. - t) + input[b * ch + c] * t;
            out.push(if v.is_finite() { v.clamp(-1., 1.) } else { 0. });
        }
    }
    Ok(out)
}
fn prepare(app: &tauri::AppHandle, room: &str, sound: &Sound) -> Result<(), String> {
    ensure_active(room)?;
    let n = numeric(&sound.id)?;
    if matches!(
        dispatch(app, Native::Has(room.into(), n))?,
        Reply::Cached(true)
    ) {
        return Ok(());
    }
    let _g = DECODE.lock().map_err(|e| e.to_string())?;
    ensure_active(room)?;
    if matches!(
        dispatch(app, Native::Has(room.into(), n))?,
        Reply::Cached(true)
    ) {
        return Ok(());
    }
    let path = crate::dj::audio_path(&sound.path)?;
    let data = pcm(&path)?;
    ensure_active(room)?;
    dispatch(app, Native::Load(room.into(), n, data))?;
    Ok(())
}
pub fn execute(app: &tauri::AppHandle, r: Request) -> Result<Status, String> {
    ensure_active(&r.room)?;
    let ticket = preview_ticket(&r);
    execute_at(app, r, ticket)
}
fn execute_at(app: &tauri::AppHandle, r: Request, ticket: Option<u64>) -> Result<Status, String> {
    ensure_active(&r.room)?;
    if r.action == "preview" && ticket.is_some_and(|value| !preview_current(value)) {
        return Err("Sound preview cancelled".into());
    }
    let generation = GENERATION.load(Ordering::SeqCst);
    match r.action.as_str() {
        "status" => status(app, Native::Status(r.room)),
        "stop_preview" => status(
            app,
            Native::StopPreview(r.room, ticket.ok_or("Missing preview ticket")?),
        ),
        "stop_all" => {
            GENERATION.fetch_add(1, Ordering::SeqCst);
            let result = status(app, Native::Stop(r.room));
            if result.is_ok() {
                clear_visual();
                let _ = app.emit("soundboard-trigger", Option::<SoundVisual>::None);
            }
            result
        }
        "volume" | "monitor" => {
            let v = r.value.ok_or("Missing value")?;
            if !v.is_finite() || !(0.0..=1.0).contains(&v) {
                return Err("Level must be between zero and one".into());
            }
            let board = {
                let _g = STORE.lock().map_err(|e| e.to_string())?;
                let path = board_path(&root(app)?, &r.room);
                let mut board: Board = read(&path)?;
                if r.action == "volume" {
                    board.volume = v
                } else {
                    board.monitor = v >= 0.5
                }
                save(&path, &board)?;
                board
            };
            status(
                app,
                Native::Mix(r.room.clone(), board.volume, board.monitor),
            )
        }
        "play" | "preview" | "prepare" | "stop" => {
            let lib = library(app, &r.room)?;
            let p = lib.board.pads.iter().find(|p| p.id == r.id);
            if r.action != "preview" && p.is_none() {
                return Err("Sound is not assigned to this room".into());
            }
            let sound = lib
                .sounds
                .iter()
                .find(|s| s.id == r.id)
                .ok_or("Sound file is missing")?;
            if r.action != "stop" {
                prepare(app, &r.room, sound)?;
            }
            if generation != GENERATION.load(Ordering::SeqCst) {
                return Err("Sound trigger cancelled".into());
            }
            if r.action == "preview" {
                return status(
                    app,
                    Native::Audition(
                        r.room,
                        numeric(&r.id)?,
                        p.map_or(0.8, |p| p.volume),
                        p.map_or(5, |p| p.fade_ms),
                        ticket.ok_or("Missing preview ticket")?,
                    ),
                );
            }
            let p = p.ok_or("Sound is not assigned to this room")?;
            if r.action == "prepare" {
                return status(app, Native::Status(r.room));
            }
            let mode = if r.action == "stop" {
                4
            } else if r.action == "preview" {
                0
            } else {
                match p.mode.as_str() {
                    "toggle" => 1,
                    "overlap" => 2,
                    "loop" => 3,
                    _ => 0,
                }
            };
            let reply = status(
                app,
                Native::Trigger(
                    r.room.clone(),
                    numeric(&p.id)?,
                    mode,
                    p.volume,
                    p.fade_ms,
                    r.action == "preview",
                ),
            )?;
            if r.action == "play"
                && generation == GENERATION.load(Ordering::SeqCst)
                && reply.playing.contains(&r.id)
            {
                publish_visual(app, &r.room, &p.name);
            }
            Ok(reply)
        }
        _ => Err("Unknown soundboard action".into()),
    }
}
#[tauri::command]
pub async fn soundboard_control(app: tauri::AppHandle, request: Request) -> Result<Status, String> {
    ensure_active(&request.room)?;
    let ticket = preview_ticket(&request);
    tauri::async_runtime::spawn_blocking(move || execute_at(&app, request, ticket))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn soundboard_activate(app: tauri::AppHandle, room: String) -> Result<Status, String> {
    if room.is_empty() || room.len() > 200 {
        return Err("Invalid room".into());
    }
    let h = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lib = library(&h, &room)?;
        clear_visual();
        cancel_previews();
        GENERATION.fetch_add(1, Ordering::SeqCst);
        let s = status(&h, Native::Activate(room.clone()))?;
        *ACTIVE.lock().map_err(|e| e.to_string())? = Some(room.clone());
        status(
            &h,
            Native::Mix(room.clone(), lib.board.volume, lib.board.monitor),
        )?;
        let warm = lib
            .board
            .pads
            .iter()
            .take(12)
            .filter_map(|p| lib.sounds.iter().find(|s| s.id == p.id).cloned())
            .collect::<Vec<_>>();
        std::thread::spawn(move || {
            for sound in warm {
                if ensure_active(&room).is_err() {
                    break;
                }
                let _ = prepare(&h, &room, &sound);
            }
        });
        Ok(s)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn soundboard_library(app: tauri::AppHandle, room: String) -> Result<Library, String> {
    tauri::async_runtime::spawn_blocking(move || library(&app, &room))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn soundboard_save(
    app: tauri::AppHandle,
    room: String,
    board: Board,
) -> Result<Library, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate(&board)?;
        {
            let _g = STORE.lock().map_err(|e| e.to_string())?;
            let r = root(&app)?;
            let sounds: Vec<Sound> = read(&r.join("library.json"))?;
            if board
                .pads
                .iter()
                .any(|p| !sounds.iter().any(|s| s.id == p.id))
            {
                return Err("Unknown sound in board".into());
            }
            save(&board_path(&r, &room), &board)?;
        }
        if ensure_active(&room).is_ok() {
            status(&app, Native::Mix(room.clone(), board.volume, board.monitor))?;
        }
        library(&app, &room)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn collect(p: &Path, out: &mut Vec<PathBuf>, depth: usize) -> Result<(), String> {
    if out.len() > 500 || depth > 8 {
        return Err("Import at most 500 sounds at a time".into());
    }
    if p.is_dir() {
        for e in std::fs::read_dir(p).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            if !e.file_type().map_err(|e| e.to_string())?.is_symlink() {
                collect(&e.path(), out, depth + 1)?;
            }
        }
    } else if crate::dj::audio_path(&p.to_string_lossy()).is_ok() {
        out.push(p.to_path_buf());
    }
    Ok(())
}
#[tauri::command]
pub async fn soundboard_import(
    app: tauri::AppHandle,
    room: String,
    paths: Vec<String>,
) -> Result<Library, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = vec![];
        for p in paths {
            collect(Path::new(&p), &mut files, 0)?;
        }
        files.sort();
        if files.len() > 500 {
            return Err("Import at most 500 sounds".into());
        }
        let permanent = app
            .path()
            .audio_dir()
            .map_err(|e| e.to_string())?
            .join("Producer/Sounds");
        std::fs::create_dir_all(&permanent).map_err(|e| e.to_string())?;
        let permanent = permanent.canonicalize().map_err(|e| e.to_string())?;
        let _g = STORE.lock().map_err(|e| e.to_string())?;
        let r = root(&app)?;
        let mut sounds: Vec<Sound> = read(&r.join("library.json"))?;
        let mut board: Board = read(&board_path(&r, &room))?;
        for f in files {
            let f = f.canonicalize().map_err(|e| e.to_string())?;
            if f.metadata().map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
                return Err("A sound file exceeds 32 MB; use DJ for long tracks".into());
            }
            let bytes = std::fs::read(&f).map_err(|e| e.to_string())?;
            let id = key(&bytes);
            let name = f
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .replace('-', " ");
            let dest = if f.starts_with(&permanent) {
                f.clone()
            } else {
                let d = permanent.join(format!(
                    "{}.{}",
                    id,
                    f.extension().unwrap_or_default().to_string_lossy()
                ));
                if !d.exists() {
                    std::fs::write(&d, &bytes).map_err(|e| e.to_string())?;
                }
                d
            };
            if !sounds.iter().any(|s| s.id == id) {
                sounds.push(Sound {
                    id: id.clone(),
                    name: name.clone(),
                    path: dest.to_string_lossy().into(),
                });
            }
            if !board.pads.iter().any(|p| p.id == id) {
                board.pads.push(Pad {
                    id,
                    name,
                    color: "#36DFFF".into(),
                    mode: "restart".into(),
                    volume: 0.8,
                    fade_ms: 5,
                });
            }
        }
        validate(&board)?;
        save(&r.join("library.json"), &sounds)?;
        save(&board_path(&r, &room), &board)?;
        Ok(Library { sounds, board })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn soundboard_pairing() -> Result<Pairing, String> {
    REMOTE
        .get()
        .cloned()
        .ok_or("Local controller is unavailable".into())
}

pub fn remote_library(app: &tauri::AppHandle, room: &str) -> Result<Library, String> {
    library(app, room)
}

#[tauri::command]
pub fn soundboard_hotkeys(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };
    let codes = [
        Code::Digit0,
        Code::Digit1,
        Code::Digit2,
        Code::Digit3,
        Code::Digit4,
        Code::Digit5,
        Code::Digit6,
        Code::Digit7,
        Code::Digit8,
        Code::Digit9,
    ];
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    if !enabled {
        return Ok(());
    }
    for (index, code) in codes.into_iter().enumerate() {
        let shortcut = Shortcut::new(
            Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
            code,
        );
        if let Err(e) = app
            .global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let h = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let result = (|| {
                        let room = ACTIVE
                            .lock()
                            .map_err(|e| e.to_string())?
                            .clone()
                            .ok_or("Open a room first")?;
                        let id = if index == 0 {
                            String::new()
                        } else {
                            library(&h, &room)?
                                .board
                                .pads
                                .get(index - 1)
                                .ok_or("No sound assigned to this shortcut")?
                                .id
                                .clone()
                        };
                        execute(
                            &h,
                            Request {
                                room,
                                action: if index == 0 { "stop_all" } else { "play" }.into(),
                                id,
                                value: None,
                            },
                        )
                    })();
                    if let Err(e) = result {
                        use tauri::Emitter;
                        let _ = h.emit("soundboard-error", e);
                    }
                });
            })
        {
            let _ = app.global_shortcut().unregister_all();
            return Err(e.to_string());
        }
    }
    Ok(())
}

pub fn controller_pairing(app: &tauri::AppHandle) -> Result<Pairing, String> {
    let path = root(app)?.join("controller-token");
    let token = if path.exists() {
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("Invalid controller credential file".into());
        }
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&path).map_err(|e| e.to_string())?;
        use std::io::Write;
        file.write_all(token.as_bytes())
            .map_err(|e| e.to_string())?;
        token
    };
    if token.len() != 64 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid controller credential".into());
    }
    Ok(Pairing {
        port: if app.config().identifier.ends_with("sets-v2-dev") {
            17955
        } else {
            17954
        },
        token,
    })
}
