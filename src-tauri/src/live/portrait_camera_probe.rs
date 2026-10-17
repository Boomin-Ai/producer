//! Synthetic acceptance probe, compiled only into the isolated camera dev build.
//! Uses normal engine commands; never opens a camera/microphone source.
use crate::AppState;
use super::graph::{ExtraSpec, TransformPatch};
use std::{path::PathBuf, time::Duration};
use tauri::Manager;

pub fn start(app: tauri::AppHandle, report: PathBuf) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let live = &state.live;
        let ids = ["portrait-proof-background", "portrait-proof-top", "portrait-proof-bottom"];
        let write = |value: serde_json::Value| {
            if let Ok(bytes) = serde_json::to_vec_pretty(&value) { let _ = std::fs::write(&report, bytes); }
        };
        let result = (|| -> Result<(), String> {
            std::thread::sleep(Duration::from_secs(3));
            for (id, color) in ids.iter().zip(["#0000ff", "#ff0000", "#00ff00"]) {
                live.add_extra((*id).into(), "Portrait camera test".into(), ExtraSpec::Color { color: color.into() })?;
            }
            live.portrait_room()?;
            for (id, x, y, w, h, z) in [
                (ids[0], 0., 0., 720., 1280., 0),
                (ids[1], 0., 0., 180., 180., 1),
                (ids[2], 540., 1100., 180., 180., 2),
            ] {
                live.portrait_transform(id.into(), TransformPatch {x:Some(x), y:Some(y), w:Some(w), h:Some(h), z:Some(z), visible:Some(true), ..Default::default()})?;
            }
            live.select_output(true)?;
            live.set_virtual_cam(true)?;
            // Actual output ownership must reject a canvas switch.
            if live.select_output(false).is_ok() {
                return Err("Canvas changed while the camera was active".into());
            }
            write(serde_json::json!({"stage":"camera_running", "camera":"Producer Portrait Camera", "expected_width":1080,"expected_height":1920,"switch_guard":true}));
            std::thread::sleep(Duration::from_secs(60));
            Ok(())
        })();
        let stopped = live.set_virtual_cam(false).is_ok();
        let _ = live.select_output(false);
        for id in ids { let _ = live.remove_extra(id.into()); }
        let _ = live.portrait_stop();
        match result {
            Ok(()) => write(serde_json::json!({"stage":"complete", "switch_guard":true,"camera_stopped":stopped})),
            Err(error) => write(serde_json::json!({"stage":"failed", "error":error, "camera_stopped":stopped})),
        }
    });
}
