//! Preserve missing PCM positions as explicit silence, never compress them.
//! OBS smooths small timestamp holes; emitting contiguous sample blocks keeps
//! later media at its original sample-clock position. Loss remains reported.
use serde_json::{json, Value};
use std::time::{Duration, Instant};
#[derive(Default)]
pub struct Continuity {
    previous: Option<(u64, u64, Instant)>,
    silence_blocks: u64,
    gap_events: u64,
    unfilled_events: u64,
    max_gap_blocks: u64,
}
impl Continuity {
    pub fn submit(
        &mut self,
        generation: u64,
        sequence: u64,
        stamp: Instant,
        pcm: &[i16],
        channels: u32,
        mut write: impl FnMut(&[i16], u32, Instant),
    ) {
        if let Some((old, previous, at)) = self.previous.filter(|(old, _, _)| *old == generation) {
            let _ = old;
            let delta = sequence.checked_sub(previous);
            let time = stamp.checked_duration_since(at);
            match (delta, time) {
                (Some(delta), Some(time))
                    if delta > 1 && time.as_nanos() == u128::from(delta) * 10_000_000 =>
                {
                    let missing = delta - 1;
                    self.gap_events += 1;
                    self.max_gap_blocks = self.max_gap_blocks.max(missing);
                    if missing <= 12 {
                        // At most 120 ms, matching the existing presentation delay.
                        // These zeros do not conceal a lost numbered tone or replay old PCM.
                        let silence = [0_i16; 960];
                        for n in 1..delta {
                            write(
                                &silence[..480 * channels as usize],
                                channels,
                                at + Duration::from_millis(n * 10),
                            );
                            self.silence_blocks += 1;
                        }
                    } else {
                        self.unfilled_events += 1;
                    }
                }
                (Some(1), Some(time)) if time == Duration::from_millis(10) => {}
                _ => {
                    self.unfilled_events += 1;
                }
            }
        }
        write(pcm, channels, stamp);
        self.previous = Some((generation, sequence, stamp));
    }
    pub fn report(&self) -> Value {
        json!({"silence_gap_blocks":self.silence_blocks,"gap_events":self.gap_events,"unfilled_gap_or_reanchor_events":self.unfilled_events,"maximum_gap_blocks":self.max_gap_blocks,"maximum_fill_blocks":12,"missing_pcm_recovered":false})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_samples_become_silence_at_original_positions_without_retiming_voice() {
        let now = Instant::now();
        let mut c = Continuity::default();
        let mut blocks = Vec::new();
        c.submit(1, 1, now, &[7; 480], 1, |pcm, _, at| {
            blocks.push((pcm[0], at))
        });
        c.submit(
            1,
            4,
            now + Duration::from_millis(30),
            &[9; 480],
            1,
            |pcm, _, at| blocks.push((pcm[0], at)),
        );
        assert_eq!(
            blocks,
            vec![
                (7, now),
                (0, now + Duration::from_millis(10)),
                (0, now + Duration::from_millis(20)),
                (9, now + Duration::from_millis(30))
            ]
        );
        assert_eq!(c.report()["silence_gap_blocks"], 2);
    }
    #[test]
    fn epochs_stalls_and_non_sample_clock_resets_cannot_create_unbounded_or_old_padding() {
        let now = Instant::now();
        let mut c = Continuity::default();
        let mut count = 0;
        for epoch in 0..100 {
            c.submit(epoch, 1, now, &[1; 960], 2, |_, _, _| count += 1);
            c.submit(
                epoch,
                1000,
                now + Duration::from_millis(9990),
                &[1; 960],
                2,
                |_, _, _| count += 1,
            );
            c.submit(
                epoch,
                1002,
                now + Duration::from_millis(10009),
                &[1; 960],
                2,
                |_, _, _| count += 1,
            );
        }
        assert_eq!(count, 300);
        assert_eq!(c.report()["silence_gap_blocks"], 0);
        assert_eq!(c.report()["unfilled_gap_or_reanchor_events"], 200);
    }
}
