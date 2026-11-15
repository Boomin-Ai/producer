use super::StudioSpotlightRect;

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMotionPose {
    /// Top-left fractions of the webview. Mapped to the captured window before playback.
    pub panel: Option<StudioSpotlightRect>,
    pub lift: f32,
    pub floating: f32,
    pub zoom: f32,
    pub pan_x: f32,
    pub pan_y: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub roll: f32,
    #[serde(default)]
    pub canvas_mix: f32,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMotionKeyframe {
    pub at_ms: u32,
    #[serde(flatten)]
    pub pose: StudioMotionPose,
}

impl StudioMotionPose {
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.panel.is_some_and(|rect| !rect.is_valid())
            || (self.lift > 0.0 && self.panel.is_none())
        {
            return Err("Studio motion requires a visible panel rectangle to lift a panel.".into());
        }
        for (name, value, low, high) in [
            ("lift", self.lift, 0.0, 1.0),
            ("floating", self.floating, 0.0, 1.0),
            ("zoom", self.zoom, 0.7, 2.2),
            ("panX", self.pan_x, -0.6, 0.6),
            ("panY", self.pan_y, -0.6, 0.6),
            ("yaw", self.yaw, -0.72, 0.72),
            ("pitch", self.pitch, -0.72, 0.72),
            ("roll", self.roll, -0.40, 0.40),
            ("canvasMix", self.canvas_mix, 0.0, 1.0),
        ] {
            if !(low..=high).contains(&value) {
                return Err(format!(
                    "Studio motion {name} must be between {low} and {high}."
                ));
            }
        }
        Ok(())
    }
}

pub(super) fn validate_track(keyframes: &[StudioMotionKeyframe]) -> Result<(), String> {
    if !(2..=1200).contains(&keyframes.len()) || keyframes[0].at_ms != 0 {
        return Err("Studio motion requires 2 to 1200 keyframes, starting at 0 ms.".into());
    }
    for (index, key) in keyframes.iter().enumerate() {
        if key.at_ms > 60_000 || (index > 0 && key.at_ms <= keyframes[index - 1].at_ms) {
            return Err(
                "Studio motion keyframes must increase strictly and fit in 60 seconds.".into(),
            );
        }
        key.pose.validate()?;
    }
    Ok(())
}

/// Keep the layout in sync with struct studio_motion_key in studio_window_capture.m.
#[cfg(all(target_os = "macos", have_engine))]
#[repr(C)]
pub(crate) struct NativeMotionKeyframe {
    pub at_ms: u32,
    pub crop: [f32; 4],
    pub lift: f32,
    pub floating: f32,
    pub zoom: f32,
    pub pan_x: f32,
    pub pan_y: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub roll: f32,
    pub canvas_mix: f32,
}

#[cfg(all(target_os = "macos", have_engine))]
const _: () = assert!(std::mem::size_of::<NativeMotionKeyframe>() == 56);
