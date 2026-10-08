//! Processed OBS buses for the interactive publisher. Bus 0 is the audience
//! mix; bus 1 excludes remote guests so stage participants do not hear their
//! own delayed voices. A bounded queue drops old audio rather than adding lag.
use super::ffi;
#[cfg(debug_assertions)]
pub mod verification;
use std::{collections::VecDeque, sync::{Mutex, OnceLock}};

#[repr(C)]
struct Convert { rate: u32, format: i32, speakers: i32, allow_clipping: bool }
#[cfg_attr(target_os = "windows", link(name = "obs", kind = "raw-dylib"))]
extern "C" {
    fn audio_output_connect(audio: *mut ffi::audio_t, mix: usize, convert: *const Convert,
        callback: extern "C" fn(*mut std::ffi::c_void, usize, *mut ffi::audio_data), param: *mut std::ffi::c_void) -> bool;
    fn audio_output_disconnect(audio: *mut ffi::audio_t, mix: usize,
        callback: extern "C" fn(*mut std::ffi::c_void, usize, *mut ffi::audio_data), param: *mut std::ffi::c_void);
}
static ACTIVE: Mutex<Option<usize>> = Mutex::new(None);
static QUEUE: OnceLock<Mutex<VecDeque<Vec<u8>>>> = OnceLock::new();
fn queue() -> &'static Mutex<VecDeque<Vec<u8>>> { QUEUE.get_or_init(|| Mutex::new(VecDeque::new())) }
extern "C" fn capture(_param: *mut std::ffi::c_void, mix: usize, data: *mut ffi::audio_data) {
    if data.is_null() || mix > 1 { return; }
    let Ok(mut queue) = queue().try_lock() else { return; };
    let data = unsafe { &*data };
    if data.frames > 4096 || data.data[0].is_null() || data.data[1].is_null() { return; }
    let frames = data.frames as usize;
    let mut packet = Vec::with_capacity(16 + frames * 8);
    packet.extend_from_slice(&(mix as u32).to_le_bytes());
    packet.extend_from_slice(&data.frames.to_le_bytes());
    packet.extend_from_slice(&data.timestamp.to_le_bytes());
    let left = unsafe { std::slice::from_raw_parts(data.data[0] as *const f32, frames) };
    let right = unsafe { std::slice::from_raw_parts(data.data[1] as *const f32, frames) };
    for i in 0..frames { packet.extend_from_slice(&left[i].to_le_bytes()); packet.extend_from_slice(&right[i].to_le_bytes()); }
    // At OBS's normal 1024-frame cadence this bounds the two buses to ~85ms.
    while queue.len() >= 8 { queue.pop_front(); }
    queue.push_back(packet);
}
pub fn start() -> Result<(), String> {
    let mut active = ACTIVE.lock().map_err(|_| "Audio publisher lock failed")?;
    if active.is_some() { return Ok(()); }
    let audio = unsafe { ffi::obs_get_audio() };
    if audio.is_null() { return Err("Start the production engine before the interactive publisher".into()); }
    queue().lock().map_err(|_| "Audio buffer lock failed")?.clear();
    let convert = Convert { rate: 48000, format: 8, speakers: 2, allow_clipping: false };
    unsafe {
        if !audio_output_connect(audio, 0, &convert, capture, std::ptr::null_mut()) { return Err("Audience audio bus unavailable".into()); }
        if !audio_output_connect(audio, 1, &convert, capture, std::ptr::null_mut()) {
            audio_output_disconnect(audio, 0, capture, std::ptr::null_mut());
            return Err("Stage audio bus unavailable".into());
        }
    }
    *active = Some(audio as usize);
    Ok(())
}
pub fn stop() {
    let Ok(mut active) = ACTIVE.lock() else { return; };
    if let Some(audio) = active.take() { unsafe {
        audio_output_disconnect(audio as *mut ffi::audio_t, 0, capture, std::ptr::null_mut());
        audio_output_disconnect(audio as *mut ffi::audio_t, 1, capture, std::ptr::null_mut());
    } }
    if let Ok(mut queue) = queue().lock() { queue.clear(); }
}
pub fn drain() -> Vec<u8> {
    let Ok(mut queue) = queue().lock() else { return Vec::new(); };
    let mut output = Vec::with_capacity(queue.iter().map(Vec::len).sum());
    for packet in queue.drain(..) { output.extend(packet); }
    output
}
