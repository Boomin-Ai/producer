//! Native scene endpoint for the opt-in RTC pilot. No credential or SDK owner
//! lives here. The graph owns registration; removal retires the endpoint before
//! releasing its OBS source. Held delivery handles then become inert.
use super::ffi;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
};

extern "C" {
    fn producer_guest_ingest_register();
    fn producer_guest_ingest_video(
        source: *mut ffi::obs_source_t,
        y: *const u8,
        y_len: usize,
        u: *const u8,
        u_len: usize,
        v: *const u8,
        v_len: usize,
        width: u32,
        height: u32,
        ys: u32,
        us: u32,
        vs: u32,
        timestamp: u64,
    ) -> bool;
    fn producer_guest_ingest_audio(
        source: *mut ffi::obs_source_t,
        pcm: *const i16,
        sample_count: usize,
        channels: u32,
        timestamp: u64,
    ) -> bool;
}
static SOURCES: OnceLock<Mutex<HashMap<String, Weak<Endpoint>>>> = OnceLock::new();
fn sources() -> &'static Mutex<HashMap<String, Weak<Endpoint>>> {
    SOURCES.get_or_init(|| Mutex::new(HashMap::new()))
}
pub unsafe fn register_type() {
    producer_guest_ingest_register();
}

struct State {
    /// Owned reference. Protected by the same gate used for every delivery.
    source: Option<usize>,
    epoch: u64,
    video_timestamp: u64,
    audio_timestamp: u64,
}
pub struct Endpoint {
    id: String,
    state: Mutex<State>,
}
pub struct Delivery {
    endpoint: Arc<Endpoint>,
    epoch: u64,
}
pub struct Video<'a> {
    pub planes: (&'a [u8], &'a [u8], &'a [u8]),
    pub width: u32,
    pub height: u32,
    pub strides: (u32, u32, u32),
}

impl Endpoint {
    /// Engine thread only, after source creation and before exposing the item.
    pub unsafe fn attach(id: &str, source: *mut ffi::obs_source_t) -> Result<Arc<Self>, String> {
        if source.is_null() {
            return Err("Native guest source unavailable".into());
        }
        let mut registry = sources()
            .lock()
            .map_err(|_| "Native guest registry unavailable")?;
        if registry.get(id).is_some_and(|weak| weak.strong_count() > 0) {
            return Err("Native guest source already registered".into());
        }
        let owned = ffi::obs_source_get_ref(source);
        if owned.is_null() {
            return Err("Native guest reference unavailable".into());
        }
        let endpoint = Arc::new(Self {
            id: id.into(),
            state: Mutex::new(State {
                source: Some(owned as usize),
                epoch: 1,
                video_timestamp: 0,
                audio_timestamp: 0,
            }),
        });
        registry.insert(id.into(), Arc::downgrade(&endpoint));
        Ok(endpoint)
    }
    /// Replacing a publication clears buffered pixels and invalidates every
    /// old producer handle. SDK observer owners still have to unregister/join.
    pub fn replace(self: &Arc<Self>) -> Option<Delivery> {
        let mut state = self.state.lock().ok()?;
        let source = state.source?;
        state.epoch = state.epoch.checked_add(1)?;
        state.video_timestamp = 0;
        state.audio_timestamp = 0;
        unsafe {
            ffi::obs_source_output_video(source as *mut ffi::obs_source_t, std::ptr::null());
        }
        Some(Delivery {
            endpoint: self.clone(),
            epoch: state.epoch,
        })
    }
    /// Wait for an in-flight synchronous OBS copy before releasing the owned
    /// reference. Afterwards neither old nor current handles can submit media.
    pub fn retire(&self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(source) = state.source.take() {
                unsafe {
                    ffi::obs_source_output_video(
                        source as *mut ffi::obs_source_t,
                        std::ptr::null(),
                    );
                    ffi::obs_source_release(source as *mut ffi::obs_source_t);
                }
            }
        }
        if let Ok(mut registry) = sources().lock() {
            // A late old endpoint cannot unregister a replacement at the same ID.
            if registry
                .get(&self.id)
                .is_some_and(|weak| std::ptr::eq(weak.as_ptr(), self))
            {
                registry.remove(&self.id);
            }
        }
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        self.retire();
    }
}

/// Only native transport obtains this handle. It must independently bind the
/// participant/run/generation before calling replace; a scene ID is no permit.
pub fn endpoint(id: &str) -> Option<Arc<Endpoint>> {
    sources().lock().ok()?.get(id)?.upgrade()
}
impl Delivery {
    /// Timestamp is a scheduled OBS monotonic timestamp from the shared AV
    /// clock. This boundary never substitutes callback arrival for sender time.
    pub fn video(&self, frame: Video<'_>, timestamp: u64) -> bool {
        let Ok(mut state) = self.endpoint.state.try_lock() else {
            return false;
        };
        let Some(source) = state.source.filter(|_| state.epoch == self.epoch) else {
            return false;
        };
        if timestamp == 0 || timestamp <= state.video_timestamp {
            return false;
        }
        let (y, u, v) = frame.planes;
        let (ys, us, vs) = frame.strides;
        let accepted = unsafe {
            producer_guest_ingest_video(
                source as *mut ffi::obs_source_t,
                y.as_ptr(),
                y.len(),
                u.as_ptr(),
                u.len(),
                v.as_ptr(),
                v.len(),
                frame.width,
                frame.height,
                ys,
                us,
                vs,
                timestamp,
            )
        };
        if accepted {
            state.video_timestamp = timestamp;
        }
        accepted
    }
    pub fn audio(&self, pcm: &[i16], channels: u32, timestamp: u64) -> bool {
        let Ok(mut state) = self.endpoint.state.try_lock() else {
            return false;
        };
        let Some(source) = state.source.filter(|_| state.epoch == self.epoch) else {
            return false;
        };
        if timestamp == 0 || timestamp <= state.audio_timestamp {
            return false;
        }
        let accepted = unsafe {
            producer_guest_ingest_audio(
                source as *mut ffi::obs_source_t,
                pcm.as_ptr(),
                pcm.len(),
                channels,
                timestamp,
            )
        };
        if accepted {
            state.audio_timestamp = timestamp;
        }
        accepted
    }
}
