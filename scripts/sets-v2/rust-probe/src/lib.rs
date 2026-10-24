//! Compile and exercise the exact app adapter without pulling in the Tauri app.
#[path = "../../../../src-tauri/src/live/ffi.rs"]
mod ffi;
#[path = "../../../../src-tauri/src/live/sets_v2/mod.rs"]
mod sets_v2;
use std::ffi::{c_char, c_void, CStr};
#[no_mangle]
pub unsafe extern "C" fn sets_v2_rust_attach(
    room: *mut ffi::obs_scene_t,
    w: u32,
    h: u32,
) -> *mut c_void {
    match sets_v2::RoomProgram::attach(room, 7, w, h) {
        Ok(owner) => Box::into_raw(Box::new(owner)) as *mut c_void,
        Err(error) => {
            eprintln!("Rust adapter attach: {error}");
            std::ptr::null_mut()
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn sets_v2_rust_dispatch(
    owner: *mut c_void,
    json: *const c_char,
    capture: *mut ffi::obs_source_t,
    output: *mut c_char,
    capacity: usize,
) -> bool {
    if owner.is_null() || json.is_null() || output.is_null() || capacity == 0 {
        return false;
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let request = CStr::from_ptr(json).to_str().map_err(|e| e.to_string())?;
        if request.len() > 42 * 1024 * 1024 {
            return Err("Request too large".to_string());
        }
        let action: sets_v2::contract::Action =
            serde_json::from_str(request).map_err(|e| e.to_string())?;
        let owner = &mut *(owner as *mut sets_v2::RoomProgram);
        owner.dispatch(action, |id| {
            if id == "synthetic-camera" {
                Ok(capture)
            } else {
                Err("Probe source is not authorized".into())
            }
        })
    }));
    let (ok, value) = match result {
        Ok(Ok(status)) => (true, serde_json::to_string(&status).unwrap()),
        Ok(Err(error)) => (false, serde_json::json!({"error":error}).to_string()),
        Err(_) => (false, "{\"error\":\"Adapter panicked\"}".into()),
    };
    if value.len() >= capacity {
        return false;
    }
    std::ptr::copy_nonoverlapping(value.as_ptr(), output as *mut u8, value.len());
    *output.add(value.len()) = 0;
    if !ok {
        eprintln!("Rust adapter rejected: {value}");
    }
    ok
}
#[no_mangle]
pub unsafe extern "C" fn sets_v2_rust_release(owner: *mut c_void) {
    if !owner.is_null() {
        drop(Box::from_raw(owner as *mut sets_v2::RoomProgram));
    }
}

#[no_mangle]
pub unsafe extern "C" fn sets_v2_rust_register() {
    sets_v2::register();
}

#[path = "../../../../src-tauri/src/live/shaders.rs"]
mod shaders;
mod set_media {
    pub fn native_path(_: &str, _: &str) -> Result<std::path::PathBuf, String> {
        Err("External media references are not authorized by the native probe".into())
    }
}
