//! Generated-fixture diagnostics before the application queue. No retained frames.
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

const CAPACITY: usize = 256;
#[derive(Clone, Copy)]
struct Receipt {
    label: u8,
    received_us: i64,
    packet_capture_ntp_us: i64,
}
struct State {
    frames: u64,
    last_us: Option<i64>,
    max_gap_us: i64,
    active: bool,
    receipts: Vec<Receipt>,
    overflow: u64,
}
pub struct Trace {
    state: Mutex<State>,
    contention: AtomicU64,
}
impl Trace {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                frames: 0,
                last_us: None,
                max_gap_us: 0,
                active: false,
                receipts: Vec::with_capacity(CAPACITY),
                overflow: 0,
            }),
            contention: AtomicU64::new(0),
        }
    }
    // Callback diagnostics never wait behind a reporting thread.
    pub fn observe(&self, label: Option<u8>, received_us: i64, packet_capture_ntp_us: i64) {
        let Ok(mut state) = self.state.try_lock() else {
            self.contention.fetch_add(1, Ordering::Relaxed);
            return;
        };
        state.frames += 1;
        if let Some(last) = state.last_us {
            state.max_gap_us = state.max_gap_us.max(received_us.saturating_sub(last));
        }
        state.last_us = Some(received_us);
        if let Some(label) = label.filter(|_| !state.active) {
            if state.receipts.len() < CAPACITY {
                state.receipts.push(Receipt {
                    label,
                    received_us,
                    packet_capture_ntp_us,
                });
            } else {
                state.overflow += 1;
            }
        }
        state.active = label.is_some();
    }
    pub fn report(&self) -> Value {
        let state = self.state.lock().unwrap();
        let receipts: Vec<_> = state
            .receipts
            .iter()
            .map(|r| {
                json!({"label":r.label,
            "received_us":r.received_us,"packet_capture_ntp_us":r.packet_capture_ntp_us})
            })
            .collect();
        json!({"frames_observed":state.frames,"max_callback_gap_us":state.max_gap_us,
            "receipts":receipts,"capacity":CAPACITY,"overflow":state.overflow,
            "contention":self.contention.load(Ordering::Relaxed),
            "scope":"Generated 320x180 frames at the SDK sink, before the application queue. Capture NTP is raw metadata, not mapped to local callback time."})
    }
}

// Fixture pulses paint white below the 16-pixel binary label strip. Sampling
// four interior pixels avoids a full-frame scan; this is not a camera detector.
pub fn pulse_label(luma: &[u8], width: u32, height: u32, stride: u32) -> Option<u8> {
    if width != 320 || height != 180 || stride < width {
        return None;
    }
    for (x, y) in [(80, 60), (240, 60), (80, 140), (240, 140)] {
        if *luma.get(y * stride as usize + x)? <= 180 {
            return None;
        }
    }
    let mut label = 0;
    for bit in 0..8 {
        if *luma.get(8 * stride as usize + bit * 40 + 20)? > 180 {
            label |= 1 << bit;
        }
    }
    Some(label)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifies_fixture_pulses_with_padding_and_rejects_partial_buffers() {
        let mut y = vec![235; 336 * 180];
        for bit in 0..8 {
            y[8 * 336 + bit * 40 + 20] = if 133 & (1 << bit) != 0 { 235 } else { 16 };
        }
        assert_eq!(pulse_label(&y, 320, 180, 336), Some(133));
        assert_eq!(pulse_label(&y[..100], 320, 180, 336), None);
        assert_eq!(pulse_label(&y, 640, 180, 336), None);
        y[60 * 336 + 80] = 16;
        assert_eq!(pulse_label(&y, 320, 180, 336), None);
    }
    #[test]
    fn bounds_receipts_and_never_blocks_a_callback() {
        let trace = Trace::new();
        for n in 0..300 {
            trace.observe(None, n * 1000, 0);
            trace.observe(Some((n % 256) as u8), n * 1000 + 500, 9000 + n);
        }
        let guard = trace.state.lock().unwrap();
        trace.observe(Some(42), 400000, 0);
        drop(guard);
        let report = trace.report();
        assert_eq!(report["receipts"].as_array().unwrap().len(), 256);
        assert_eq!(report["overflow"], 44);
        assert_eq!(report["contention"], 1);
        assert_eq!(report["max_callback_gap_us"], 500);
    }
}
