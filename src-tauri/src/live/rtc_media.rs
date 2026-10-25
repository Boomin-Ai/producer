//! Graph endpoints synchronously copy qualified, scheduled SDK media into OBS.
//! The graph still owns scene visibility, mixer routing and source lifetime.
use super::rtc_ingest;
use producer_guest_runtime::media::{Output, Outputs, Receiver, Video};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
extern "C" {
    fn os_gettime_ns() -> u64;
}
pub struct SceneOutputs {
    clock: (Instant, u64),
}
impl SceneOutputs {
    pub fn new() -> Self {
        Self {
            clock: (Instant::now(), unsafe { os_gettime_ns() }),
        }
    }
    pub fn receiver() -> Result<Receiver, &'static str> {
        Receiver::new(Arc::new(Self::new()))
    }
}
struct SceneOutput {
    endpoint: Arc<rtc_ingest::Endpoint>,
    delivery: Mutex<Option<rtc_ingest::Delivery>>,
    clock: (Instant, u64),
}
impl SceneOutput {
    fn timestamp(&self, at: Instant) -> Option<u64> {
        if at >= self.clock.0 {
            self.clock
                .1
                .checked_add(u64::try_from(at.duration_since(self.clock.0).as_nanos()).ok()?)
        } else {
            self.clock
                .1
                .checked_sub(u64::try_from(self.clock.0.duration_since(at).as_nanos()).ok()?)
        }
    }
}
impl Output for SceneOutput {
    fn video(&self, frame: Video<'_>, at: Instant) -> bool {
        let Some(timestamp) = self.timestamp(at) else {
            return false;
        };
        self.delivery.lock().is_ok_and(|d| {
            d.as_ref().is_some_and(|d| {
                d.video(
                    rtc_ingest::Video {
                        planes: frame.planes,
                        width: frame.width,
                        height: frame.height,
                        strides: frame.strides,
                    },
                    timestamp,
                )
            })
        })
    }
    fn audio(&self, samples: &[i16], channels: u32, at: Instant) -> bool {
        let Some(timestamp) = self.timestamp(at) else {
            return false;
        };
        self.delivery.lock().is_ok_and(|d| {
            d.as_ref()
                .is_some_and(|d| d.audio(samples, channels, timestamp))
        })
    }
    fn invalidate(&self) {
        if let Ok(mut delivery) = self.delivery.lock() {
            let active = delivery.take().is_some();
            // Fence older callbacks and remove their displayed pixels. Do not
            // release the graph's source or modify the user's mixer settings.
            if active {
                self.endpoint.replace();
            }
        }
    }
}
impl Drop for SceneOutput {
    fn drop(&mut self) {
        self.invalidate();
    }
}
impl Outputs for SceneOutputs {
    fn available(&self, id: &str) -> bool {
        rtc_ingest::endpoint(id).is_some()
    }
    fn open(&self, id: &str) -> Option<Arc<dyn Output>> {
        let endpoint = rtc_ingest::endpoint(id)?;
        let delivery = endpoint.replace()?;
        Some(Arc::new(SceneOutput {
            endpoint,
            delivery: Mutex::new(Some(delivery)),
            clock: self.clock,
        }))
    }
}
