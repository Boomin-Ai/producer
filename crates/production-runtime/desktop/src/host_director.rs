//! Two isolated microphones at the mixer's 48 kHz, ten-millisecond cadence.
//! This detector runs before music, inserts, or the other microphone are mixed.
#[derive(Clone, Copy, Default)]
struct SpeechBand {
    previous: f32,
    high_pass: f32,
    low_pass: f32,
}
impl SpeechBand {
    fn level(&mut self, stereo: &[f32]) -> f32 {
        let mut energy = 0.;
        for frame in stereo.chunks_exact(2) {
            let mono = 0.5 * (frame[0] + frame[1]);
            // Single-pole 160 Hz high-pass followed by a 3.8 kHz low-pass.
            self.high_pass = 0.9795 * (self.high_pass + mono - self.previous);
            self.previous = mono;
            self.low_pass += 0.392 * (self.high_pass - self.low_pass);
            energy += self.low_pass * self.low_pass;
        }
        (energy / (stereo.len() / 2).max(1) as f32).sqrt()
    }
}

pub struct Director {
    bands: [SpeechBand; 2],
    floor: [f32; 2],
    envelope: [f32; 2],
    candidate: Option<usize>,
    consecutive: u16,
    dwell: u16,
    quiet: u16,
    pub selected: Option<usize>,
}

impl Default for Director {
    fn default() -> Self {
        Self {
            bands: [SpeechBand::default(); 2],
            floor: [0.0025; 2],
            envelope: [0.; 2],
            candidate: None,
            consecutive: 0,
            dwell: 0,
            quiet: 0,
            selected: None,
        }
    }
}
impl Director {
    pub fn input(&mut self, index: usize, pcm: &[f32], gain: f32) -> f32 {
        if gain <= 0. {
            self.bands[index] = SpeechBand::default();
            return 0.;
        }
        self.bands[index].level(pcm)
    }
    pub fn observe(&mut self, levels: [f32; 2]) {
        let mut speech = [0.; 2];
        for (i, level) in levels.into_iter().enumerate() {
            let floor = &mut self.floor[i];
            let rate = if level < *floor {
                0.035
            } else if level < *floor * 2.5 {
                0.008
            } else {
                0.00016
            };
            *floor += (level - *floor) * rate;
            let env = &mut self.envelope[i];
            *env += (level - *env) * if level > *env { 0.34 } else { 0.12 };
            speech[i] = (*env - (*floor * 2.4).max(0.005)).max(0.);
        }
        if speech == [0.; 2] {
            self.quiet = self.quiet.saturating_add(1);
        } else {
            self.quiet = 0;
        }
        self.dwell = self.dwell.saturating_sub(1);
        if self.quiet >= 220 {
            self.selected = None;
        }
        let leader = if speech[1] > speech[0] { 1 } else { 0 };
        let candidate =
            (speech[leader] > 0.003 && speech[leader] > speech[1 - leader] * 1.9).then_some(leader);
        if self.candidate != candidate {
            self.consecutive = 0;
            self.candidate = candidate;
        }
        if let Some(host) = candidate {
            self.consecutive = self.consecutive.saturating_add(1);
            let attack = if self.selected.is_some() { 38 } else { 26 };
            if self.selected != Some(host) && self.dwell == 0 && self.consecutive >= attack {
                self.selected = Some(host);
                self.dwell = 110;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn feed(d: &mut Director, levels: [f32; 2], n: usize) {
        for _ in 0..n {
            d.observe(levels);
        }
    }
    #[test]
    fn stable_turns_bleed_overlap_silence_and_clicks() {
        let mut d = Director::default();
        feed(&mut d, [0.003, 0.004], 100);
        feed(&mut d, [0.5, 0.], 4);
        feed(&mut d, [0., 0.], 100);
        assert_eq!(d.selected, None);
        feed(&mut d, [0.1, 0.015], 45);
        assert_eq!(d.selected, Some(0));
        feed(&mut d, [0.08, 0.085], 110);
        assert_eq!(d.selected, Some(0));
        feed(&mut d, [0., 0.2], 10);
        assert_eq!(d.selected, Some(0));
        feed(&mut d, [0.01, 0.14], 55);
        assert_eq!(d.selected, Some(1));
        feed(&mut d, [0., 0.], 270);
        assert_eq!(d.selected, None);
    }
}
