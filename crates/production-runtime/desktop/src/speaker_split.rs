use producer_native_media::boundary::OutputSize;

pub const ID: &str = "speaker-split";
pub const CENTER: f32 = 0.5;
const FOCUS_SHARE: f32 = 0.64;
const VOICE_FLOOR: f32 = 0.015;
const LEAD_RATIO: f32 = 1.5;
// The render loop consumes 10 ms audio blocks.
const SWITCH_BLOCKS: u16 = 18;
const NEUTRAL_BLOCKS: u16 = 75;

#[derive(Clone, Copy)]
pub enum Region {
    Host,
    Guest,
    Divider,
}

impl Region {
    pub fn from_path(path: &str) -> Option<Self> {
        match path {
            "speaker-split/host-camera" => Some(Self::Host),
            "speaker-split/guest-camera" => Some(Self::Guest),
            "speaker-split/divider" => Some(Self::Divider),
            _ => None,
        }
    }

    pub fn rect(self, share: f32, size: OutputSize, portrait: bool) -> [f32; 4] {
        // One centered, two-pixel seam. Both tiles extend to the canvas edge.
        let span = if portrait { size.height } else { size.width } as f32;
        let line = 2. / span;
        let near = share - line / 2.;
        let far = share + line / 2.;
        let (start, length) = match self {
            Self::Host => (0., near),
            Self::Divider => (near, line),
            Self::Guest => (far, 1. - far),
        };
        if portrait {
            [0., start, 1., length]
        } else {
            [start, 0., length, 1.]
        }
    }
}

pub fn rms(stereo: &[f32]) -> f32 {
    let energy = stereo.iter().map(|sample| sample * sample).sum::<f32>();
    (energy / stereo.len().max(1) as f32).sqrt()
}

#[derive(Clone, Copy, PartialEq)]
enum Side {
    Host,
    Guest,
}

pub struct Focus {
    envelope: [f32; 2],
    selected: Option<Side>,
    candidate: Option<Side>,
    held: u16,
    neutral: u16,
    share: f32,
}

impl Default for Focus {
    fn default() -> Self {
        Self {
            envelope: [0.; 2],
            selected: None,
            candidate: None,
            held: 0,
            neutral: 0,
            share: CENTER,
        }
    }
}

impl Focus {
    pub fn observe(&mut self, host: f32, staged_guest: Option<f32>) {
        let Some(guest) = staged_guest else {
            // Discard the previous speaker's timing as soon as they leave the stage.
            let share = self.share;
            *self = Self { share, ..Self::default() };
            return;
        };
        for (smooth, input) in self.envelope.iter_mut().zip([host, guest]) {
            let coefficient = if input > *smooth { 0.27 } else { 0.08 };
            *smooth += (input - *smooth) * coefficient;
        }
        let [host, guest] = self.envelope;
        let stronger = if host > VOICE_FLOOR && host > guest * LEAD_RATIO {
            Some(Side::Host)
        } else if guest > VOICE_FLOOR && guest > host * LEAD_RATIO {
            Some(Side::Guest)
        } else {
            None
        };
        if self.candidate != stronger {
            self.candidate = stronger;
            self.held = 0;
        }
        if let Some(side) = stronger {
            self.held = self.held.saturating_add(1);
            self.neutral = 0;
            if self.held >= SWITCH_BLOCKS {
                self.selected = Some(side);
            }
        } else {
            self.neutral = self.neutral.saturating_add(1);
            if self.neutral >= NEUTRAL_BLOCKS {
                self.selected = None;
            }
        }
    }

    pub fn advance(&mut self, seconds: f32) -> f32 {
        let target = match self.selected {
            Some(Side::Host) => FOCUS_SHARE,
            Some(Side::Guest) => 1. - FOCUS_SHARE,
            None => CENTER,
        };
        let weight = 1. - (-seconds.clamp(0., 0.2) / 0.12).exp();
        self.share += (target - self.share) * weight;
        self.share
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn play(focus: &mut Focus, host: f32, guest: Option<f32>, blocks: usize) -> f32 {
        let mut split = focus.share;
        for _ in 0..blocks {
            focus.observe(host, guest);
            split = focus.advance(0.01);
        }
        split
    }

    #[test]
    fn sustained_voice_moves_the_split_without_following_short_spikes() {
        let mut focus = Focus::default();
        assert_eq!(play(&mut focus, 0.2, None, 120), CENTER);
        assert!(play(&mut focus, 0.16, Some(0.01), 65) > 0.62);
        assert!(play(&mut focus, 0.0, Some(0.7), 8) > 0.62);
        assert!(play(&mut focus, 0.09, Some(0.28), 65) < 0.38);
        assert!(play(&mut focus, 0.14, Some(0.14), 30) < 0.43);
        assert!((play(&mut focus, 0.14, Some(0.14), 135) - CENTER).abs() < 0.001);
        assert!(play(&mut focus, 0.13, Some(0.1), 120) < 0.501);
    }

    #[test]
    fn silence_and_guest_departure_return_to_center() {
        let mut focus = Focus::default();
        assert!(play(&mut focus, 0.0, Some(0.24), 65) < 0.38);
        assert!(play(&mut focus, 0., Some(0.), 30) < 0.39);
        assert!((play(&mut focus, 0., Some(0.), 140) - CENTER).abs() < 0.001);
        assert!(play(&mut focus, 0.0, Some(0.5), 65) < 0.38);
        assert!((play(&mut focus, 0.5, None, 90) - CENTER).abs() < 0.001);
    }

    #[test]
    fn both_orientations_use_the_full_canvas_and_one_two_pixel_divider() {
        for (size, portrait, axis, span) in [
            (OutputSize::LANDSCAPE, false, 0, OutputSize::LANDSCAPE.width),
            (OutputSize::VERTICAL, true, 1, OutputSize::VERTICAL.height),
        ] {
            for share in [1. - FOCUS_SHARE, CENTER, FOCUS_SHARE] {
                let host = Region::Host.rect(share, size, portrait);
                let divider = Region::Divider.rect(share, size, portrait);
                let guest = Region::Guest.rect(share, size, portrait);
                assert_eq!(host[axis], 0.);
                assert_eq!(host[axis + 2], divider[axis]);
                assert!((divider[axis] + divider[axis + 2] - guest[axis]).abs() < 1e-6);
                assert_eq!(guest[axis] + guest[axis + 2], 1.);
                assert!((divider[axis + 2] * span as f32 - 2.).abs() < 1e-6);
                assert!([host, divider, guest].iter().all(|r| r[1 - axis] == 0. && r[3 - axis] == 1.));
            }
        }
    }
}
