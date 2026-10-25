//! Standalone real libobs lifecycle proof for the exact app endpoint module.
//! No camera, microphone, network or speaker device is opened.
mod ffi {
    use std::ffi::{c_char, c_void};
    #[repr(C)]
    pub struct obs_source_t {
        _private: [u8; 0],
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
        pub fn os_gettime_ns() -> u64;
    }
}
#[path = "../src-tauri/src/live/rtc_ingest.rs"]
mod rtc_ingest;
use std::{
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[test]
fn repeated_create_replace_retire_rejects_old_delivery_and_releases_owners() {
    unsafe {
        assert!(ffi::obs_startup(
            c"en-US".as_ptr(),
            ptr::null(),
            ptr::null_mut()
        ));
        rtc_ingest::register_type();
    }
    let y = vec![128; 320 * 180];
    let u = vec![128; 160 * 90];
    let v = u.clone();
    let frame = || rtc_ingest::Video {
        planes: (&y, &u, &v),
        width: 320,
        height: 180,
        strides: (320, 160, 160),
    };
    for n in 0..20 {
        let id = format!("guest-{n}");
        let name = std::ffi::CString::new(id.clone()).unwrap();
        let source = unsafe {
            ffi::obs_source_create(
                c"producer_guest_ingest".as_ptr(),
                name.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        assert!(!source.is_null());
        let endpoint = unsafe { rtc_ingest::Endpoint::attach(&id, source).unwrap() };
        assert!(unsafe { rtc_ingest::Endpoint::attach(&id, source) }.is_err());
        let weak = Arc::downgrade(&endpoint);
        let old = endpoint.replace().unwrap();
        let now = unsafe { ffi::os_gettime_ns() };
        assert!(old.video(frame(), now));
        assert!(!old.video(frame(), now));
        assert!(!old.video(
            rtc_ingest::Video {
                planes: (&y[..12], &u, &v),
                width: 320,
                height: 180,
                strides: (320, 160, 160)
            },
            now + 1
        ));
        let current = endpoint.replace().unwrap();
        assert!(!old.video(frame(), now + 2));
        assert!(current.video(frame(), now + 2));
        // A concurrent old callback cannot cross removal: retirement waits for
        // an active OBS copy, and the retained endpoint becomes permanently inert.
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = std::thread::spawn(move || {
            let y = vec![128; 320 * 180];
            let u = vec![128; 160 * 90];
            while !stopped.load(Ordering::Acquire) {
                let stamp = unsafe { ffi::os_gettime_ns() };
                let _ = current.video(
                    rtc_ingest::Video {
                        planes: (&y, &u, &u),
                        width: 320,
                        height: 180,
                        strides: (320, 160, 160),
                    },
                    stamp,
                );
            }
            assert!(!current.video(
                rtc_ingest::Video {
                    planes: (&y, &u, &u),
                    width: 320,
                    height: 180,
                    strides: (320, 160, 160)
                },
                unsafe { ffi::os_gettime_ns() }
            ));
        });
        std::thread::sleep(Duration::from_millis(2));
        endpoint.retire();
        assert!(rtc_ingest::endpoint(&id).is_none());
        assert!(endpoint.replace().is_none());
        assert!(!old.audio(&[0; 480], 1, now + 3));
        stop.store(true, Ordering::Release);
        worker.join().unwrap();
        // The replacement at this same ID survives a late old retire.
        let replacement = unsafe { rtc_ingest::Endpoint::attach(&id, source).unwrap() };
        endpoint.retire();
        assert!(rtc_ingest::endpoint(&id).is_some());
        replacement.retire();
        drop(replacement);
        drop(old);
        drop(endpoint);
        assert!(weak.upgrade().is_none());
        unsafe {
            ffi::obs_source_release(source);
        }
    }
    assert!(unsafe { rtc_ingest::Endpoint::attach("missing", ptr::null_mut()) }.is_err());
    unsafe {
        ffi::obs_shutdown();
    }
}
