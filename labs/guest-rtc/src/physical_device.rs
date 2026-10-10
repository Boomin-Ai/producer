//! Shared native device owner for local physical and loopback RTC labs.
use anyhow::{ensure, Result};
use serde_json::json;
use std::ffi::{c_char, c_void, CStr};
const QUEUE_CAPACITY: usize = 32;
#[repr(C)]
pub struct Block {
    pub host_ns: u64,
    pub samples: [i16; 480],
}
#[allow(dead_code)]
unsafe extern "C" {
    fn lab_audio_create(
        samples: *const i16,
        count: usize,
        fail_stage: i32,
        error: *mut c_char,
        length: usize,
    ) -> *mut c_void;
    fn lab_audio_create_io(
        samples: *const i16,
        count: usize,
        fail_stage: i32,
        error: *mut c_char,
        length: usize,
    ) -> *mut c_void;
    fn lab_audio_now_ns() -> u64;
    fn lab_audio_notifications_alive() -> i32;
    fn lab_output_format_snapshot(message: *mut c_char, length: usize);
    fn lab_audio_start(handle: *mut c_void, error: *mut c_char, length: usize) -> i32;
    fn lab_audio_pop(handle: *mut c_void, render: i32, block: *mut Block) -> i32;
    fn lab_audio_faults(handle: *mut c_void) -> u64;
    fn lab_audio_fault_detail(handle: *mut c_void, message: *mut c_char, length: usize);
    fn lab_audio_close(handle: *mut c_void, stats: *mut u64) -> i32;
    fn lab_audio_self_test() -> i32;
    fn lab_ui_open();
    fn lab_ui_poll() -> i32;
    fn lab_ui_status(text: *const c_char);
    fn lab_permission(request: i32) -> i32;
    fn lab_output_volume_percent() -> f64;
}
pub struct Device {
    pub handle: *mut c_void,
}
impl Device {
    pub fn new(speech: &[i16], io_callbacks: bool) -> Result<(Self, String)> {
        let mut message = [0i8; 1024];
        let handle = unsafe {
            let create = if io_callbacks {
                lab_audio_create_io
            } else {
                lab_audio_create
            };
            create(
                speech.as_ptr(),
                speech.len(),
                0,
                message.as_mut_ptr(),
                message.len(),
            )
        };
        let text = unsafe { CStr::from_ptr(message.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        ensure!(!handle.is_null(), "Native device setup: {text}");
        let owner = Self { handle };
        ensure!(
            unsafe { lab_audio_start(handle, message.as_mut_ptr(), message.len()) } != 0,
            "Native device start: {}",
            unsafe { CStr::from_ptr(message.as_ptr()) }.to_string_lossy()
        );
        Ok((owner, text))
    }
    pub fn pop(&self, render: bool) -> Option<Block> {
        let mut block = Block {
            host_ns: 0,
            samples: [0; 480],
        };
        (unsafe { lab_audio_pop(self.handle, i32::from(render), &mut block) } != 0).then_some(block)
    }
    pub fn close(&mut self) -> serde_json::Value {
        if self.handle.is_null() {
            return json!({"already_closed":true});
        }
        let mut counts = [0u64; 15];
        let retired = unsafe { lab_audio_close(self.handle, counts.as_mut_ptr()) } != 0;
        self.handle = std::ptr::null_mut();
        json!({"owners_and_callback_state_retired":retired,"callbacks_active":counts[6],"render_notifications_alive":unsafe {lab_audio_notifications_alive()},"format_or_timeline_errors":counts[7],"startup_quarantine":{"duration_ms":250,"speaker_frames":counts[13],"microphone_frames":counts[14],"scope":"I/O callback mode only; PCM before the fixed deadline is not recorded or processed"},"first_io_fault":{"speaker":counts[11],"microphone":counts[12],"codes":"0 none; 1 timestamp/layout; 2 buffer; 3 timeline; 4 nonfinite sample; 5 post-render error; 6 configuration change"},"clipped_samples":counts[8],"maximum_tap_frames":{"speaker":counts[9],"microphone":counts[10]},
            "speaker":{"queued":counts[0],"consumed":counts[1],"overflow":counts[2],"pending_retired":counts[0]-counts[1],"capacity":QUEUE_CAPACITY},
            "microphone":{"queued":counts[3],"consumed":counts[4],"overflow":counts[5],"pending_retired":counts[3]-counts[4],"capacity":QUEUE_CAPACITY}})
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        self.close();
    }
}
