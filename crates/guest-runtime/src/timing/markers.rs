//! Bounded diagnostic for generated numbered media. Never enabled for ordinary
//! rooms, and never used to decide scheduling or authorization.
use serde_json::{json, Value};
use std::time::Instant;

pub fn enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED
        .get_or_init(|| std::env::var("PRODUCER_RTC_INGRESS_MARKER_PROOF").as_deref() == Ok("1"))
}
pub struct Trace {
    base: Instant,
    events: Vec<Value>,
    overflow: u64,
}
impl Default for Trace {
    fn default() -> Self {
        Self {
            base: Instant::now(),
            events: Vec::with_capacity(128),
            overflow: 0,
        }
    }
}
impl Trace {
    pub fn push(&mut self, kind: &str, id: u8, scheduled: Instant) {
        if self.events.len() == 128 {
            self.overflow += 1;
            return;
        }
        let relative = |at: Instant| {
            if at >= self.base {
                at.duration_since(self.base).as_micros() as i128
            } else {
                -(self.base.duration_since(at).as_micros() as i128)
            }
        };
        self.events.push(json!({"kind":kind,"id":id,"scheduled_us":relative(scheduled),"observed_us":relative(Instant::now())}));
    }
    pub fn push_decoded(&mut self, kind: &str, id: u8, arrived: Instant, origin: Option<i64>) {
        let before = self.events.len();
        self.push(kind, id, arrived);
        if self.events.len() > before {
            self.events.last_mut().unwrap()["sender_origin_us"] = json!(origin);
        }
    }
    pub fn report(&self) -> Value {
        json!({"events":self.events,"overflow":self.overflow,"clock":"same native Instant origin; decoded arrival and accepted submission, not recorded output"})
    }
}
#[derive(Default)]
pub struct AudioTrace {
    began: Option<Instant>,
    rows: Vec<Value>,
}
impl AudioTrace {
    pub fn observe(&mut self, kind: &str, sequence: u64, samples: &[i16], at: Instant, accepted: Option<bool>) {
        let peak = samples.iter().map(|x| i32::from(*x).unsigned_abs()).max().unwrap_or(0);
        if self.began.is_none() && peak > 2000 { self.began = Some(at); }
        let Some(began) = self.began else { return; };
        if at.saturating_duration_since(began).as_secs() >= 16 || self.rows.len() >= 4096 { return; }
        let relative = if at >= began { at.duration_since(began).as_micros() as i128 } else { -(began.duration_since(at).as_micros() as i128) };
        self.rows.push(json!({"kind":kind,"sequence":sequence,"relative_us":relative,"peak":peak,
            "nonzero_samples":samples.iter().filter(|x| **x != 0).count(),"accepted":accepted}));
    }
    pub fn report(&self) -> Value { json!({"rows":self.rows,"maximum_rows":4096,"maximum_seconds":16,"raw_pcm_retained":false}) }
}
#[derive(Default)]
pub struct Detector {
    audio_active: bool,
    video_active: bool,
}
impl Detector {
    pub fn audio(&mut self, samples: &[i16], channels: usize) -> Option<u8> {
        if !matches!(channels, 1 | 2) || samples.len() != 480 * channels {
            return None;
        }
        let active = samples.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>()
            / samples.len() as f64
            > 4_000_000.;
        if !active {
            self.audio_active = false;
            return None;
        }
        if self.audio_active {
            return None;
        }
        let mut energy = [0f64; 16];
        for (id, total) in energy.iter_mut().enumerate() {
            let coefficient =
                2. * (2. * std::f64::consts::PI * (997. + 128. * id as f64) / 48000.).cos();
            let (mut previous, mut before) = (0., 0.);
            for frame in samples.chunks_exact(channels) {
                let sample = frame.iter().map(|x| f64::from(*x)).sum::<f64>() / channels as f64;
                let value = sample + coefficient * previous - before;
                before = previous;
                previous = value;
            }
            *total =
                (previous * previous + before * before - coefficient * previous * before).max(0.);
        }
        let mut order: Vec<_> = (0..16).collect();
        order.sort_by(|a, b| energy[*b].total_cmp(&energy[*a]));
        if energy[order[0]] > 2. * energy[order[1]].max(1.) {
            self.audio_active = true;
            Some(order[0] as u8)
        } else {
            None
        }
    }
    pub fn video(&mut self, y: &[u8], width: u32, height: u32, stride: u32) -> Option<u8> {
        let (w, h, s) = (width as usize, height as usize, stride as usize);
        if w < 320 || h < 180 || w * 9 != h * 16 || s < w || y.len() < s * h {
            return None;
        }
        let active = y[(h / 2) * s + w / 2] > 180;
        let rising = active && !self.video_active;
        self.video_active = active;
        rising.then(|| {
            (0..8).fold(0, |id, bit| {
                id | if y[(h * 8 / 180) * s + ((bit * 40 + 20) * w / 320)] > 180 {
                    1 << bit
                } else {
                    0
                }
            })
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labeled_tones_and_padded_video_decode_once_per_pulse() {
        let mut d = Detector::default();
        for id in 0..16 {
            let pcm: Vec<_> = (0..480)
                .map(|n| {
                    ((n as f64 * 2. * std::f64::consts::PI * (997. + 128. * id as f64) / 48000.)
                        .sin()
                        * 12000.) as i16
                })
                .collect();
            assert_eq!(d.audio(&pcm, 1), Some(id));
            assert_eq!(d.audio(&pcm, 1), None);
            assert_eq!(d.audio(&[0; 480], 1), None);
        }
        let mut y = vec![235; 336 * 180];
        for bit in 0..8 {
            y[8 * 336 + bit * 40 + 20] = if 133 & (1 << bit) != 0 { 235 } else { 16 };
        }
        assert_eq!(d.video(&y, 320, 180, 336), Some(133));
        assert_eq!(d.video(&y, 320, 180, 336), None);
        assert_eq!(d.video(&y[..20], 320, 180, 336), None);
    }
    #[test]
    fn uncertain_partial_onset_cannot_latch_out_the_full_tone() {
        let mut d = Detector::default();
        let mut partial = [0i16; 480];
        partial[..16].fill(12000);
        assert_eq!(d.audio(&partial, 1), None);
        let tone: Vec<_> = (0..480)
            .map(|n| {
                ((n as f64 * 2. * std::f64::consts::PI * (997. + 128. * 7.) / 48000.).sin()
                    * 12000.) as i16
            })
            .collect();
        assert_eq!(d.audio(&tone, 1), Some(7));
    }
    #[test]
    fn audio_trace_ignores_initial_silence_and_bounds_retention() {
        let now = Instant::now();
        let mut trace = AudioTrace::default();
        trace.observe("decoded",1,&[0;480],now,None);
        assert!(trace.rows.is_empty());
        trace.observe("decoded",2,&[3000;480],now,None);
        trace.observe("submission",2,&[3000;480],now+std::time::Duration::from_millis(120),Some(false));
        trace.observe("decoded",3,&[3000;480],now+std::time::Duration::from_secs(16),None);
        assert_eq!(trace.rows.len(),2);
        assert_eq!(trace.rows[1]["accepted"],false);
        for i in 0..4200 { trace.observe("decoded",i,&[3000;480],now,None); }
        assert_eq!(trace.rows.len(),4096);
    }
    #[test]
    fn trace_is_bounded_and_preserves_signed_scheduling_offsets() {
        let mut trace = Trace::default();
        let before = trace.base - std::time::Duration::from_millis(1);
        for _ in 0..130 {
            trace.push("audio", 3, before);
        }
        let report = trace.report();
        assert_eq!(report["events"].as_array().unwrap().len(), 128);
        assert_eq!(report["overflow"], 2);
        assert_eq!(report["events"][0]["scheduled_us"], -1000);
    }
}
