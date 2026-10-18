//! Synthetic acceptance probe, compiled only into the isolated camera dev build.
//! Uses normal engine commands; never opens a camera/microphone source.
use super::graph::{ExtraSpec, TransformPatch};
use crate::AppState;
use std::{path::PathBuf, time::Duration};
use tauri::Manager;

pub fn start(app: tauri::AppHandle, report: PathBuf) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let live = &state.live;
        let ids = [
            "portrait-proof-background",
            "portrait-proof-top",
            "portrait-proof-bottom",
        ];
        let write = |value: serde_json::Value| {
            if let Ok(bytes) = serde_json::to_vec_pretty(&value) {
                let _ = std::fs::write(&report, bytes);
            }
        };
        let mut original_mirror = None;
        let result = (|| -> Result<(), String> {
            let deadline = std::time::Instant::now() + Duration::from_secs(300);
            while live.status()["engine_ready"] != true {
                if std::time::Instant::now() >= deadline {
                    return Err("Engine bootstrap did not finish".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            original_mirror = Some(live.virtual_cam_mirror(None)?);
            live.virtual_cam_mirror(Some(false))?;
            for (id, color) in ids.iter().zip(["#0000ff", "#ff0000", "#00ff00"]) {
                live.add_extra(
                    (*id).into(),
                    "Portrait camera test".into(),
                    ExtraSpec::Color {
                        color: color.into(),
                    },
                )?;
            }
            let sources = live.portrait_room()?;
            for (id, x, y, w, h, z) in [
                (ids[0], 0., 0., 720., 1280., 0),
                (ids[1], 0., 0., 180., 180., 1),
                (ids[2], 540., 1100., 180., 180., 2),
            ] {
                // Color sources inherit the landscape dimensions. Crop their
                // solid color to the desired aspect before SCALE_INNER, so
                // this fixture tests the camera rather than letterboxing.
                let source = sources
                    .items
                    .iter()
                    .find(|item| item.id == id)
                    .ok_or("Missing fixture source")?;
                let content_width = if z == 0 {
                    source.src_h * 9 / 16
                } else {
                    source.src_h
                };
                let crop_right = source.src_w.saturating_sub(content_width) as i32;
                live.portrait_transform(
                    id.into(),
                    TransformPatch {
                        x: Some(x),
                        y: Some(y),
                        w: Some(w),
                        h: Some(h),
                        z: Some(z),
                        crop_right: Some(crop_right),
                        visible: Some(true),
                        ..Default::default()
                    },
                )?;
            }
            for (id, x, y, w, h, z) in [
                (ids[0], 0., 0., 1280., 720., 0),
                (ids[1], 0., 0., 180., 180., 1),
                (ids[2], 1100., 540., 180., 180., 2),
            ] {
                let source = sources.items.iter().find(|item| item.id == id).ok_or("Missing landscape fixture")?;
                let crop_right = if z == 0 { 0 } else { source.src_w.saturating_sub(source.src_h) as i32 };
                live.set_transform(id.into(), TransformPatch { x: Some(x), y: Some(y), w: Some(w), h: Some(h),
                    z: Some(z), crop_right: Some(crop_right), visible: Some(true), ..Default::default() }, false)?;
            }
            live.select_output(true)?;
            live.set_virtual_cam(true)?;
            // Actual output ownership must reject a canvas switch.
            if live.select_output(false).is_ok() {
                return Err("Canvas changed while the camera was active".into());
            }
            live.set_virtual_cam(false)?;
            for phase in 0..7 {
                let portrait = (3..6).contains(&phase);
                if phase == 0 || phase == 3 || phase == 6 {
                    live.set_virtual_cam(false)?;
                    live.select_output(portrait)?;
                    live.set_virtual_cam(true)?;
                }
                let mirrored = phase == 1 || phase == 4;
                live.virtual_cam_mirror(Some(mirrored))?;
                write(serde_json::json!({"stage":"camera_running", "phase":phase, "mirrored":mirrored,
                    "camera":"Producer Virtual Camera", "expected_width":if portrait {1080} else {1920},
                    "expected_height":if portrait {1920} else {1080}, "switch_guard":true}));
                std::thread::sleep(Duration::from_secs(15));
            }
            Ok(())
        })();
        let stopped = live.set_virtual_cam(false).is_ok();
        if let Some(original) = original_mirror {
            let _ = live.virtual_cam_mirror(Some(original));
        }
        let _ = live.select_output(false);
        for id in ids {
            let _ = live.remove_extra(id.into());
        }
        let _ = live.portrait_stop();
        match result {
            Ok(()) => write(
                serde_json::json!({"stage":"complete", "switch_guard":true,"camera_stopped":stopped}),
            ),
            Err(error) => write(
                serde_json::json!({"stage":"failed", "error":error, "camera_stopped":stopped}),
            ),
        }
    });
}
