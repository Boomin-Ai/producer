//! Live DJ render inputs. Audio contributes four numbers and title change events;
//! native font preparation and Metal upload run on their own worker.
use crate::platform::TextCache;
use anyhow::Result;
use std::sync::{
    atomic::{AtomicU32, AtomicU64, Ordering},
    mpsc::{self, SyncSender},
    Arc, Mutex,
};

#[derive(Default)]
pub struct Meter {
    low: f32,
    body: f32,
    envelopes: [f32; 4],
    title: Option<Arc<str>>,
    revision: u64,
}

impl Meter {
    fn update(&mut self, stereo: &[f32]) -> [f32; 4] {
        let mut energy = [0.; 4];
        for frame in stereo.chunks_exact(2) {
            let mono = (frame[0] + frame[1]) * 0.5;
            // 150 Hz and 2.5 kHz low-pass taps at the program's 48 kHz.
            self.low += 0.0195 * (mono - self.low);
            self.body += 0.279 * (mono - self.body);
            let mid = self.body - self.low;
            let high = mono - self.body;
            energy[0] += self.low * self.low;
            energy[1] += mid * mid;
            energy[2] += high * high;
            energy[3] += (frame[0] * frame[0] + frame[1] * frame[1]) * 0.5;
        }
        if stereo.is_empty() {
            self.low = 0.;
            self.body = 0.;
        }
        let samples = (stereo.len() / 2).max(1) as f32;
        for (i, envelope) in self.envelopes.iter_mut().enumerate() {
            let target = ((energy[i] / samples).sqrt() * [4.5, 6.2, 9., 3.4][i]).min(1.);
            *envelope += (target - *envelope) * if target > *envelope { 0.64 } else { 0.125 };
            if *envelope < 0.0002 { *envelope = 0.; }
        }
        self.envelopes
    }
}

type Prepared = Arc<Mutex<Option<(u64, Arc<TextCache>)>>>;
type TitleEvent = (u64, Option<Arc<str>>);

pub struct Visual {
    bands: [AtomicU32; 4],
    revision: AtomicU64,
    worker: SyncSender<TitleEvent>,
    prepared: Prepared,
}

impl Visual {
    pub fn open() -> Result<Self> {
        let prepared: Prepared = Arc::default();
        let output = prepared.clone();
        let (tx, rx) = mpsc::sync_channel::<TitleEvent>(2);
        std::thread::Builder::new()
            .name("producer-dj-title".into())
            .spawn(move || {
                while let Ok(mut event) = rx.recv() {
                    while let Ok(next) = rx.try_recv() { event = next; }
                    let label = event.1.and_then(|name| {
                        let title: String = name.chars().filter(|c| !c.is_control()).take(120).collect();
                        TextCache::dj_title(&format!("♪  {title}")).ok()
                    });
                    *output.lock().unwrap() = label.map(|cache| (event.0, Arc::new(cache)));
                }
            })?;
        Ok(Self { bands: Default::default(), revision: AtomicU64::new(0), worker: tx, prepared })
    }

    pub fn observe(&self, meter: &mut Meter, samples: &[f32], title: Option<&Arc<str>>) {
        if !samples.is_empty() || meter.envelopes.iter().any(|&v| v > 0.) {
            for (slot, level) in self.bands.iter().zip(meter.update(samples)) {
                slot.store(level.to_bits(), Ordering::Relaxed);
            }
        }
        if meter.title.as_ref() != title {
            let next = meter.revision + 1;
            if self.worker.try_send((next, title.cloned())).is_ok() {
                meter.title = title.cloned();
                meter.revision = next;
                self.revision.store(next, Ordering::Release);
            }
        }
    }

    pub fn bands(&self) -> [f32; 4] {
        self.bands.each_ref().map(|band| f32::from_bits(band.load(Ordering::Relaxed)))
    }

    pub fn label(&self) -> Option<Arc<TextCache>> {
        let revision = self.revision.load(Ordering::Acquire);
        let prepared = self.prepared.try_lock().ok()?;
        prepared.as_ref().filter(|(key, _)| *key == revision).map(|(_, cache)| cache.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dj_visual_detects_a_bass_tone_and_releases_to_idle() {
        let mut meter = Meter::default();
        let stereo: Vec<_> = (0..4800).flat_map(|i| {
            let v = (i as f32 * std::f32::consts::TAU * 80. / 48_000.).sin() * 0.15;
            [v, v]
        }).collect();
        let bands = stereo.chunks_exact(960).fold([0.;4],|_, block|meter.update(block));
        assert!(bands[0] > bands[2] * 4. && bands[3] > 0.15, "{bands:?}");
        for _ in 0..100 { meter.update(&[]); }
        assert_eq!(meter.envelopes, [0.;4]);
    }
}
