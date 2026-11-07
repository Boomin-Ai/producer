//! Lock-free, bounded DJ-only analysis from the post-fader OBS bus 5.
//! Only the DJ sources route here (ordinary sources use buses 0/1).
//! No PCM is retained or transported; readers receive eight bands and 32 peaks.
use super::ffi;
use serde::Serialize;
use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    time::Instant,
};
const BANDS: usize = 8;
const WAVE: usize = 32;
const CUTS: [f32; BANDS] = [80., 160., 320., 640., 1280., 2560., 5120., 10000.];
struct Slot {
    generation: AtomicU64,
    at: AtomicU64,
    gain: AtomicU32,
    rms: AtomicU32,
    bands: [AtomicU32; BANDS],
    wave: [AtomicU32; WAVE],
    filters: [AtomicU32; BANDS * 2],
}
impl Slot {
    const fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            at: AtomicU64::new(0),
            gain: AtomicU32::new(0),
            rms: AtomicU32::new(0),
            bands: [const { AtomicU32::new(0) }; BANDS],
            wave: [const { AtomicU32::new(0) }; WAVE],
            filters: [const { AtomicU32::new(0) }; BANDS * 2],
        }
    }
}
static SLOTS: [Slot; 1] = [Slot::new()];
static ACTIVE: Mutex<Option<usize>> = Mutex::new(None);
static CALLBACKS: AtomicU64 = AtomicU64::new(0);
static MAX_RMS: AtomicU32 = AtomicU32::new(0);
pub fn diagnostics() -> String {
    format!(
        "listeners={} callbacks={} peakRms={} ageMs={} gain={}",
        LISTENERS.load(Ordering::Relaxed),
        CALLBACKS.load(Ordering::Relaxed),
        get(&MAX_RMS),
        millis().saturating_sub(SLOTS[0].at.load(Ordering::Acquire)),
        get(&SLOTS[0].gain)
    )
}
static POSITION: AtomicU64 = AtomicU64::new(0);
static DURATION: AtomicU64 = AtomicU64::new(0);
static TIMELINE_AT: AtomicU64 = AtomicU64::new(0);
static PLAYING: AtomicBool = AtomicBool::new(false);
static MIXING: AtomicBool = AtomicBool::new(false);
static BLEND: AtomicU32 = AtomicU32::new(0);
pub fn timeline(position: i64, duration: i64, playing: bool, blend: f32, mixing: bool) {
    POSITION.store(position.max(0) as u64, Ordering::Relaxed);
    DURATION.store(duration.max(0) as u64, Ordering::Relaxed);
    PLAYING.store(playing, Ordering::Relaxed);
    MIXING.store(mixing, Ordering::Relaxed);
    put(&BLEND, blend.clamp(0., 1.));
    TIMELINE_AT.store(millis(), Ordering::Release);
}
static LISTENERS: AtomicUsize = AtomicUsize::new(0);
pub struct Subscription;
pub fn subscribe() -> Subscription {
    LISTENERS.fetch_add(1, Ordering::Relaxed);
    Subscription
}
impl Drop for Subscription {
    fn drop(&mut self) {
        LISTENERS.fetch_sub(1, Ordering::Relaxed);
    }
}
static EPOCH: OnceLock<Instant> = OnceLock::new();
fn millis() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}
fn put(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed)
}
fn get(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub position_ms: u64,
    pub duration_ms: u64,
    pub playing: bool,
    pub blend: f32,
    pub mixing: bool,
    pub energy: f32,
    pub bass: f32,
    pub high: f32,
    pub bands: [f32; BANDS],
    pub wave: [f32; WAVE],
}
impl Default for Frame {
    fn default() -> Self {
        Self {
            position_ms: 0,
            duration_ms: 0,
            playing: false,
            blend: 0.,
            mixing: false,
            energy: 0.,
            bass: 0.,
            high: 0.,
            bands: [0.; BANDS],
            wave: [0.; WAVE],
        }
    }
}
fn analyze(left: &[f32], right: &[f32], state: &mut [f32; BANDS * 2]) -> Frame {
    let mut out = Frame::default();
    let n = left.len().min(right.len());
    if n == 0 {
        return out;
    }
    let alpha = CUTS.map(|f| 1. - (-2. * std::f32::consts::PI * f / 48000.).exp());
    for i in 0..n {
        let l = if left[i].is_finite() {
            left[i].clamp(-4., 4.)
        } else {
            0.
        };
        let r = if right[i].is_finite() {
            right[i].clamp(-4., 4.)
        } else {
            0.
        };
        out.energy += (l * l + r * r) * 0.5;
        let mut previous = [0.; 2];
        for band in 0..BANDS {
            for (ch, input) in [l, r].into_iter().enumerate() {
                let index = band * 2 + ch;
                state[index] += alpha[band] * (input - state[index]);
                let value = state[index] - previous[ch];
                previous[ch] = state[index];
                out.bands[band] += value * value * 0.5;
            }
        }
        let bucket = (i * WAVE / n).min(WAVE - 1);
        let sample = if l.abs() > r.abs() { l } else { r };
        if sample.abs() > out.wave[bucket].abs() {
            out.wave[bucket] = sample;
        }
    }
    out.energy = (out.energy / n as f32).sqrt();
    for value in &mut out.bands {
        *value = (*value / n as f32).sqrt();
    }
    out
}
#[repr(C)]
struct Convert {
    rate: u32,
    format: i32,
    speakers: i32,
    allow_clipping: bool,
}
#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    fn audio_output_connect(
        audio: *mut ffi::audio_t,
        mix: usize,
        convert: *const Convert,
        callback: extern "C" fn(*mut c_void, usize, *mut ffi::audio_data),
        param: *mut c_void,
    ) -> bool;
    fn audio_output_disconnect(
        audio: *mut ffi::audio_t,
        mix: usize,
        callback: extern "C" fn(*mut c_void, usize, *mut ffi::audio_data),
        param: *mut c_void,
    );
}
extern "C" fn capture(_param: *mut c_void, mix: usize, audio: *mut ffi::audio_data) {
    if mix != 5 || LISTENERS.load(Ordering::Relaxed) == 0 || audio.is_null() {
        return;
    }
    CALLBACKS.fetch_add(1, Ordering::Relaxed);
    let slot = &SLOTS[0];
    let a = unsafe { &*audio };
    if a.frames == 0 || a.frames > 4096 || a.data[0].is_null() || a.data[1].is_null() {
        return;
    }
    let mut state = std::array::from_fn(|i| get(&slot.filters[i]));
    let left = unsafe { std::slice::from_raw_parts(a.data[0] as *const f32, a.frames as usize) };
    let right = unsafe { std::slice::from_raw_parts(a.data[1] as *const f32, a.frames as usize) };
    let frame = analyze(left, right, &mut state);
    MAX_RMS.fetch_max(frame.energy.to_bits(), Ordering::Relaxed);
    slot.generation.fetch_add(1, Ordering::AcqRel);
    put(&slot.rms, frame.energy);
    for i in 0..BANDS {
        put(&slot.bands[i], frame.bands[i]);
    }
    for i in 0..WAVE {
        put(&slot.wave[i], frame.wave[i]);
    }
    for i in 0..BANDS * 2 {
        put(&slot.filters[i], state[i]);
    }
    slot.at.store(millis(), Ordering::Relaxed);
    slot.generation.fetch_add(1, Ordering::Release);
}
/// Called on the engine thread. Never acquires a lock on the audio callback.
pub fn start() -> Result<(), String> {
    let mut active = ACTIVE
        .lock()
        .map_err(|_| "DJ analysis lifecycle lock failed")?;
    if active.is_some() {
        return Ok(());
    }
    let _ = millis();
    let audio = unsafe { ffi::obs_get_audio() };
    if audio.is_null() {
        return Err("DJ analysis audio bus unavailable".into());
    }
    let convert = Convert {
        rate: 48000,
        format: 8,
        speakers: 2,
        allow_clipping: false,
    };
    if !unsafe { audio_output_connect(audio, 5, &convert, capture, std::ptr::null_mut()) } {
        return Err("DJ analysis bus could not connect".into());
    }
    put(&SLOTS[0].gain, 1.);
    *active = Some(audio as usize);
    Ok(())
}
pub fn stop() {
    timeline(0, 0, false, 0., false);
    if let Ok(mut active) = ACTIVE.lock() {
        if let Some(audio) = active.take() {
            unsafe {
                audio_output_disconnect(
                    audio as *mut ffi::audio_t,
                    5,
                    capture,
                    std::ptr::null_mut(),
                );
            }
        }
    }
    let s = &SLOTS[0];
    put(&s.gain, 0.);
    s.at.store(0, Ordering::Release);
    for v in &s.filters {
        put(v, 0.);
    }
}
pub fn snapshot() -> Frame {
    let now = millis();
    let mut out = Frame::default();
    for s in &SLOTS {
        let g = get(&s.gain);
        if g <= 0.
            || s.at.load(Ordering::Acquire) == 0
            || now.saturating_sub(s.at.load(Ordering::Acquire)) > 200
        {
            continue;
        }
        // A busy writer causes one dropped visual sample, never an audio wait.
        let version = s.generation.load(Ordering::Acquire);
        if version % 2 != 0 {
            continue;
        }
        let energy = get(&s.rms) * g;
        let bands: [f32; BANDS] = std::array::from_fn(|i| get(&s.bands[i]) * g);
        let wave: [f32; WAVE] = std::array::from_fn(|i| get(&s.wave[i]) * g);
        if s.generation.load(Ordering::Acquire) != version {
            continue;
        }
        out.energy += energy * energy;
        for i in 0..BANDS {
            out.bands[i] += bands[i] * bands[i];
        }
        for i in 0..WAVE {
            out.wave[i] += wave[i];
        }
    }
    out.energy = (out.energy.sqrt() * 4.).clamp(0., 1.);
    for b in &mut out.bands {
        *b = (b.sqrt() * 7.).clamp(0., 1.);
    }
    for w in &mut out.wave {
        *w = (*w * 2.).clamp(-1., 1.);
    }
    out.bass = (out.bands[0] + out.bands[1]) * 0.5;
    out.high = (out.bands[6] + out.bands[7]) * 0.5;
    out.duration_ms = DURATION.load(Ordering::Relaxed);
    out.playing = PLAYING.load(Ordering::Relaxed);
    let age = now
        .saturating_sub(TIMELINE_AT.load(Ordering::Acquire))
        .min(500);
    out.position_ms =
        (POSITION.load(Ordering::Relaxed) + if out.playing { age } else { 0 }).min(out.duration_ms);
    out.blend = get(&BLEND);
    out.mixing = MIXING.load(Ordering::Relaxed);
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silence_and_invalid_samples_are_bounded() {
        let mut s = [0.; 16];
        let x = analyze(&[0.; 1024], &[0.; 1024], &mut s);
        assert_eq!(x.energy, 0.);
        let x = analyze(&[f32::NAN; 1024], &[f32::INFINITY; 1024], &mut s);
        assert_eq!(x.energy, 0.);
    }
    #[test]
    fn actual_samples_distinguish_bass_and_treble() {
        let tone = |hz: f32| {
            (0..4096)
                .map(|i| (i as f32 * hz * std::f32::consts::TAU / 48000.).sin() * 0.2)
                .collect::<Vec<_>>()
        };
        let low = tone(65.);
        let high = tone(7000.);
        let l = analyze(&low, &low, &mut [0.; 16]);
        let h = analyze(&high, &high, &mut [0.; 16]);
        assert!(l.bands[0] > h.bands[0] * 8.);
        assert!(h.bands[7] > l.bands[7] * 8.);
        assert!(l.energy > 0.1 && h.energy > 0.1);
    }
}
