//! Finish an already-admitted video tail without accepting more video or
//! keeping live input open indefinitely. All times are local presentation time.
use std::time::{Duration, Instant};

pub const BUDGET: Duration = Duration::from_millis(450);
pub struct Tail {
    pub began: Instant,
    pub horizon: Option<Instant>,
    complete: bool,
    pub admitted_audio_blocks: u64,
    pub beyond_horizon_audio_blocks: u64,
}
impl Tail {
    pub fn new(began: Instant, last_video: Option<Instant>, audio_end: Option<Instant>) -> Self {
        // Preserve one 30 fps frame interval beyond the final video timestamp.
        let horizon = last_video.and_then(|v| v.checked_add(Duration::from_micros(33_334)));
        let complete = horizon.is_none_or(|h| audio_end.is_some_and(|a| a >= h));
        Self {
            began,
            horizon,
            complete,
            admitted_audio_blocks: 0,
            beyond_horizon_audio_blocks: 0,
        }
    }
    pub fn allows(&mut self, stamp: Instant, now: Instant) -> bool {
        if self.complete || self.expired(now) || self.horizon.is_none_or(|h| stamp >= h) {
            self.beyond_horizon_audio_blocks += 1;
            return false;
        }
        true
    }
    pub fn submitted(&mut self, stamp: Instant) {
        // A rejected output enqueue or a future block is not completion proof.
        self.admitted_audio_blocks += 1;
        self.complete = self.horizon.is_none_or(|h| {
            stamp
                .checked_add(Duration::from_millis(10))
                .is_some_and(|end| end >= h)
        });
    }
    pub fn done(&self) -> bool {
        self.complete
    }
    pub fn expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.began) >= BUDGET
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finishes_audio_through_final_video_and_rejects_future_input() {
        let start = Instant::now();
        let video = start + Duration::from_millis(100);
        let mut tail = Tail::new(start, Some(video), Some(start));
        let audio = start + Duration::from_millis(120);
        assert!(tail.allows(audio, start));
        tail.submitted(audio);
        assert!(!tail.done());
        let audio = start + Duration::from_millis(130);
        assert!(tail.allows(audio, start));
        tail.submitted(audio);
        assert!(tail.done());
        assert!(!tail.allows(start + Duration::from_millis(150), start));
        assert_eq!(tail.admitted_audio_blocks, 2);
    }
    #[test]
    fn missing_audio_cannot_extend_the_finish_budget() {
        let start = Instant::now();
        let mut tail = Tail::new(start, Some(start + Duration::from_millis(300)), None);
        assert!(!tail.done());
        assert!(!tail.expired(start + Duration::from_millis(449)));
        assert!(tail.expired(start + Duration::from_millis(450)));
        assert!(!tail.allows(start, start + Duration::from_millis(450)));
    }
    #[test]
    fn rejected_last_block_and_future_input_cannot_claim_completion() {
        let start = Instant::now();
        let mut tail = Tail::new(start, Some(start), None);
        assert!(tail.allows(start + Duration::from_millis(30), start));
        // Simulated full output queue: no successful submission.
        assert!(!tail.allows(start + Duration::from_millis(40), start));
        assert!(!tail.done());
        assert_eq!(tail.admitted_audio_blocks, 0);
    }
    #[test]
    fn no_video_or_already_complete_audio_needs_no_extra_capture() {
        let start = Instant::now();
        assert!(Tail::new(start, None, None).done());
        assert!(Tail::new(start, Some(start), Some(start + Duration::from_millis(40))).done());
    }
}
