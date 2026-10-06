//! Debug-only isolated native acceptance probe. No capture devices, guest links,
//! destinations, recording, microphone, room document or server connection.
use super::{
    engine::{Command, LiveHandle},
    ffi,
    graph::{ExtraSpec, SceneGraph},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    time::Duration,
};
static PIXELS: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static REQUEST_FRAME: AtomicBool = AtomicBool::new(false);
extern "C" fn frame(_: *mut std::ffi::c_void, data: *mut ffi::video_data) {
    if !REQUEST_FRAME.swap(false, Ordering::SeqCst) {
        return;
    }
    unsafe {
        if data.is_null() || (*data).data[0].is_null() {
            return;
        }
        let mut out = Vec::with_capacity(1280 * 720 * 4);
        for y in 0..720 {
            out.extend_from_slice(std::slice::from_raw_parts(
                (*data).data[0].add(y * (*data).linesize[0] as usize),
                1280 * 4,
            ));
        }
        *PIXELS.lock().unwrap() = out;
    }
}
fn capture(path: &std::path::Path, name: &str) -> Result<Vec<u8>, String> {
    PIXELS.lock().unwrap().clear();
    REQUEST_FRAME.store(true, Ordering::SeqCst);
    for _ in 0..100 {
        std::thread::sleep(Duration::from_millis(20));
        let p = PIXELS.lock().unwrap();
        if !p.is_empty() {
            std::fs::write(path.join(format!("{name}.bgra")), &*p).map_err(|e| e.to_string())?;
            return Ok(p.clone());
        }
    }
    Err("Native frame capture timed out".into())
}
fn pixel(frame: &[u8], x: usize, y: usize) -> (u8, u8, u8) {
    let i = (y * 1280 + x) * 4;
    (frame[i + 2], frame[i + 1], frame[i])
}
pub unsafe fn start(
    graph: &mut SceneGraph,
    handle: LiveHandle,
    path: std::path::PathBuf,
) -> Result<(), String> {
    if !graph.state().items.is_empty() {
        return Err("Probe requires an isolated empty graph".into());
    }
    graph.add_extra(
        "set-probe-host",
        "Synthetic host",
        &ExtraSpec::Color {
            color: "#20c060".into(),
        },
    )?;
    graph.add_extra(
        "set-probe-guest",
        "Synthetic guest",
        &ExtraSpec::Color {
            color: "#f08030".into(),
        },
    )?;
    if path.join("framing-check").exists() {
        let data = ffi::obs_data_create_from_json(
            std::ffi::CString::new("{\"width\":960,\"height\":720,\"color\":4280336480}")
                .unwrap()
                .as_ptr(),
        );
        ffi::obs_source_update(graph.source_by_id("set-probe-host").unwrap(), data);
        ffi::obs_data_release(data);
    }

    #[repr(C)]
    struct Scale {
        format: i32,
        width: u32,
        height: u32,
        range: i32,
        colorspace: i32,
    }
    let scale = Scale {
        format: 7,
        width: 1280,
        height: 720,
        range: 2,
        colorspace: 2,
    };
    ffi::obs_add_raw_video_callback(&scale as *const _ as *const _, frame, std::ptr::null_mut());
    std::thread::spawn(move || {
        let test = (|| -> Result<serde_json::Value, String> {
            let projections: Vec<super::presentation::Projection> = serde_json::from_slice(
                &std::fs::read(path.join("projections.json")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let status = handle.presentation_status()?;
            let lease = uuid::Uuid::new_v4().to_string();
            std::thread::sleep(Duration::from_millis(600));
            let baseline = serde_json::to_value(&handle.snapshot.lock().unwrap().sources)
                .map_err(|e| e.to_string())?;
            let before = capture(&path, "room-before")?;
            let mut results = Vec::new();
            for (index, projection) in projections.into_iter().enumerate() {
                let mut bindings =
                    std::collections::HashMap::from([("host".into(), "set-probe-host".into())]);
                if index != 1 {
                    bindings.insert("guest".into(), "set-probe-guest".into());
                }
                let request = super::presentation::Request {
                    generation: status.generation,
                    lease: lease.clone(),
                    projection,
                    bindings,
                };
                let applied = handle.presentation_apply(request.clone())?;
                std::thread::sleep(Duration::from_millis(300));
                let pixels = capture(&path, &format!("set-{index}"))?;
                let corner = pixel(&pixels, 8, 8);
                if corner == pixel(&before, 8, 8) {
                    return Err("Set backdrop did not replace the room pixels".into());
                }
                results.push(serde_json::json!({"revision":applied.revision,"corner":corner}));
                // The capture graph remains the original graph, including its transforms,
                // visibility, muted state, sync offsets and source identities.
                let sources = handle.snapshot.lock().unwrap().sources.clone();
                if serde_json::to_value(&sources).map_err(|e| e.to_string())? != baseline {
                    return Err(format!(
                        "Set changed the original room source state: baseline={}, current={}",
                        baseline,
                        serde_json::to_value(sources).unwrap()
                    ));
                }
                if handle.presentation_apply(request).is_ok() {
                    return Err("A duplicate revision was accepted".into());
                }
            }
            let returned = handle.presentation_return(Some(lease.clone()))?;
            if returned.lease.is_some() || returned.generation == status.generation {
                return Err("Return did not fence the old composition".into());
            }
            std::thread::sleep(Duration::from_millis(200));
            let after = capture(&path, "room-after")?;
            if pixel(&before, 8, 8) != pixel(&after, 8, 8) {
                return Err("Return did not restore the room pixels".into());
            }
            // A cancelled off-air preparation must not reactivate after Return.
            let projection: super::presentation::Projection =
                serde_json::from_slice::<Vec<super::presentation::Projection>>(
                    &std::fs::read(path.join("projections.json")).unwrap(),
                )
                .unwrap()[0]
                    .clone();
            let (tx, rx) = mpsc::channel();
            handle
                .probe_sender()
                .send(Command::PresentationPrepare {
                    request: super::presentation::Request {
                        generation: returned.generation,
                        lease: lease.clone(),
                        projection,
                        bindings: Default::default(),
                    },
                    reply: tx,
                })
                .map_err(|e| e.to_string())?;
            let bridge = rx
                .recv_timeout(Duration::from_secs(10))
                .map_err(|e| e.to_string())??;
            handle.presentation_return(Some(lease))?;
            if bridge.wait().is_ok() {
                return Err("Cancelled preparation remained active".into());
            }
            Ok(
                serde_json::json!({"ok":true,"frames":results,"baseline":baseline,"cancelledPreparation":true,"roomRestored":true}),
            )
        })();
        let result = match test {
            Ok(v) => v,
            Err(e) => serde_json::json!({"ok":false,"error":e}),
        };
        let _ = std::fs::write(
            path.join("result.json"),
            serde_json::to_vec_pretty(&result).unwrap(),
        );
    });
    Ok(())
}
