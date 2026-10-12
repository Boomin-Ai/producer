//! Disposable OBS source registry for the hosted receive proof. Production
//! obtains existing endpoints from its scene graph and never creates them here.
use producer_guest_runtime::media::{Output, Outputs};
use std::{
    collections::HashMap,
    ptr,
    sync::{Arc, Mutex},
};
mod ffi {
    use std::ffi::{c_char, c_void};
    #[repr(C)]
    pub struct obs_source_t {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct AudioInfo {
        pub rate: u32,
        pub speakers: i32,
    }
    extern "C" {
        pub fn obs_source_get_ref(source: *mut obs_source_t) -> *mut obs_source_t;
        pub fn obs_source_release(source: *mut obs_source_t);
        pub fn obs_source_output_video(source: *mut obs_source_t, frame: *const c_void);
        pub fn obs_source_create(
            id: *const c_char,
            name: *const c_char,
            settings: *mut c_void,
            hotkeys: *mut c_void,
        ) -> *mut obs_source_t;
        pub fn obs_startup(
            locale: *const c_char,
            module_config: *const c_char,
            store: *mut c_void,
        ) -> bool;
        pub fn obs_shutdown();
        pub fn obs_reset_audio(info: *const AudioInfo) -> bool;
    }
}
#[path = "../../../../src-tauri/src/live/rtc_ingest.rs"]
mod rtc_ingest;
#[path = "../../../../src-tauri/src/live/rtc_media.rs"]
mod rtc_media;
pub struct Scenes {
    endpoints: Mutex<HashMap<String, Arc<rtc_ingest::Endpoint>>>,
    outputs: rtc_media::SceneOutputs,
}
impl Scenes {
    pub fn start() -> Result<Self, &'static str> {
        unsafe {
            if !ffi::obs_startup(c"en-US".as_ptr(), ptr::null(), ptr::null_mut()) {
                return Err("OBS proof initialization failed");
            }
            if !ffi::obs_reset_audio(&ffi::AudioInfo {
                rate: 48000,
                speakers: 2,
            }) {
                ffi::obs_shutdown();
                return Err("OBS proof audio initialization failed");
            }
            rtc_ingest::register_type();
        }
        Ok(Self {
            endpoints: Mutex::new(HashMap::new()),
            outputs: rtc_media::SceneOutputs::new(),
        })
    }
}
impl Outputs for Scenes {
    fn available(&self, id: &str) -> bool {
        let Ok(mut endpoints) = self.endpoints.lock() else {
            return false;
        };
        if endpoints.contains_key(id) {
            return true;
        }
        if endpoints.len() >= 25 {
            return false;
        }
        let Ok(name) = std::ffi::CString::new(id) else {
            return false;
        };
        unsafe {
            let source = ffi::obs_source_create(
                c"producer_guest_ingest".as_ptr(),
                name.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
            );
            if source.is_null() {
                return false;
            }
            let endpoint = rtc_ingest::Endpoint::attach(id, source);
            ffi::obs_source_release(source);
            if let Ok(endpoint) = endpoint {
                endpoints.insert(id.into(), endpoint);
                true
            } else {
                false
            }
        }
    }
    fn open(&self, id: &str) -> Option<Arc<dyn Output>> {
        self.outputs.open(id)
    }
}
impl Drop for Scenes {
    fn drop(&mut self) {
        self.endpoints.get_mut().unwrap().clear();
        unsafe {
            ffi::obs_shutdown();
        }
    }
}
