//! Local DJ library. Audio never leaves the machine. Expensive tag/tempo work
//! runs on blocking workers, never the room's engine thread.
use crate::AppState;
use lofty::{
    file::{AudioFile, TaggedFileExt},
    tag::Accessor,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Manager, State};

static LIBRARY_LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub path: String,
    pub title: String,
    pub artist: String,
    pub duration_ms: u64,
    pub cover: Option<String>,
    pub bpm: Option<f64>,
    #[serde(default)]
    pub analyzed: bool,
    pub fingerprint: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub tracks: Vec<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Library {
    pub folder: String,
    pub tracks: Vec<Track>,
    pub playlists: Vec<Playlist>,
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let p = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("dj");
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}
fn read(root: &Path) -> Result<Library, String> {
    let p = root.join("library.json");
    if !p.exists() {
        return Ok(Library::default());
    }
    serde_json::from_slice(&std::fs::read(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn save(root: &Path, library: &Library) -> Result<(), String> {
    let bytes = serde_json::to_vec(library).map_err(|e| e.to_string())?;
    std::fs::write(root.join("library.tmp"), bytes).map_err(|e| e.to_string())?;
    std::fs::rename(root.join("library.tmp"), root.join("library.json")).map_err(|e| e.to_string())
}
fn key(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub fn audio_path(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path)
        .canonicalize()
        .map_err(|_| "Track not found. Choose its folder again.")?;
    let ext = p
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !p.is_file() || !matches!(ext.as_str(), "mp3" | "m4a" | "wav" | "flac" | "ogg") {
        return Err("Choose an MP3, M4A, WAV, FLAC or OGG audio file.".into());
    }
    Ok(p)
}
fn collect(dir: &Path, paths: &mut Vec<String>, depth: u32) -> Result<(), String> {
    if depth > 12 {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        // Don't walk symlinks (cycles and unrelated libraries).
        if ty.is_dir() {
            collect(&entry.path(), paths, depth + 1)?;
        } else if ty.is_file() && audio_path(&entry.path().to_string_lossy()).is_ok() {
            paths.push(entry.path().to_string_lossy().into());
        }
        if paths.len() > 10000 {
            return Err("Choose a folder with fewer than 10,000 tracks.".into());
        }
    }
    Ok(())
}
fn import(root: &Path, library: &mut Library, paths: Vec<String>) -> Result<(), String> {
    for path in paths {
        let p = audio_path(&path)?;
        let path = p.to_string_lossy().to_string();
        let id = key(path.as_bytes());
        let meta = p.metadata().map_err(|e| e.to_string())?;
        let fingerprint = format!("{}:{:?}", meta.len(), meta.modified());
        if library
            .tracks
            .iter()
            .any(|t| t.id == id && t.fingerprint == fingerprint)
        {
            continue;
        }
        let mut t = Track {
            id: id.clone(),
            path,
            title: p.file_stem().unwrap_or_default().to_string_lossy().into(),
            artist: String::new(),
            duration_ms: 0,
            cover: None,
            bpm: None,
            analyzed: false,
            fingerprint,
        };
        if let Ok(file) = lofty::read_from_path(&p) {
            t.duration_ms = file.properties().duration().as_millis() as u64;
            if let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) {
                if let Some(v) = tag.title() {
                    t.title = v.into();
                }
                if let Some(v) = tag.artist() {
                    t.artist = v.into();
                }
                t.bpm = tag
                    .get_string(&lofty::tag::ItemKey::Bpm)
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| v.is_finite() && (30.0..=300.0).contains(v));
                if let Some(pic) = tag.pictures().first() {
                    if pic.data().len() <= 8 * 1024 * 1024 {
                        let ext = match pic.mime_type() {
                            Some(lofty::picture::MimeType::Png) => "png",
                            _ => "jpg",
                        };
                        let dest = root.join(format!("cover-{id}.{ext}"));
                        std::fs::write(&dest, pic.data()).map_err(|e| e.to_string())?;
                        t.cover = Some(dest.to_string_lossy().into());
                    }
                }
            }
        }
        if let Some(old) = library.tracks.iter_mut().find(|t| t.id == id) {
            *old = t;
        } else {
            library.tracks.push(t);
        }
    }
    library
        .tracks
        .sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(())
}
#[tauri::command]
pub async fn dj_library(app: tauri::AppHandle) -> Result<Library, String> {
    let root = root(&app)?;
    let folder = app
        .path()
        .audio_dir()
        .or_else(|_| app.path().home_dir().map(|p| p.join("Music")))
        .map_err(|e| e.to_string())?
        .join("Producer");
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
        let mut lib = read(&root)?;
        if lib.folder.is_empty() {
            std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            lib.folder = folder.to_string_lossy().into();
            let mut paths = vec![];
            collect(&folder, &mut paths, 0)?;
            import(&root, &mut lib, paths)?;
            save(&root, &lib)?;
        } else if Path::new(&lib.folder).is_dir() {
            let mut paths = vec![];
            collect(Path::new(&lib.folder), &mut paths, 0)?;
            import(&root, &mut lib, paths)?;
            save(&root, &lib)?;
        }
        Ok(lib)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn dj_import(
    app: tauri::AppHandle,
    paths: Vec<String>,
    folder: Option<String>,
) -> Result<Library, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
        let mut lib = read(&root)?;
        let mut paths = paths;
        if let Some(folder) = folder {
            collect(Path::new(&folder), &mut paths, 0)?;
            lib.folder = folder;
        }
        import(&root, &mut lib, paths)?;
        save(&root, &lib)?;
        Ok(lib)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn dj_save_playlist(
    app: tauri::AppHandle,
    playlist: Playlist,
    remove: bool,
) -> Result<Library, String> {
    let root = root(&app)?;
    let _lock = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
    let mut lib = read(&root)?;
    lib.playlists.retain(|p| p.id != playlist.id);
    if !remove {
        let mut playlist = playlist;
        playlist.name = playlist.name.trim().to_string();
        if playlist.name.is_empty() {
            return Err("Name your tracklist.".into());
        }
        lib.playlists.push(playlist);
    }
    save(&root, &lib)?;
    Ok(lib)
}
#[tauri::command]
pub async fn dj_update_track(
    app: tauri::AppHandle,
    id: String,
    bpm: Option<f64>,
    cover: Option<String>,
) -> Result<Library, String> {
    let root = root(&app)?;
    let _lock = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
    let mut lib = read(&root)?;
    let track = lib
        .tracks
        .iter_mut()
        .find(|t| t.id == id)
        .ok_or("Track not found")?;
    if let Some(bpm) = bpm {
        if !bpm.is_finite() || !(30.0..=300.0).contains(&bpm) {
            return Err("BPM must be between 30 and 300.".into());
        }
        track.bpm = Some(bpm);
        track.analyzed = true;
    }
    if let Some(cover) = cover {
        let p = Path::new(&cover);
        let ext = p
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp")
            || p.metadata().map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024
        {
            return Err("Choose a cover image under 8 MB.".into());
        }
        let dest = root.join(format!("custom-{}.{ext}", track.id));
        std::fs::copy(p, &dest).map_err(|e| e.to_string())?;
        track.cover = Some(dest.to_string_lossy().into());
    }
    save(&root, &lib)?;
    Ok(lib)
}
// Decode in packet-sized blocks: even long beats never become a huge PCM allocation.
pub(crate) fn decode(
    path: &Path,
    mut consume: impl FnMut(&[f32], u32, usize) -> Result<bool, String>,
) -> Result<(), String> {
    use symphonia::core::{
        audio::SampleBuffer, codecs::DecoderOptions, formats::FormatOptions, io::MediaSourceStream,
        meta::MetadataOptions, probe::Hint,
    };
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|x| x.to_str()) {
        hint.with_extension(ext);
    }
    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            MediaSourceStream::new(Box::new(file), Default::default()),
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| e.to_string())?
        .format;
    let (id, mut decoder) = probed
        .tracks()
        .iter()
        .find_map(|track| {
            symphonia::default::get_codecs()
                .make(&track.codec_params, &DecoderOptions::default())
                .ok()
                .map(|decoder| (track.id, decoder))
        })
        .ok_or("No supported audio track")?;
    loop {
        let packet = match probed.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id() != id {
            continue;
        }
        let audio = match decoder.decode(&packet) {
            Ok(a) => a,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let spec = *audio.spec();
        let channels = spec.channels.count();
        let mut samples = SampleBuffer::<f32>::new(audio.capacity() as u64, spec);
        samples.copy_interleaved_ref(audio);
        if !consume(samples.samples(), spec.rate, channels)? {
            break;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn dj_analyze(app: tauri::AppHandle, id: String) -> Result<Library, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let track = {
            let _lock = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
            read(&root)?
                .tracks
                .into_iter()
                .find(|t| t.id == id)
                .ok_or("Track not found")?
        };
        if !track.analyzed && track.bpm.is_none() {
            let mut detect = None;
            let mut frames = 0;
            decode(&audio_path(&track.path)?, |samples, rate, channels| {
                let detector = detect.get_or_insert_with(|| soundtouch::BPMDetect::new(1, rate));
                let mono: Vec<f32> = samples
                    .chunks_exact(channels)
                    .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                    .collect();
                detector.input_samples(&mono);
                frames += mono.len();
                Ok(frames < rate as usize * 120)
            })?;
            let bpm = detect
                .as_mut()
                .map(|d| d.get_bpm() as f64)
                .filter(|v| v.is_finite() && (30.0..=300.0).contains(v));
            let _lock = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
            let mut lib = read(&root)?;
            if let Some(t) = lib
                .tracks
                .iter_mut()
                .find(|t| t.id == id && t.fingerprint == track.fingerprint && !t.analyzed)
            {
                t.bpm = bpm;
                t.analyzed = true;
            }
            save(&root, &lib)?;
            return Ok(lib);
        }
        let _lock = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
        read(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn dj_match_tempo(
    app: tauri::AppHandle,
    id: String,
    target: f64,
) -> Result<String, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let track = {
            let _lock = LIBRARY_LOCK.lock().map_err(|e| e.to_string())?;
            read(&root)?
                .tracks
                .into_iter()
                .find(|t| t.id == id)
                .ok_or("Track not found")?
        };
        let bpm = track.bpm.ok_or("Analyze or set the track BPM first")?;
        let ratio = target / bpm;
        if !ratio.is_finite() || !(0.75..=1.33).contains(&ratio) {
            return Err("BPM matching supports a tempo change from −25% to +33%.".into());
        }
        let dest = root.join(format!(
            "tempo-{}.wav",
            key(format!("{}:{}:{target:.2}", track.id, track.fingerprint).as_bytes())
        ));
        if dest.exists() {
            return Ok(dest.to_string_lossy().into());
        }
        let temp = dest.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            let mut stretch = soundtouch::SoundTouch::new();
            let mut writer = None;
            let mut format = None;
            decode(&audio_path(&track.path)?, |samples, rate, channels| {
                if channels > 2 {
                    return Err("BPM matching requires mono or stereo audio.".into());
                }
                if format.is_none() {
                    format = Some((rate, channels));
                    stretch
                        .set_sample_rate(rate)
                        .set_channels(channels as u32)
                        .set_tempo(ratio);
                    writer = Some(
                        hound::WavWriter::create(
                            &temp,
                            hound::WavSpec {
                                channels: channels as u16,
                                sample_rate: rate,
                                bits_per_sample: 32,
                                sample_format: hound::SampleFormat::Float,
                            },
                        )
                        .map_err(|e| e.to_string())?,
                    );
                } else if format != Some((rate, channels)) {
                    return Err("Audio format changed during decoding".into());
                }
                stretch.put_samples(samples, samples.len() / channels);
                let mut out = vec![0f32; 4096 * channels];
                loop {
                    let n = stretch.receive_samples(&mut out, 4096);
                    if n == 0 {
                        break;
                    }
                    for s in &out[..n * channels] {
                        writer
                            .as_mut()
                            .unwrap()
                            .write_sample(*s)
                            .map_err(|e| e.to_string())?;
                    }
                }
                Ok(true)
            })?;
            let (_, channels) = format.ok_or("No decodable audio")?;
            stretch.flush();
            let mut out = vec![0f32; 4096 * channels];
            loop {
                let n = stretch.receive_samples(&mut out, 4096);
                if n == 0 {
                    break;
                }
                for s in &out[..n * channels] {
                    writer
                        .as_mut()
                        .unwrap()
                        .write_sample(*s)
                        .map_err(|e| e.to_string())?;
                }
            }
            writer.unwrap().finalize().map_err(|e| e.to_string())?;
            std::fs::rename(&temp, &dest).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result?;
        Ok(dest.to_string_lossy().into())
    })
    .await
    .map_err(|e| e.to_string())?
}
// Wire types exist in builds without an engine too.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct QueueTrack {
    pub id: String,
    pub path: String,
    pub title: String,
    #[serde(default)]
    pub matched_bpm: Option<f64>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Status,
    PauseAll,
    StopAll,
    Queue {
        tracks: Vec<QueueTrack>,
    },
    Load {
        deck: usize,
        track: QueueTrack,
    },
    Play {
        deck: usize,
        #[serde(default)]
        preserve_fader: bool,
    },
    Pause {
        deck: usize,
    },
    Stop {
        deck: usize,
    },
    Seek {
        deck: usize,
        ms: i64,
    },
    Loop {
        deck: usize,
        on: bool,
    },
    Next {
        previous: bool,
    },
    Mix {
        volume: f32,
        crossfader: f32,
        fade: f32,
        repeat: bool,
        shuffle: bool,
        duck: bool,
    },
    Clear,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct DeckState {
    pub track: Option<QueueTrack>,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub state: i32,
    pub looping: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub decks: [DeckState; 2],
    pub active: usize,
    pub volume: f32,
    pub crossfader: f32,
    pub fade: f32,
    pub repeat: bool,
    pub shuffle: bool,
    pub duck: bool,
    pub transitioning: bool,
    pub error: Option<String>,
}
#[tauri::command]
pub async fn dj_control(state: State<'_, AppState>, action: Action) -> Result<Status, String> {
    // Synchronous engine replies run off Tauri's async executor.
    let live = state.live.clone_handle_for_dj()?;
    tauri::async_runtime::spawn_blocking(move || live(action))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_bpm_from_decoded_pulses() {
        let path = std::env::temp_dir().join(format!("dj-bpm-{}.wav", uuid::Uuid::new_v4()));
        let rate = 22050u32;
        let mut writer = hound::WavWriter::create(
            &path,
            hound::WavSpec {
                channels: 1,
                sample_rate: rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for n in 0..rate * 35 {
            let phase = (n % (rate / 2)) as f32 / rate as f32;
            let value = if phase < 0.1 {
                (-phase * 40.).exp()
                    * (n as f32 * 2. * std::f32::consts::PI * 80. / rate as f32).sin()
                    * 0.85
            } else {
                0.
            };
            writer.write_sample((value * 32767.) as i16).unwrap();
        }
        writer.finalize().unwrap();
        let mut detector = soundtouch::BPMDetect::new(1, rate);
        decode(&path, |samples, _, _| {
            detector.input_samples(samples);
            Ok(true)
        })
        .unwrap();
        let bpm = detector.get_bpm();
        let _ = std::fs::remove_file(path);
        assert!((bpm - 120.).abs() < 2., "Detected {bpm}");
    }
    #[test]
    fn tempo_change_preserves_pitch_and_changes_duration() {
        let rate = 22050;
        let samples: Vec<f32> = (0..rate * 3)
            .map(|i| (i as f32 * 2. * std::f32::consts::PI * 440. / rate as f32).sin())
            .collect();
        let mut stretch = soundtouch::SoundTouch::new();
        stretch
            .set_channels(1)
            .set_sample_rate(rate)
            .set_tempo(1.25);
        let out = stretch.generate_audio(&samples);
        assert!((out.len() as f64 / samples.len() as f64 - 0.8).abs() < 0.025);
        let begin = rate as usize / 2;
        let end = out.len() - begin;
        let crossings = out[begin..end]
            .windows(2)
            .filter(|pair| pair[0] <= 0. && pair[1] > 0.)
            .count();
        let pitch = crossings as f64 * rate as f64 / (end - begin) as f64;
        assert!((pitch - 440.).abs() < 3., "Pitch changed to {pitch}");
    }
}
