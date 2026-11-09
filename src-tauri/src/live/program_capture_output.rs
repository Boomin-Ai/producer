//! Raw output bound to an explicit engine mix. Unlike the main raw-video
//! callback, this activates only the selected room/portrait video_t.
use super::{ffi, video_callback, CaptureTarget, Shared, VideoScale};
use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[repr(C)]
struct OutputInfo {
    id: *const std::ffi::c_char,
    flags: u32,
    name: Option<extern "C" fn(*mut c_void) -> *const std::ffi::c_char>,
    create: Option<extern "C" fn(*mut ffi::obs_data_t, *mut ffi::obs_output_t) -> *mut c_void>,
    destroy: Option<extern "C" fn(*mut c_void)>,
    start: Option<extern "C" fn(*mut c_void) -> bool>,
    stop: Option<extern "C" fn(*mut c_void, u64)>,
    raw_video: Option<extern "C" fn(*mut c_void, *mut ffi::video_data)>,
    optional: [usize; 16],
}

#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    fn obs_register_output_s(info: *const OutputInfo, size: usize);
    fn obs_output_begin_data_capture(output: *mut ffi::obs_output_t, flags: u32) -> bool;
    fn obs_output_end_data_capture(output: *mut ffi::obs_output_t);
    fn obs_output_set_video_conversion(output: *mut ffi::obs_output_t, scale: *const VideoScale);
}
struct Capture {
    output: *mut ffi::obs_output_t,
    param: *mut c_void,
    capturing: AtomicBool,
    // External OBS references may defer output destruction after our release.
    // Keep callback userdata and its native mix alive until destroy runs.
    _shared: Option<Arc<Shared>>,
    _target: Option<CaptureTarget>,
}
extern "C" fn name(_: *mut c_void) -> *const std::ffi::c_char {
    b"Producer native appearance capture\0".as_ptr().cast()
}
extern "C" fn create(_: *mut ffi::obs_data_t, output: *mut ffi::obs_output_t) -> *mut c_void {
    Box::into_raw(Box::new(Capture {
        output,
        param: std::ptr::null_mut(),
        capturing: AtomicBool::new(false),
        _shared: None,
        _target: None,
    }))
    .cast()
}
extern "C" fn destroy(data: *mut c_void) {
    unsafe {
        drop(Box::from_raw(data as *mut Capture));
    }
}
extern "C" fn start(data: *mut c_void) -> bool {
    let capture = unsafe { &*(data as *const Capture) };
    let started = unsafe { obs_output_begin_data_capture(capture.output, 0) };
    capture.capturing.store(started, Ordering::Release);
    started
}
extern "C" fn stop(data: *mut c_void, _: u64) {
    let capture = unsafe { &*(data as *const Capture) };
    if capture.capturing.swap(false, Ordering::AcqRel) {
        unsafe {
            obs_output_end_data_capture(capture.output);
        }
    }
}
extern "C" fn frame(data: *mut c_void, video: *mut ffi::video_data) {
    let capture = unsafe { &*(data as *const Capture) };
    if !capture.param.is_null() {
        video_callback(capture.param, video);
    }
}

pub(super) struct Output(usize);
impl Output {
    pub(super) unsafe fn start(
        video: usize,
        scale: &VideoScale,
        shared: Arc<Shared>,
        target: CaptureTarget,
    ) -> Result<Self, &'static str> {
        static REGISTER: std::sync::Once = std::sync::Once::new();
        REGISTER.call_once(|| {
            let info = OutputInfo {
                id: b"producer_native_appearance_capture\0".as_ptr().cast(),
                flags: 1,
                name: Some(name),
                create: Some(create),
                destroy: Some(destroy),
                start: Some(start),
                stop: Some(stop),
                raw_video: Some(frame),
                optional: [0; 16],
            };
            obs_register_output_s(&info, std::mem::size_of::<OutputInfo>());
        });
        let output = ffi::obs_output_create(
            b"producer_native_appearance_capture\0".as_ptr().cast(),
            b"Native appearance capture\0".as_ptr().cast(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if output.is_null() {
            return Err("Native appearance capture output is unavailable");
        }
        let guard = Self(output as usize);
        let capture = ffi::obs_obj_get_data(output.cast()) as *mut Capture;
        if capture.is_null() {
            return Err("Native appearance capture state is unavailable");
        }
        (*capture).param = Arc::as_ptr(&shared).cast_mut().cast();
        (*capture)._shared = Some(shared);
        (*capture)._target = Some(target);
        ffi::obs_output_set_media(output, video as *mut ffi::video_t, std::ptr::null_mut());
        obs_output_set_video_conversion(output, scale);
        if !ffi::obs_output_start(output) {
            return Err("Native appearance target capture could not start");
        }
        Ok(guard)
    }
}
impl Drop for Output {
    fn drop(&mut self) {
        let output = self.0 as *mut ffi::obs_output_t;
        unsafe {
            ffi::obs_output_stop(output);
            // OBS destruction joins stop work before destroying Capture. Its
            // Arcs retain userdata and the mix even if another OBS reference
            // delays destruction beyond this release.
            ffi::obs_output_release(output);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::AudioCaptureQueue;
    use super::*;
    use producer_guest_runtime::program::VideoProfile;
    use std::sync::{atomic::AtomicU64, mpsc::sync_channel};

    #[test]
    fn retained_output_callback_owns_userdata_and_target_until_actual_destroy() {
        struct Keeper(Arc<AtomicU64>);
        impl Drop for Keeper {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::Relaxed);
            }
        }
        let released = Arc::new(AtomicU64::new(0));
        let (video, _receiver) = sync_channel(2);
        let shared = Arc::new(Shared {
            raise_priority: false,
            priority_attempted: AtomicBool::new(false),
            audio: Arc::new(AudioCaptureQueue::new()),
            video,
            failed: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            profile: VideoProfile::HOST_720P,
            video_period_ns: 33_333_333,
            next_video_at: AtomicU64::new(0),
            last_video_at: AtomicU64::new(0),
        });
        let weak_shared = Arc::downgrade(&shared);
        // Storage-only fixture: no OBS call is made with this null handle.
        let target = CaptureTarget {
            video: 0,
            profile: VideoProfile::HOST_720P,
            _keeper: Arc::new(Keeper(released.clone())),
        };
        let retained = Box::new(Capture {
            output: std::ptr::null_mut(),
            param: Arc::as_ptr(&shared).cast_mut().cast(),
            capturing: AtomicBool::new(false),
            _shared: Some(shared.clone()),
            _target: Some(target.clone()),
        });
        // Publisher retirement can release its owner while OBS still owns the
        // capture object. Callback state and engine lease must both survive.
        drop(shared);
        drop(target);
        assert!(weak_shared.upgrade().is_some());
        assert_eq!(released.load(Ordering::Acquire), 0);
        destroy(Box::into_raw(retained).cast());
        assert!(weak_shared.upgrade().is_none());
        assert_eq!(released.load(Ordering::Acquire), 1);
    }
}
