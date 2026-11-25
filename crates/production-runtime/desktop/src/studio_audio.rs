//! Room-owned DJ and Sound bus. The decoder and speaker monitor stay off the media lane.
use anyhow::{bail, ensure, Context, Result};
use producer_native_media::boundary::BLOCK_SAMPLES;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{c_char, c_void, CString},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering::Relaxed},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    time::Duration,
};

const RATE: usize = 48_000;
const MAX_PENDING: usize = 24;
const MAX_VOICES: usize = 16;
const MAX_PCM_BYTES: usize = 224 * 1024 * 1024;
const MAX_TRACK_SAMPLES: usize = 128 * 1024 * 1024 / 4;
const MAX_EFFECT_SAMPLES: usize = RATE * 2 * 90;
const MAX_CACHE_ENTRIES: usize = 32;
const DEFAULT_PAD_GAIN: f32 = 0.65;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Music,
    Effect,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    Restart,
    Toggle,
    Overlap,
    Loop,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeckId {
    A,
    B,
}
impl DeckId {
    pub fn index(self) -> usize {
        match self {
            Self::A => 0,
            Self::B => 1,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Bus {
    Music,
    Sound,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Status,
    Catalog {
        kind: Option<Kind>,
        #[serde(default)]
        query: String,
        #[serde(default)]
        offset: usize,
        limit: Option<usize>,
    },
    RoomSounds {
        #[serde(default)]
        query: String,
        #[serde(default)]
        offset: usize,
        limit: Option<usize>,
    },
    SetSoundAdded {
        id: String,
        added: bool,
    },
    Import {
        kind: Kind,
        path: PathBuf,
    },
    LoadDeck {
        deck: DeckId,
        id: String,
        #[serde(default)]
        play: bool,
    },
    NextTrack {
        deck: DeckId,
    },
    PlayDeck {
        deck: DeckId,
    },
    PauseDeck {
        deck: DeckId,
    },
    StopDeck {
        deck: DeckId,
    },
    UnloadDeck {
        deck: DeckId,
    },
    SeekDeck {
        deck: DeckId,
        seconds: f64,
    },
    LoopDeck {
        deck: DeckId,
        enabled: bool,
    },
    Crossfade {
        value: f32,
    },
    Mix {
        enabled: bool,
    },
    Gain {
        bus: Bus,
        value: f32,
    },
    DuckMusic {
        enabled: bool,
    },
    DuckAmount {
        amount: f32,
    },
    Monitor {
        enabled: bool,
    },
    Trigger {
        id: String,
        mode: Option<Mode>,
    },
    ConfigurePad {
        id: String,
        mode: Mode,
        gain: f32,
        fade_ms: u16,
    },
    StopSound {
        id: String,
    },
    StopSounds,
    Preview {
        id: String,
    },
    StopPreview,
}

pub fn commands() -> serde_json::Value {
    serde_json::json!({
        "op":"studioAudio",
        "syntax":{"op":"studioAudio","command":{"action":"status"}},
        "actions":{
            "status":{}, "catalog":{"kind":"music or effect (optional)","query":"optional","offset":0,"limit":32},
            "roomSounds":{"query":"optional","offset":0,"limit":32},
            "setSoundAdded":{"id":"effect ID from catalog","added":true},
            "loadDeck":{"deck":"a or b","id":"music ID from catalog","play":false},
            "nextTrack":{"deck":"a or b"},
            "playDeck":{"deck":"a or b"}, "pauseDeck":{"deck":"a or b"},
            "stopDeck":{"deck":"a or b"}, "unloadDeck":{"deck":"a or b"}, "seekDeck":{"deck":"a or b","seconds":0},
            "loopDeck":{"deck":"a or b","enabled":true},
            "mix":{"enabled":true}, "crossfade":{"value":"-1 (A) to 1 (B)"},
            "gain":{"bus":"music or sound","value":"0 to 1"},
            "duckMusic":{"enabled":true}, "duckAmount":{"amount":"0 to 1 reduction while speaking"}, "monitor":{"enabled":true},
            "trigger":{"id":"effect ID","mode":"restart, toggle, overlap or loop (optional)"},
            "configurePad":{"id":"effect ID","mode":"restart, toggle, overlap or loop","gain":"0 to 1","fadeMs":"0 to 2000"},
            "stopSound":{"id":"effect ID"}, "stopSounds":{},
            "preview":{"id":"catalog ID (local monitor only)"}, "stopPreview":{}
        },
        "localImport":{"op":"studioAudio","command":{"action":"import","kind":"music or effect","path":"absolute local file path"}},
        "notes":"Use the catalog for stable IDs. Loading is asynchronous. Status distinguishes pending from playing. Preview is local. Trigger and the decks use the program mix."
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Item {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    #[serde(rename = "durationMs", alias = "duration_ms", default)]
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Deserialize)]
struct BundledItem {
    #[serde(flatten)]
    item: Item,
    file: PathBuf,
}
#[derive(Deserialize)]
struct Manifest {
    schema: String,
    assets: Vec<BundledItem>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Asset {
    item: Item,
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pad {
    pub mode: Mode,
    pub gain: f32,
    pub fade_ms: u16,
}
impl Default for Pad {
    fn default() -> Self {
        Self {
            mode: Mode::Restart,
            gain: DEFAULT_PAD_GAIN,
            fade_ms: 8,
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Preferences {
    mixing: bool,
    crossfade: f32,
    music_gain: f32,
    sound_gain: f32,
    duck_music: bool,
    duck_amount: f32,
    monitor: bool,
    pads: BTreeMap<String, Pad>,
    room_sounds: Option<BTreeSet<String>>,
    imports: Vec<Asset>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            mixing: false,
            crossfade: 0.,
            music_gain: 0.66,
            sound_gain: 0.8,
            duck_music: false,
            duck_amount: 0.72,
            monitor: false,
            pads: BTreeMap::new(),
            room_sounds: None,
            imports: Vec::new(),
        }
    }
}

struct Clip {
    id: String,
    name: Arc<str>,
    pcm: Box<[f32]>,
}
impl Clip {
    fn frames(&self) -> usize {
        self.pcm.len() / 2
    }
}

#[derive(Default)]
struct Deck {
    clip: Option<Arc<Clip>>,
    loading: Option<PendingTrack>,
    frame: usize,
    playing: bool,
    looping: bool,
    envelope: f32,
}

struct PendingTrack {
    serial: u64,
    id: String,
    play: bool,
}

struct Voice {
    clip: Arc<Clip>,
    frame: usize,
    gain: f32,
    fade: usize,
    age: usize,
    release: Option<usize>,
    looping: bool,
}
impl Voice {
    fn new(clip: Arc<Clip>, pad: Pad, looping: bool) -> Self {
        Self {
            clip,
            frame: 0,
            gain: pad.gain,
            fade: (pad.fade_ms as usize * 48).max(96),
            age: 0,
            release: None,
            looping,
        }
    }
    fn stop(&mut self) {
        self.release.get_or_insert(self.fade);
    }
    fn mix(&mut self, out: &mut [f32; BLOCK_SAMPLES], bus: f32) -> bool {
        for frame in out.chunks_exact_mut(2) {
            if self.frame >= self.clip.frames() {
                if !self.looping {
                    return false;
                }
                self.frame = 0;
            }
            let attack = self.age.min(self.fade) as f32 / self.fade as f32;
            let release = if let Some(remaining) = &mut self.release {
                if *remaining == 0 {
                    return false;
                }
                let v = *remaining as f32 / self.fade as f32;
                *remaining -= 1;
                v
            } else {
                1.
            };
            let gain = self.gain * bus * attack * release;
            let sample = &self.clip.pcm[self.frame * 2..][..2];
            frame[0] += sample[0] * gain;
            frame[1] += sample[1] * gain;
            self.frame += 1;
            self.age = self.age.saturating_add(1);
        }
        true
    }
}

struct Playback {
    decks: [Deck; 2],
    voices: Vec<Voice>,
    preview: Option<Voice>,
    pending: Vec<(u64, String)>,
    pending_preview: Option<(u64, String)>,
    mixing: bool,
    crossfade: f32,
    live_crossfade: f32,
    music_gain: f32,
    sound_gain: f32,
    duck_music: bool,
    duck_amount: f32,
    duck: f32,
    monitor: bool,
    error: Option<String>,
    meter: crate::dj_visual::Meter,
}
impl Playback {
    fn new(p: &Preferences) -> Self {
        Self {
            decks: Default::default(),
            voices: Vec::with_capacity(MAX_VOICES),
            preview: None,
            pending: Vec::with_capacity(MAX_PENDING),
            pending_preview: None,
            mixing: p.mixing,
            crossfade: p.crossfade,
            live_crossfade: if p.mixing { p.crossfade } else { -1. },
            music_gain: p.music_gain,
            sound_gain: p.sound_gain,
            duck_music: p.duck_music,
            duck_amount: p.duck_amount.clamp(0., 1.),
            duck: 1.,
            monitor: p.monitor,
            error: None,
            meter: Default::default(),
        }
    }

    fn primary_track(&self) -> Option<&Arc<str>> {
        if self.music_gain <= 0.0001 {return None}
        let decks=[self.decks.first()?,self.decks.get(1)?];
        let gains=[1.-self.live_crossfade.max(0.),1.+self.live_crossfade.min(0.)];
        let preferred=usize::from(gains[1]>gains[0]+0.02);
        [preferred,1-preferred].into_iter().find_map(|i| {
            let deck=decks[i];
            (deck.playing && gains[i]>0.01).then(||deck.clip.as_ref()).flatten().map(|clip|&clip.name)
        })
    }

    fn deck_mix(&mut self, out: &mut [f32; BLOCK_SAMPLES], mic_peak: f32) {
        let previous_crossfade = self.live_crossfade;
        let goal = if self.duck_music && mic_peak > 0.06 {
            1. - self.duck_amount
        } else {
            1.
        };
        let previous_duck = self.duck;
        self.duck += (goal - self.duck) * if goal < self.duck { 0.29 } else { 0.075 };
        let crossfade = if self.mixing { self.crossfade } else { -1. };
        self.live_crossfade += (crossfade - self.live_crossfade) * 0.45;
        if (self.live_crossfade - crossfade).abs() < 0.0005 {
            self.live_crossfade = crossfade;
        }
        for (index, deck) in self.decks.iter_mut().enumerate() {
            if !deck.playing {
                continue;
            }
            let Some(clip) = &deck.clip else { continue };
            for (i, frame) in out.chunks_exact_mut(2).enumerate() {
                if deck.frame >= clip.frames() {
                    if deck.looping {
                        deck.frame = 0;
                    } else {
                        deck.playing = false;
                        deck.frame = 0;
                        deck.envelope = 0.;
                        break;
                    }
                }
                let t = i as f32 / (BLOCK_SAMPLES / 2) as f32;
                let fader = previous_crossfade + (self.live_crossfade - previous_crossfade) * t;
                let balance = if index == 0 {
                    1. - fader.max(0.)
                } else {
                    1. + fader.min(0.)
                };
                let duck = previous_duck + (self.duck - previous_duck) * t;
                deck.envelope = (deck.envelope + 1. / 240.).min(1.);
                let gain = self.music_gain * balance * duck * deck.envelope;
                let sample = &clip.pcm[deck.frame * 2..][..2];
                frame[0] += sample[0] * gain;
                frame[1] += sample[1] * gain;
                deck.frame += 1;
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckStatus {
    pub id: Option<String>,
    pub loading: Option<String>,
    pub playing: bool,
    pub looping: bool,
    pub seconds: f64,
    pub duration: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub decks: [DeckStatus; 2],
    pub active_sounds: Vec<String>,
    pub pending_sounds: Vec<String>,
    pub preview: Option<String>,
    pub mixing: bool,
    pub crossfade: f32,
    pub music_gain: f32,
    pub sound_gain: f32,
    pub duck_music: bool,
    pub duck_amount: f32,
    pub monitor: bool,
    pub monitor_error: bool,
    pub mixed_blocks: u64,
    pub now_playing: Option<String>,
    pub music_bands: [f32;4],
    pub contended_blocks: u64,
    pub monitor_drops: u64,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Page {
    pub items: Vec<Item>,
    pub total: usize,
}

#[derive(Clone, Copy)]
enum Destination {
    Deck(DeckId, bool),
    Sound(Pad, Mode),
    Preview,
}
struct Load {
    serial: u64,
    asset: Asset,
    destination: Destination,
}

pub struct Desk {
    pub dj_visual: crate::dj_visual::Visual,
    root: PathBuf,
    bundled: Vec<Asset>,
    preferences: Mutex<Preferences>,
    playback: Arc<Mutex<Playback>>,
    serial: AtomicU64,
    load: SyncSender<Load>,
    monitor: SyncSender<[f32; BLOCK_SAMPLES]>,
    monitor_error: Arc<AtomicBool>,
    mixed_blocks: AtomicU64,
    contended_blocks: AtomicU64,
    monitor_drops: Arc<AtomicU64>,
}

impl Desk {
    pub fn open(root: &Path) -> Result<Self> {
        let (mut preferences, error) = match fs::read(root.join("studio-audio.json")) {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(preferences) => (preferences, None),
                Err(e) => (
                    Preferences::default(),
                    Some(format!("Read studio audio settings: {e}")),
                ),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Preferences::default(), None),
            Err(e) => (
                Preferences::default(),
                Some(format!("Read studio audio settings: {e}")),
            ),
        };
        let mut playback = Playback::new(&preferences);
        playback.error = error;
        let bundled = match library() {
            Ok(assets) => assets,
            Err(e) => {
                if playback.error.is_none() {
                    playback.error = Some(e.to_string());
                }
                Vec::new()
            }
        };
        // Earlier rooms implicitly exposed every sound. Keep the ones the room
        // imported or configured, then track membership separately from settings.
        if preferences.room_sounds.is_none() {
            preferences.room_sounds = Some(
                preferences.pads.keys().cloned().chain(
                    preferences.imports.iter().filter(|a| a.item.kind == Kind::Effect)
                        .map(|a| a.item.id.clone()),
                ).collect(),
            );
        }
        let playback = Arc::new(Mutex::new(playback));
        let (load, queue) = mpsc::sync_channel(MAX_PENDING);
        let decoder = Arc::clone(&playback);
        std::thread::Builder::new()
            .name("producer-studio-audio-decode".into())
            .spawn(move || decode_worker(queue, &decoder))?;
        let (monitor, queue) = mpsc::sync_channel(4);
        let monitor_error = Arc::new(AtomicBool::new(false));
        let error = Arc::clone(&monitor_error);
        let monitor_drops = Arc::new(AtomicU64::new(0));
        let drops = monitor_drops.clone();
        std::thread::Builder::new()
            .name("producer-studio-monitor".into())
            .spawn(move || monitor_worker(queue, &error, &drops))?;
        Ok(Self {
            dj_visual: crate::dj_visual::Visual::open()?,
            root: root.to_owned(),
            bundled,
            preferences: Mutex::new(preferences),
            playback,
            serial: AtomicU64::new(1),
            load,
            monitor,
            monitor_error,
            mixed_blocks: AtomicU64::new(0),
            contended_blocks: AtomicU64::new(0),
            monitor_drops,
        })
    }

    pub fn catalog(&self, kind: Option<Kind>, query: &str, offset: usize, limit: usize) -> Page {
        self.catalog_page(kind, query, offset, limit, false)
    }

    pub fn room_sounds(&self, query: &str, offset: usize, limit: usize) -> Page {
        self.catalog_page(Some(Kind::Effect), query, offset, limit, true)
    }

    pub fn sound_added(&self, id: &str) -> bool {
        self.preferences.lock().unwrap().room_sounds.as_ref()
            .is_some_and(|ids| ids.contains(id))
    }

    fn catalog_page(
        &self, kind: Option<Kind>, query: &str, offset: usize, limit: usize, room_only: bool,
    ) -> Page {
        let preferences = self.preferences.lock().unwrap();
        let query = query.trim().to_lowercase();
        let matches = self
            .bundled
            .iter()
            .chain(&preferences.imports)
            .filter(|asset| {
                kind.is_none_or(|k| k == asset.item.kind)
                    && (!room_only || preferences.room_sounds.as_ref()
                        .is_some_and(|ids| ids.contains(&asset.item.id)))
                    && (query.is_empty()
                        || asset.item.id.contains(&query)
                        || asset.item.name.to_lowercase().contains(&query))
            });
        Page {
            total: matches.clone().count(),
            items: matches
                .skip(offset)
                .take(limit.min(64))
                .map(|a| a.item.clone())
                .collect(),
        }
    }

    pub fn name(&self, id: &str) -> String {
        self.lookup(id)
            .map(|a| a.item.name)
            .unwrap_or_else(|_| id.to_owned())
    }

    pub fn pad(&self, id: &str) -> Pad {
        self.preferences
            .lock()
            .unwrap()
            .pads
            .get(id)
            .copied()
            .unwrap_or_default()
    }

    fn lookup(&self, id: &str) -> Result<Asset> {
        self.bundled
            .iter()
            .find(|a| a.item.id == id)
            .cloned()
            .or_else(|| {
                self.preferences
                    .lock()
                    .unwrap()
                    .imports
                    .iter()
                    .find(|a| a.item.id == id)
                    .cloned()
            })
            .with_context(|| format!("Unknown audio asset {id}"))
    }

    fn next_track(&self, deck: DeckId) -> Result<()> {
        let (current, play) = {
            let playback = self.playback.lock().unwrap();
            let deck = &playback.decks[deck.index()];
            if let Some(pending) = &deck.loading {
                (Some(pending.id.clone()), pending.play)
            } else {
                (deck.clip.as_ref().map(|clip| clip.id.clone()), deck.playing)
            }
        };
        let asset = {
            let preferences = self.preferences.lock().unwrap();
            let mut tracks = self.bundled.iter().chain(&preferences.imports)
                .filter(|asset| asset.item.kind == Kind::Music);
            current.and_then(|id| tracks.clone().skip_while(|a| a.item.id != id).nth(1))
                .or_else(|| tracks.next())
                .cloned()
                .context("Import a track first")?
        };
        self.load_deck(deck, asset, play)
    }

    fn load_deck(&self, deck: DeckId, asset: Asset, play: bool) -> Result<()> {
        if deck == DeckId::B && play && !self.playback.lock().unwrap().mixing {
            self.settings(|s| {
                s.mixing = true;
                Ok(())
            })?;
        }
        self.queue(asset, Destination::Deck(deck, play))
    }

    fn settings(&self, change: impl FnOnce(&mut Preferences) -> Result<()>) -> Result<()> {
        let mut settings = self.preferences.lock().unwrap();
        let mut next = settings.clone();
        change(&mut next)?;
        let pending = tempfile::NamedTempFile::new_in(&self.root)?;
        serde_json::to_writer(pending.as_file(), &next)?;
        pending.persist(self.root.join("studio-audio.json"))?;
        let mut playback = self.playback.lock().unwrap();
        if playback.mixing && !next.mixing {
            let b = &mut playback.decks[DeckId::B.index()];
            b.playing = false;
            b.envelope = 0.;
            b.loading = None;
        }
        playback.mixing = next.mixing;
        playback.crossfade = next.crossfade;
        playback.music_gain = next.music_gain;
        playback.sound_gain = next.sound_gain;
        playback.duck_music = next.duck_music;
        playback.duck_amount = next.duck_amount.clamp(0., 1.);
        playback.monitor = next.monitor;
        *settings = next;
        Ok(())
    }

    pub fn status(&self) -> Status {
        let p = self.playback.lock().unwrap();
        Status {
            decks: std::array::from_fn(|i| {
                let deck = &p.decks[i];
                DeckStatus {
                    id: deck.clip.as_ref().map(|c| c.id.clone()),
                    loading: deck.loading.as_ref().map(|pending| pending.id.clone()),
                    playing: deck.playing,
                    looping: deck.looping,
                    seconds: deck.frame as f64 / RATE as f64,
                    duration: deck
                        .clip
                        .as_ref()
                        .map_or(0., |c| c.frames() as f64 / RATE as f64),
                }
            }),
            active_sounds: p.voices.iter().map(|v| v.clip.id.clone()).collect(),
            pending_sounds: p.pending.iter().map(|(_, id)| id.clone()).collect(),
            preview: p
                .preview
                .as_ref()
                .map(|p| p.clip.id.clone())
                .or_else(|| p.pending_preview.as_ref().map(|(_, id)| id.clone())),
            crossfade: p.crossfade,
            mixing: p.mixing,
            music_gain: p.music_gain,
            sound_gain: p.sound_gain,
            duck_music: p.duck_music,
            duck_amount: p.duck_amount,
            monitor: p.monitor,
            error: p.error.clone(),
            monitor_error: self.monitor_error.load(Relaxed),
            mixed_blocks: self.mixed_blocks.load(Relaxed),
            now_playing: p.primary_track().map(|title|title.to_string()),
            music_bands: self.dj_visual.bands(),
            contended_blocks: self.contended_blocks.load(Relaxed),
            monitor_drops: self.monitor_drops.load(Relaxed),
        }
    }

    fn queue(&self, asset: Asset, destination: Destination) -> Result<()> {
        let serial = self.serial.fetch_add(1, Relaxed);
        let id = asset.item.id.clone();
        let mut p = self.playback.lock().unwrap();
        let marker = (serial, id);
        ensure!(
            p.pending.len() < MAX_PENDING || !matches!(destination, Destination::Sound(..)),
            "Too many sound cues pending"
        );
        self.load
            .try_send(Load {
                serial,
                asset,
                destination,
            })
            .map_err(|_| anyhow::anyhow!("Audio decoder queue is busy"))?;
        p.error = None;
        match destination {
            Destination::Deck(deck, play) => {
                p.decks[deck.index()].loading = Some(PendingTrack { serial, id: marker.1, play });
            }
            Destination::Sound(..) => p.pending.push(marker),
            Destination::Preview => {
                p.pending_preview = Some(marker);
                p.preview = None;
            }
        }
        Ok(())
    }

    pub fn execute(&self, command: Command) -> Result<serde_json::Value> {
        use Command::*;
        match command {
            Status => {}
            Catalog {
                kind,
                query,
                offset,
                limit,
            } => {
                ensure!(query.len() <= 256, "Audio search is too long");
                return Ok(
                    serde_json::json!({"ok":true,"catalog":self.catalog(kind,&query,offset,limit.unwrap_or(32))}),
                );
            }
            RoomSounds { query, offset, limit } => {
                ensure!(query.len() <= 256, "Audio search is too long");
                return Ok(serde_json::json!({
                    "ok":true,"catalog":self.room_sounds(&query,offset,limit.unwrap_or(32))
                }));
            }
            SetSoundAdded { id, added } => {
                ensure!(self.lookup(&id)?.item.kind == Kind::Effect, "Choose a sound effect");
                self.settings(|s| {
                    let sounds = s.room_sounds.get_or_insert_with(BTreeSet::new);
                    if added {
                        sounds.insert(id);
                    } else {
                        sounds.remove(&id);
                    }
                    Ok(())
                })?;
            }
            Import { kind, path } => {
                let path = path.canonicalize().context("Audio file is unavailable")?;
                let meta = path.metadata()?;
                ensure!(
                    meta.is_file() && meta.len() > 0 && meta.len() <= 256 * 1024 * 1024,
                    "Choose an audio file smaller than 256 MB"
                );
                let extension = path
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                ensure!(
                    matches!(
                        extension.as_str(),
                        "mp3" | "wav" | "m4a" | "aac" | "aif" | "aiff" | "flac"
                    ),
                    "Choose MP3, WAV, M4A, AAC, AIFF, or FLAC"
                );
                let id = format!(
                    "local-{}-{:x}",
                    if kind == Kind::Music {
                        "music"
                    } else {
                        "sound"
                    },
                    Sha256::digest(path.as_os_str().as_encoded_bytes())
                );
                let item = Item {
                    id: id[..36].into(),
                    kind,
                    name: path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .chars()
                        .take(120)
                        .collect(),
                    duration_ms: 0,
                    description: None,
                };
                self.settings(|s| {
                    ensure!(
                        s.imports.len() < 512 || s.imports.iter().any(|a| a.item.id == item.id),
                        "Audio library is full"
                    );
                    if !s.imports.iter().any(|a| a.item.id == item.id) {
                        s.imports.push(Asset {
                            item: item.clone(),
                            path,
                        });
                    }
                    if kind == Kind::Effect {
                        s.room_sounds.get_or_insert_with(BTreeSet::new).insert(item.id.clone());
                    }
                    Ok(())
                })?;
                return Ok(serde_json::json!({"ok":true,"item":item}));
            }
            LoadDeck { deck, id, play } => {
                let asset = self.lookup(&id)?;
                ensure!(
                    asset.item.kind == Kind::Music,
                    "Choose a music track for a deck"
                );
                self.load_deck(deck, asset, play)?;
            }
            NextTrack { deck } => self.next_track(deck)?,
            PlayDeck { deck } => {
                if deck == DeckId::B {
                    let p = self.playback.lock().unwrap();
                    let b = &p.decks[deck.index()];
                    ensure!(b.loading.is_none(), "Wait for the deck to load");
                    ensure!(b.clip.is_some(), "Load a track first");
                    let enable_mix = !p.mixing;
                    drop(p);
                    if enable_mix {
                        self.settings(|s| { s.mixing = true; Ok(()) })?;
                    }
                }
                let mut p = self.playback.lock().unwrap();
                let d = &mut p.decks[deck.index()];
                ensure!(d.loading.is_none(), "Wait for the deck to load");
                let clip = d.clip.as_ref().context("Load a track first")?;
                if d.frame >= clip.frames() {
                    d.frame = 0;
                }
                d.playing = true;
                p.error = None;
            }
            PauseDeck { deck } => {
                let mut p = self.playback.lock().unwrap();
                let d = &mut p.decks[deck.index()];
                d.playing = false;
                d.envelope = 0.;
                d.loading = None;
            }
            StopDeck { deck } => {
                let mut p = self.playback.lock().unwrap();
                let d = &mut p.decks[deck.index()];
                d.playing = false;
                d.envelope = 0.;
                d.frame = 0;
                d.loading = None;
            }
            UnloadDeck { deck } => {
                self.playback.lock().unwrap().decks[deck.index()] = Deck::default();
            }
            SeekDeck { deck, seconds } => {
                ensure!(seconds.is_finite() && seconds >= 0., "Invalid seek time");
                let mut p = self.playback.lock().unwrap();
                let d = &mut p.decks[deck.index()];
                let clip = d.clip.as_ref().context("Load a track first")?;
                d.frame = ((seconds * RATE as f64) as usize).min(clip.frames());
                d.envelope = 0.;
            }
            LoopDeck { deck, enabled } => {
                self.playback.lock().unwrap().decks[deck.index()].looping = enabled
            }
            Crossfade { value } => self.settings(|s| {
                s.crossfade = checked(value, -1., 1.)?;
                s.mixing = true;
                Ok(())
            })?,
            Mix { enabled } => self.settings(|s| {
                s.mixing = enabled;
                Ok(())
            })?,
            Gain { bus, value } => self.settings(|s| {
                let gain = checked(value, 0., 1.)?;
                match bus {
                    Bus::Music => s.music_gain = gain,
                    Bus::Sound => s.sound_gain = gain,
                }
                Ok(())
            })?,
            DuckMusic { enabled } => self.settings(|s| {
                s.duck_music = enabled;
                Ok(())
            })?,
            DuckAmount { amount } => self.settings(|s| {
                s.duck_amount = checked(amount, 0., 1.)?;
                Ok(())
            })?,
            Monitor { enabled } => self.settings(|s| {
                s.monitor = enabled;
                Ok(())
            })?,
            Trigger { id, mode } => {
                let asset = self.lookup(&id)?;
                ensure!(
                    asset.item.kind == Kind::Effect,
                    "Choose an effect for the Sound panel"
                );
                let pad = self.pad(&id);
                let mode = mode.unwrap_or(pad.mode);
                if matches!(mode, Mode::Toggle | Mode::Loop) {
                    let mut p = self.playback.lock().unwrap();
                    let pending = p.pending.len();
                    p.pending.retain(|(_, cue)| cue != &id);
                    let mut canceled = pending != p.pending.len();
                    for voice in &mut p.voices {
                        if voice.clip.id == id && voice.release.is_none() {
                            voice.stop();
                            canceled = true;
                        }
                    }
                    if canceled {
                        drop(p);
                        return Ok(self.reply());
                    }
                }
                self.queue(asset, Destination::Sound(pad, mode))?;
            }
            ConfigurePad {
                id,
                mode,
                gain,
                fade_ms,
            } => {
                ensure!(
                    self.lookup(&id)?.item.kind == Kind::Effect,
                    "Choose a sound"
                );
                ensure!(fade_ms <= 2000, "Fade must be 0 to 2000 ms");
                self.settings(|s| {
                    s.pads.insert(
                        id,
                        Pad {
                            mode,
                            gain: checked(gain, 0., 1.)?,
                            fade_ms,
                        },
                    );
                    Ok(())
                })?;
            }
            StopSound { id } => {
                let mut p = self.playback.lock().unwrap();
                p.pending.retain(|(_, cue)| cue != &id);
                for voice in p.voices.iter_mut().filter(|v| v.clip.id == id) {
                    voice.stop();
                }
            }
            StopSounds => {
                let mut p = self.playback.lock().unwrap();
                p.pending.clear();
                for voice in &mut p.voices {
                    voice.stop();
                }
            }
            Preview { id } => self.queue(self.lookup(&id)?, Destination::Preview)?,
            StopPreview => {
                let mut p = self.playback.lock().unwrap();
                p.preview = None;
                p.pending_preview = None;
            }
        }
        Ok(self.reply())
    }

    fn reply(&self) -> serde_json::Value {
        serde_json::json!({"ok":true,"audio":self.status()})
    }

    pub fn mix(&self, program: &mut [f32; BLOCK_SAMPLES], mic_peak: f32) {
        let Ok(mut p) = self.playback.try_lock() else {
            self.contended_blocks.fetch_add(1, Relaxed);
            return;
        };
        let has_program = p.decks.iter().any(|d| d.playing) || !p.voices.is_empty();
        let has_preview = p.preview.is_some();
        let mut bus = [0.; BLOCK_SAMPLES];
        let has_music=p.decks.iter().any(|d|d.playing);
        if has_music {p.deck_mix(&mut bus,mic_peak);}
        let title=p.primary_track().cloned();
        self.dj_visual.observe(&mut p.meter,if has_music{&bus}else{&[]},title.as_ref());
        if !has_program && !has_preview {return;}
        let monitor = p.monitor;
        if has_program {
            let gain = p.sound_gain;
            p.voices.retain_mut(|voice| voice.mix(&mut bus, gain));
            self.mixed_blocks.fetch_add(1, Relaxed);
        }
        if has_program {
            for (dst, sample) in program.iter_mut().zip(&bus) {
                *dst = (*dst + sample).clamp(-1., 1.);
            }
        }
        if has_preview || monitor {
            if !monitor {
                bus.fill(0.);
            }
            if let Some(preview) = p.preview.as_mut() {
                if !preview.mix(&mut bus, 1.) {
                    p.preview = None;
                }
            }
            for sample in &mut bus {
                *sample = sample.clamp(-1., 1.);
            }
            if self.monitor.try_send(bus).is_err() {
                self.monitor_drops.fetch_add(1, Relaxed);
            }
        }
    }
}

fn checked(value: f32, low: f32, high: f32) -> Result<f32> {
    ensure!(
        (low..=high).contains(&value),
        "Value must be between {low} and {high}"
    );
    Ok(value)
}

fn library() -> Result<Vec<Asset>> {
    let bundle = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.parent()?.join("Resources/starter-audio")));
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../assets/starter-audio");
    let root = bundle
        .filter(|b| b.join("manifest.json").is_file())
        .unwrap_or(source);
    let path = root.join("manifest.json");
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(path).context("Bundled audio library is unavailable")?)?;
    ensure!(
        manifest.schema == "producer.audio-library/1" && manifest.assets.len() <= 500,
        "Invalid audio library"
    );
    let mut ids = std::collections::HashSet::new();
    manifest
        .assets
        .into_iter()
        .map(|a| {
            ensure!(
                ids.insert(a.item.id.clone()),
                "Duplicate audio ID {}",
                a.item.id
            );
            ensure!(
                a.file
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_))),
                "Invalid audio resource path"
            );
            let path = root.join(a.file);
            ensure!(path.is_file(), "Bundled audio '{}' is missing", a.item.name);
            Ok(Asset { item: a.item, path })
        })
        .collect()
}

extern "C" {
    fn studio_audio_open(path: *const c_char) -> *mut c_void;
    fn studio_audio_read(file: *mut c_void, out: *mut f32, frames: u32) -> i32;
    fn studio_audio_close(file: *mut c_void);
    fn studio_monitor_open() -> *mut c_void;
    fn studio_monitor_write(handle: *mut c_void, samples: *const f32) -> i32;
    fn studio_monitor_close(handle: *mut c_void);
}
struct Decoder(*mut c_void);
impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { studio_audio_close(self.0) }
    }
}

fn decode(asset: &Asset) -> Result<Arc<Clip>> {
    let path = CString::new(asset.path.as_os_str().as_encoded_bytes())?;
    let reader = unsafe { studio_audio_open(path.as_ptr()) };
    ensure!(!reader.is_null(), "Cannot decode {}", asset.item.name);
    let reader = Decoder(reader);
    let limit = if asset.item.kind == Kind::Music {
        MAX_TRACK_SAMPLES
    } else {
        MAX_EFFECT_SAMPLES
    };
    let estimate = ((asset.item.duration_ms.min(600_000) as usize) * RATE * 2 / 1000).min(limit);
    let mut pcm = Vec::with_capacity(estimate);
    let mut chunk = [0.; 8192];
    loop {
        let count =
            unsafe { studio_audio_read(reader.0, chunk.as_mut_ptr(), (chunk.len() / 2) as u32) };
        ensure!(count >= 0, "Could not read {}", asset.item.name);
        if count == 0 {
            break;
        }
        let count = count as usize * 2;
        ensure!(
            pcm.len() + count <= limit,
            "{} exceeds the decoded audio limit",
            asset.item.name
        );
        pcm.try_reserve_exact(count.max(262_144).min(limit - pcm.len()))?;
        pcm.extend(
            chunk[..count]
                .iter()
                .map(|&v| if v.is_finite() { v.clamp(-1., 1.) } else { 0. }),
        );
    }
    ensure!(!pcm.is_empty(), "{} contains no audio", asset.item.name);
    Ok(Arc::new(Clip {
        id: asset.item.id.clone(),
        name: Arc::from(asset.item.name.as_str()),
        pcm: pcm.into_boxed_slice(),
    }))
}

fn requested(p: &Playback, job: &Load) -> bool {
    match job.destination {
        Destination::Deck(d, _) => p.decks[d.index()]
            .loading
            .as_ref()
            .is_some_and(|pending| pending.serial == job.serial),
        Destination::Sound(..) => p.pending.iter().any(|v| v.0 == job.serial),
        Destination::Preview => p
            .pending_preview
            .as_ref()
            .is_some_and(|v| v.0 == job.serial),
    }
}

fn decode_worker(queue: Receiver<Load>, playback: &Mutex<Playback>) {
    // The cache keeps the last owner of every active clip off the mix lane.
    let mut cache = std::collections::VecDeque::<Arc<Clip>>::with_capacity(MAX_CACHE_ENTRIES);
    for job in queue {
        if !requested(&playback.lock().unwrap(), &job) {
            continue;
        }
        let loaded = if let Some(index) = cache.iter().position(|c| c.id == job.asset.item.id) {
            let clip = cache.remove(index).unwrap();
            cache.push_back(clip.clone());
            Ok(clip)
        } else {
            decode(&job.asset).and_then(|clip|{
                while cache.len()>=MAX_CACHE_ENTRIES || (clip.pcm.len()+cache.iter().map(|c|c.pcm.len()).sum::<usize>())*4>MAX_PCM_BYTES {
                    let Some(old)=cache.iter().position(|c|Arc::strong_count(c)==1) else {
                        bail!("Audio memory is busy. Unload a deck or stop some pads before loading another long track.");
                    };
                    cache.remove(old);
                }
                cache.push_back(clip.clone());
                Ok(clip)
            })
        };
        let mut p = playback.lock().unwrap();
        if !requested(&p, &job) {
            continue;
        }
        match job.destination {
            Destination::Deck(deck, play) => {
                let d = &mut p.decks[deck.index()];
                d.loading = None;
                match loaded {
                    Ok(clip) => {
                        d.clip = Some(clip);
                        d.frame = 0;
                        d.envelope = 0.;
                        d.playing = play;
                    }
                    Err(e) => p.error = Some(e.to_string()),
                }
            }
            Destination::Sound(pad, mode) => {
                p.pending.retain(|v| v.0 != job.serial);
                match loaded {
                    Ok(clip) => {
                        if mode != Mode::Overlap {
                            p.voices.retain(|v| v.clip.id != clip.id);
                        }
                        if p.voices.len() < MAX_VOICES {
                            p.voices.push(Voice::new(clip, pad, mode == Mode::Loop));
                        } else {
                            p.error = Some("All 16 sound voices are active".into());
                        }
                    }
                    Err(e) => p.error = Some(e.to_string()),
                }
            }
            Destination::Preview => {
                p.pending_preview = None;
                match loaded {
                    Ok(clip) => p.preview = Some(Voice::new(clip, Pad::default(), false)),
                    Err(e) => p.error = Some(e.to_string()),
                }
            }
        }
    }
}

fn monitor_worker(queue: Receiver<[f32; BLOCK_SAMPLES]>, failed: &AtomicBool, drops: &AtomicU64) {
    let mut player: *mut c_void = std::ptr::null_mut();
    loop {
        let block = match queue.recv_timeout(Duration::from_millis(300)) {
            Ok(block) => block,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !player.is_null() {
                    unsafe { studio_monitor_close(player) };
                    player = std::ptr::null_mut();
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if player.is_null() {
            player = unsafe { studio_monitor_open() };
        }
        if player.is_null() {
            failed.store(true, Relaxed);
            continue;
        }
        let sent = unsafe { studio_monitor_write(player, block.as_ptr()) };
        if sent <= 0 {
            drops.fetch_add(1, Relaxed);
        }
        if sent < 0 {
            unsafe { studio_monitor_close(player) };
            player = std::ptr::null_mut();
            failed.store(true, Relaxed);
        } else {
            failed.store(false, Relaxed);
        }
    }
    if !player.is_null() {
        unsafe { studio_monitor_close(player) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_until(desk: &Desk, predicate: impl Fn(&Status) -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        loop {
            let state = desk.status();
            assert!(state.error.is_none(), "{:?}", state.error);
            if predicate(&state) {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Audio load did not finish"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn next_track_follows_the_library_and_preserves_playback() {
        let room = tempfile::tempdir().unwrap();
        let desk = Desk::open(room.path()).unwrap();
        let deck = DeckId::A;
        let first = desk.lookup("waiting-in-case").unwrap();
        let path = room.path().join("Another track.mp3");
        fs::copy(&first.path, &path).unwrap();
        let added = desk.execute(Command::Import { kind: Kind::Music, path }).unwrap();
        let next = added["item"]["id"].as_str().unwrap();
        let check = |id: &str, playing: bool| {
            wait_until(&desk, |status| {
                let d = &status.decks[deck.index()];
                d.loading.is_none() && d.id.as_deref() == Some(id) && d.playing == playing
            });
        };
        desk.execute(Command::NextTrack { deck }).unwrap();
        check(&first.item.id, false);
        desk.execute(Command::PlayDeck { deck }).unwrap();
        desk.execute(Command::NextTrack { deck }).unwrap();
        check(next, true);
        desk.execute(Command::NextTrack { deck }).unwrap();
        check(&first.item.id, true);
        desk.execute(Command::PauseDeck { deck }).unwrap();
        desk.execute(Command::NextTrack { deck }).unwrap();
        check(next, false);
    }

    #[test]
    fn room_sound_membership_migrates_and_persists_without_filtering_the_catalog() {
        let room = tempfile::tempdir().unwrap();
        fs::write(room.path().join("studio-audio.json"),
            r#"{"pads":{"wind-whoosh":{"mode":"loop","gain":0.7,"fadeMs":12}}}"#).unwrap();
        let desk = Desk::open(room.path()).unwrap();
        assert_eq!(desk.room_sounds("", 0, 32).total, 1);
        assert!(desk.sound_added("wind-whoosh"));
        desk.execute(Command::SetSoundAdded { id: "wind-whoosh".into(), added: false }).unwrap();
        let other = desk.catalog(Some(Kind::Effect), "", 0, 1).items.remove(0);
        for _ in 0..2 {
            desk.execute(Command::SetSoundAdded { id: other.id.clone(), added: true }).unwrap();
        }
        let reopened = Desk::open(room.path()).unwrap();
        assert_eq!(reopened.room_sounds("", 0, 32).total, 1);
        assert_eq!(reopened.room_sounds("", 0, 32).items[0].id, other.id);
        assert!(!reopened.sound_added("wind-whoosh"));
        assert_eq!(reopened.catalog(Some(Kind::Effect), "", 0, 1).total, 255);
        assert!(!reopened.status().mixing);
        reopened.execute(Command::Mix { enabled: true }).unwrap();
        assert!(Desk::open(room.path()).unwrap().status().mixing);
    }

    #[test]
    fn duck_amount_preserves_existing_rooms_and_controls_music_reduction() {
        let room = tempfile::tempdir().unwrap();
        fs::write(room.path().join("studio-audio.json"), r#"{"duckMusic":true}"#).unwrap();
        let desk = Desk::open(room.path()).unwrap();
        assert_eq!(desk.status().duck_amount, 0.72);
        for amount in [0., 0.35, 1.] {
            desk.execute(Command::DuckAmount { amount }).unwrap();
            let mut p = desk.playback.lock().unwrap();
            p.decks[0].clip = Some(Arc::new(Clip {
                id: "duck-test".into(),
                name: "Duck test".into(),
                pcm: vec![0.5; BLOCK_SAMPLES * 128].into_boxed_slice(),
            }));
            p.decks[0].frame = 0;
            p.decks[0].playing = true;
            let mut out = [0.; BLOCK_SAMPLES];
            for _ in 0..30 {
                out.fill(0.);
                p.deck_mix(&mut out, 0.15);
            }
            assert!((out[BLOCK_SAMPLES - 1] - 0.5 * p.music_gain * (1. - amount)).abs() < 0.0002);
            for _ in 0..108 {
                p.decks[0].frame = 0;
                out.fill(0.);
                p.deck_mix(&mut out, 0.);
            }
            assert!((out[BLOCK_SAMPLES - 1] - 0.5 * p.music_gain).abs() < 0.0002);
        }
        assert!(desk.execute(Command::DuckAmount { amount: 1.1 }).is_err());
        assert_eq!(Desk::open(room.path()).unwrap().status().duck_amount, 1.);
    }

    #[test]
    fn studio_audio_catalog_decodes_every_bundled_item() {
        let assets = library().unwrap();
        assert_eq!(
            assets
                .iter()
                .filter(|a| a.item.kind == Kind::Effect)
                .count(),
            255
        );
        assert_eq!(
            assets.iter().filter(|a| a.item.kind == Kind::Music).count(),
            1
        );
        for asset in assets {
            let clip = decode(&asset).unwrap_or_else(|error| panic!("{}: {error}", asset.item.id));
            assert!(
                clip.pcm.iter().any(|v| v.abs() > 0.0001),
                "{} is silent",
                asset.item.id
            );
        }
    }

    #[test]
    fn studio_audio_preview_program_decks_and_pad_settings() {
        let room = tempfile::tempdir().unwrap();
        let mut desk = Desk::open(room.path()).unwrap();
        // Verify the monitor bus without opening the Mac's speaker in a test.
        let (monitor, observed) = mpsc::sync_channel(4);
        desk.monitor = monitor;
        let id = String::from("wind-whoosh");
        assert_eq!(
            desk.catalog(Some(Kind::Effect), "whoosh", 0, 64)
                .items
                .iter()
                .filter(|item| item.id == id)
                .count(),
            1
        );
        desk.execute(Command::Preview { id: id.clone() }).unwrap();
        wait_until(&desk, |status| {
            status.preview.as_deref() == Some(id.as_str())
                && desk.playback.lock().unwrap().preview.is_some()
        });
        let mut audible = false;
        for _ in 0..16 {
            let mut program = [0.; BLOCK_SAMPLES];
            desk.mix(&mut program, 0.);
            assert!(program.iter().all(|&v| v == 0.));
            if let Ok(block) = observed.try_recv() {
                audible |= block.iter().any(|v| v.abs() > 0.0001);
            }
        }
        assert!(audible);
        desk.execute(Command::StopPreview).unwrap();
        desk.execute(Command::ConfigurePad {
            id: id.clone(),
            mode: Mode::Loop,
            gain: 0.7,
            fade_ms: 12,
        })
        .unwrap();
        desk.execute(Command::Trigger {
            id: id.clone(),
            mode: None,
        })
        .unwrap();
        wait_until(&desk, |status| status.active_sounds.contains(&id));
        let mut audible = false;
        for _ in 0..16 {
            let mut program = [0.; BLOCK_SAMPLES];
            desk.mix(&mut program, 0.);
            audible |= program.iter().any(|v| v.abs() > 0.0001);
        }
        assert!(audible);
        desk.execute(Command::Trigger {
            id: id.clone(),
            mode: None,
        })
        .unwrap();
        for _ in 0..4 {
            desk.mix(&mut [0.; BLOCK_SAMPLES], 0.);
        }
        assert!(desk.status().active_sounds.is_empty());
        assert_eq!(Desk::open(room.path()).unwrap().pad(&id).mode, Mode::Loop);
        desk.execute(Command::LoadDeck {
            deck: DeckId::A,
            id: "waiting-in-case".into(),
            play: true,
        })
        .unwrap();
        wait_until(&desk, |status| status.decks[0].playing);
        desk.execute(Command::SeekDeck {
            deck: DeckId::A,
            seconds: 30.,
        })
        .unwrap();
        desk.execute(Command::Crossfade { value: -1. }).unwrap();
        let mut program = [0.; BLOCK_SAMPLES];
        desk.mix(&mut program, 0.);
        assert!(program.iter().any(|v| v.abs() > 0.0001));
        assert!(desk.status().decks[0].seconds > 30.);
        desk.execute(Command::PauseDeck { deck: DeckId::A })
            .unwrap();
        program.fill(0.);
        desk.mix(&mut program, 0.);
        assert!(program.iter().all(|&v| v == 0.));
        desk.execute(Command::UnloadDeck { deck: DeckId::A })
            .unwrap();
        assert!(desk.status().decks[0].id.is_none());
    }

    #[test]
    fn studio_audio_agent_review_and_ipc_share_the_same_action() {
        let cue = serde_json::json!({"op":"studioAudio","command":{"action":"trigger","id":"wind-whoosh","mode":"restart"}});
        let command = crate::assistant::room_action(cue.clone()).unwrap();
        assert_eq!(serde_json::to_value(command).unwrap(), cue);
        assert!(
            crate::assistant::room_action(serde_json::json!({"op":"studioAudio",
            "command":{"action":"import","kind":"music","path":"/tmp/test.mp3"}}))
            .is_err()
        );
        for panel in [
            crate::workspace::PanelId::Dj,
            crate::workspace::PanelId::Sound,
        ] {
            let mut layout = crate::workspace::Workspace::default();
            for edge in crate::workspace::Edge::ALL {
                layout
                    .apply(crate::workspace::WorkspaceCommand::Place {
                        panel,
                        edge,
                        before: None,
                    })
                    .unwrap();
                assert_eq!(layout.panels[&panel].edge, edge);
            }
        }
    }
}
