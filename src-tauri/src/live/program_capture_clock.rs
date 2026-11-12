use std::sync::atomic::{AtomicU64, Ordering};

pub fn video_frame_due(next: &AtomicU64, period: u64, timestamp: u64) -> bool {
    if period == 0 {
        return true;
    }
    let due = next.load(Ordering::Relaxed);
    // One millisecond tolerates the integer rounding of a 30 fps clock.
    if timestamp.saturating_add(1_000_000) < due {
        return false;
    }
    let following = if due == 0 || timestamp.saturating_sub(due) > period {
        timestamp.saturating_add(period)
    } else {
        due.saturating_add(period)
    };
    next.store(following, Ordering::Relaxed);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn appearance_video_cadence_follows_source_timestamps_without_rounding_loss() {
        for source_fps in [30u64, 60] {
            let next = AtomicU64::new(0);
            let accepted = (0..source_fps * 2)
                .filter(|frame| {
                    video_frame_due(
                        &next,
                        1_000_000_000 / 30,
                        1_000_000_000 + frame * 1_000_000_000 / source_fps,
                    )
                })
                .count();
            assert_eq!(accepted, 60, "source {source_fps}");
            // A long missing interval resumes from fresh frames, not a burst.
            assert!(video_frame_due(&next, 1_000_000_000 / 30, 10_000_000_000));
            assert!(!video_frame_due(&next, 1_000_000_000 / 30, 10_010_000_000));
        }
    }
}
