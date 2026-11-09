//! Private return playback. Sources never enter the scene, roster, or any
//! output bus. Their engine owner retires them after SDK deliveries have joined.
use super::{ffi, rtc_ingest};
#[path = "appearance_preview.rs"]
mod preview;
use preview::PreviewLane;
use producer_guest_runtime::media::{Output, Outputs, Video};
use std::{
    collections::HashMap,
    ffi::CString,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::Instant,
};

#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    fn os_gettime_ns() -> u64;
}
const SLOTS: usize = 26;
struct Slot {
    source: usize,
    endpoint: Arc<rtc_ingest::Endpoint>,
}
struct Bindings {
    ids: HashMap<String, (usize, u64)>,
    generation: u64,
    host: Option<String>,
}
pub struct AppearanceOutputs {
    myself: Weak<AppearanceOutputs>,
    slots: Vec<Slot>,
    bindings: Mutex<Bindings>,
    playback: AtomicBool,
    playback_stopped: AtomicBool,
    playback_gate: Mutex<()>,
    retired: AtomicBool,
    preview: PreviewLane,
    clock: (Instant, u64),
    video: AtomicU64,
    audio: AtomicU64,
    last_video: AtomicU64,
    last_audio: AtomicU64,
}
impl AppearanceOutputs {
    /// Engine thread only. Keep the returned Arc in its engine lease until
    /// `retire` has run on that same thread after receiver retirement.
    pub unsafe fn create(appearance_id: &str) -> Result<Arc<Self>, String> {
        uuid::Uuid::parse_str(appearance_id).map_err(|_| "Invalid appearance ID")?;
        let preview = PreviewLane::new()?;
        let mut slots: Vec<Slot> = Vec::with_capacity(SLOTS);
        for index in 0..SLOTS {
            let id = format!("appearance-{appearance_id}-{index}");
            let name = CString::new(id.clone()).map_err(|_| "Invalid appearance source")?;
            let source = ffi::obs_source_create_private(
                b"producer_guest_ingest\0".as_ptr().cast(),
                name.as_ptr(),
                std::ptr::null_mut(),
            );
            if source.is_null() {
                for slot in slots {
                    slot.endpoint.retire();
                    ffi::obs_source_dec_active(slot.source as *mut _);
                    ffi::obs_source_release(slot.source as *mut _);
                }
                return Err("Native appearance return source unavailable".into());
            }
            let endpoint = match rtc_ingest::Endpoint::attach(&id, source) {
                Ok(endpoint) => endpoint,
                Err(error) => {
                    ffi::obs_source_release(source);
                    for slot in slots {
                        slot.endpoint.retire();
                        ffi::obs_source_dec_active(slot.source as *mut _);
                        ffi::obs_source_release(slot.source as *mut _);
                    }
                    return Err(error);
                }
            };
            ffi::obs_source_set_audio_mixers(source, 0);
            ffi::obs_source_set_monitoring_type(source, 1); // MONITOR_ONLY
            ffi::obs_source_set_muted(source, false);
            ffi::obs_source_inc_active(source);
            slots.push(Slot {
                source: source as usize,
                endpoint,
            });
        }
        Ok(Arc::new_cyclic(|myself| Self {
            myself: myself.clone(),
            slots,
            bindings: Mutex::new(Bindings {
                ids: HashMap::new(),
                generation: 0,
                host: None,
            }),
            playback: AtomicBool::new(false),
            playback_stopped: AtomicBool::new(false),
            playback_gate: Mutex::new(()),
            retired: AtomicBool::new(false),
            preview,
            clock: (Instant::now(), os_gettime_ns()),
            video: AtomicU64::new(0),
            audio: AtomicU64::new(0),
            last_video: AtomicU64::new(0),
            last_audio: AtomicU64::new(0),
        }))
    }
    pub fn set_host(&self, participant_id: &str) {
        if let Ok(mut bindings) = self.bindings.lock() {
            bindings.host = Some(format!("guest-{participant_id}"));
        }
    }
    pub fn set_playback(&self, on: bool) {
        let Ok(_gate) = self.playback_gate.lock() else {
            return;
        };
        let on = on && !self.playback_stopped.load(Ordering::Acquire);
        let previous = self.playback.swap(on, Ordering::AcqRel);
        if previous && !on {
            for slot in &self.slots {
                slot.endpoint.clear_audio();
            }
        }
    }
    /// An old owner or late control cannot restore playback after Stop.
    pub fn stop_playback(&self) {
        let Ok(_gate) = self.playback_gate.lock() else {
            return;
        };
        self.playback_stopped.store(true, Ordering::Release);
        self.playback.store(false, Ordering::Release);
        for slot in &self.slots {
            slot.endpoint.clear_audio();
        }
    }
    pub fn preview(&self) -> Vec<u8> {
        self.preview.image()
    }
    pub fn counts(&self) -> (u64, u64) {
        (
            self.video.load(Ordering::Acquire),
            self.audio.load(Ordering::Acquire),
        )
    }
    pub fn fresh(&self) -> (bool, bool) {
        let now = unsafe { os_gettime_ns() };
        let recent = |at: u64| at != 0 && now.saturating_sub(at) < 1_000_000_000;
        (
            recent(self.last_video.load(Ordering::Acquire)),
            recent(self.last_audio.load(Ordering::Acquire)),
        )
    }
    pub fn clear(&self) {
        for slot in &self.slots {
            slot.endpoint.replace();
        }
        self.preview.clear();
        self.video.store(0, Ordering::Release);
        self.audio.store(0, Ordering::Release);
        self.last_video.store(0, Ordering::Release);
        self.last_audio.store(0, Ordering::Release);
    }
    /// Engine-thread only, once all native receive observers and deliveries joined.
    pub unsafe fn retire(&self) {
        if self.retired.swap(true, Ordering::AcqRel) {
            return;
        }
        self.stop_playback();
        self.preview.close();
        for slot in &self.slots {
            slot.endpoint.retire();
            ffi::obs_source_dec_active(slot.source as *mut _);
            ffi::obs_source_release(slot.source as *mut _);
        }
    }
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

struct ReturnOutput {
    owner: Arc<AppearanceOutputs>,
    id: String,
    index: usize,
    generation: u64,
    host: bool,
    delivery: Mutex<Option<rtc_ingest::Delivery>>,
}
impl Output for ReturnOutput {
    fn video(&self, frame: Video<'_>, at: Instant) -> bool {
        if !self.host || self.owner.retired.load(Ordering::Acquire) {
            return false;
        }
        let Some(timestamp) = self.owner.timestamp(at) else {
            return false;
        };
        let delivered = self.delivery.lock().is_ok_and(|d| {
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
        });
        if delivered {
            self.owner.video.fetch_add(1, Ordering::Relaxed);
            self.owner
                .last_video
                .store(unsafe { os_gettime_ns() }, Ordering::Release);
            self.owner.preview.offer(&frame);
        }
        delivered
    }
    fn audio(&self, samples: &[i16], channels: u32, at: Instant) -> bool {
        if self.owner.retired.load(Ordering::Acquire) {
            return false;
        }
        let Ok(_gate) = self.owner.playback_gate.lock() else {
            return false;
        };
        self.owner.audio.fetch_add(1, Ordering::Relaxed);
        self.owner
            .last_audio
            .store(unsafe { os_gettime_ns() }, Ordering::Release);
        if !self.owner.playback.load(Ordering::Acquire) {
            return true;
        }
        let Some(timestamp) = self.owner.timestamp(at) else {
            return false;
        };
        self.delivery.lock().is_ok_and(|d| {
            d.as_ref()
                .is_some_and(|d| d.audio(samples, channels, timestamp))
        })
    }
    fn invalidate(&self) {
        if let Ok(mut delivery) = self.delivery.lock() {
            if delivery.take().is_some() {
                if let Ok(bindings) = self.owner.bindings.lock() {
                    if bindings.ids.get(&self.id) == Some(&(self.index, self.generation)) {
                        self.owner.slots[self.index].endpoint.replace();
                    }
                }
                if self.host {
                    self.owner.preview.clear();
                }
                if self.host {
                    self.owner.last_video.store(0, Ordering::Release);
                    self.owner.last_audio.store(0, Ordering::Release);
                }
            }
        }
    }
}
impl Drop for ReturnOutput {
    fn drop(&mut self) {
        self.invalidate();
        if let Ok(mut bindings) = self.owner.bindings.lock() {
            if bindings.ids.get(&self.id) == Some(&(self.index, self.generation)) {
                bindings.ids.remove(&self.id);
            }
        }
    }
}
impl Outputs for AppearanceOutputs {
    fn available(&self, id: &str) -> bool {
        !self.retired.load(Ordering::Acquire)
            && id
                .strip_prefix("guest-")
                .is_some_and(|v| uuid::Uuid::parse_str(v).is_ok())
            && self
                .bindings
                .lock()
                .is_ok_and(|b| b.ids.contains_key(id) || b.ids.len() < SLOTS)
    }
    fn open(&self, id: &str) -> Option<Arc<dyn Output>> {
        if !self.available(id) {
            return None;
        }
        let mut bindings = self.bindings.lock().ok()?;
        let host = bindings.host.as_deref() == Some(id);
        let index = bindings.ids.get(id).map(|v| v.0).or_else(|| {
            if host {
                Some(0)
            } else {
                (1..SLOTS).find(|i| !bindings.ids.values().any(|v| v.0 == *i))
            }
        })?;
        bindings.generation = bindings.generation.checked_add(1)?;
        let generation = bindings.generation;
        bindings.ids.insert(id.into(), (index, generation));
        let delivery = self.slots[index].endpoint.replace()?;
        Some(Arc::new(ReturnOutput {
            owner: self.myself.upgrade()?,
            id: id.into(),
            index,
            generation,
            host,
            delivery: Mutex::new(Some(delivery)),
        }))
    }
}
