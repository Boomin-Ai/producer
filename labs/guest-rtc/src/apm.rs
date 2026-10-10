//! Manual processing spike. A production adapter must supply final speaker PCM.
use anyhow::{bail, Result};
use livekit::webrtc::native::apm::AudioProcessingModule;

pub struct Processor {
    apm: AudioProcessingModule,
    rate: i32,
    channels: i32,
}

impl Processor {
    pub fn new(enabled: bool, rate: i32, channels: i32) -> Result<Self> {
        if ![16000, 32000, 48000].contains(&rate) || ![1, 2].contains(&channels) {
            bail!("Unsupported APM rate/channel layout");
        }
        Ok(Self {
            apm: AudioProcessingModule::new(enabled, false, false, false),
            rate,
            channels,
        })
    }

    pub fn process(&mut self, speaker: &[i16], mic: &mut [i16], delay_ms: i32) -> Result<()> {
        let count = (self.rate / 100 * self.channels) as usize;
        if speaker.len() != count || mic.len() != count || !(0..=500).contains(&delay_ms) {
            bail!("APM requires one complete 10 ms speaker/microphone block and valid delay");
        }
        // The reverse API is mutable; preserve the actual speaker samples.
        self.reverse(speaker)?;
        self.capture(mic, delay_ms)
    }

    pub fn reverse(&mut self, speaker: &[i16]) -> Result<()> {
        let count = (self.rate / 100 * self.channels) as usize;
        if speaker.len() != count {
            bail!("APM reverse stream requires one complete 10 ms block");
        }
        let mut reference = speaker.to_vec();
        self.apm
            .process_reverse_stream(&mut reference, self.rate, self.channels)?;
        Ok(())
    }

    pub fn capture(&mut self, mic: &mut [i16], delay_ms: i32) -> Result<()> {
        let count = (self.rate / 100 * self.channels) as usize;
        if mic.len() != count || !(0..=500).contains(&delay_ms) {
            bail!("APM capture requires one complete 10 ms block and valid delay");
        }
        self.apm.set_stream_delay_ms(delay_ms)?;
        self.apm.process_stream(mic, self.rate, self.channels)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bad_external_pcm_is_rejected_before_native_assertions() {
        assert!(Processor::new(true, 0, 1).is_err());
        let mut p = Processor::new(true, 48000, 1).unwrap();
        assert!(p.reverse(&[0; 479]).is_err());
        assert!(p.capture(&mut [0; 479], 40).is_err());
        assert!(p.capture(&mut [0; 480], 501).is_err());
        assert!(p.process(&[0; 480], &mut [0; 479], 40).is_err());
        assert!(p.process(&[0; 480], &mut [0; 480], -1).is_err());
        p.process(&[0; 480], &mut [0; 480], 40).unwrap();
    }
}
