/// The source and its OBS conversion agree on one explicit I420 profile.
/// Host return publication retains its existing 720p source size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoProfile {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}
impl VideoProfile {
    pub const HOST_720P: Self = Self {
        width: 1280,
        height: 720,
        fps: 30,
    };

    pub fn appearance(height: u32, portrait: bool) -> Result<Self, &'static str> {
        if !matches!(height, 720 | 1080) {
            return Err("Native appearance supports 720p30 or 1080p30");
        }
        let width = height * 16 / 9;
        Ok(if portrait {
            Self {
                width: height,
                height: width,
                fps: 30,
            }
        } else {
            Self {
                width,
                height,
                fps: 30,
            }
        })
    }

    pub fn validate(self) -> Result<Self, &'static str> {
        if self.fps != 30
            || !matches!(
                (self.width, self.height),
                (1280, 720) | (720, 1280) | (1920, 1080) | (1080, 1920)
            )
        {
            return Err("Native appearance video profile is unsupported");
        }
        Ok(self)
    }
}

/// Local camera mute preserves a moving RTP timeline and replaces pixels with
/// limited-range I420 black. The muted branch never copies scene pixels.
pub(crate) fn copy_i420(
    profile: VideoProfile,
    enabled: bool,
    input: (&[u8], &[u8], &[u8]),
    output: (&mut [u8], &mut [u8], &mut [u8]),
) -> Result<(), &'static str> {
    let pixels = (profile.width * profile.height) as usize;
    if output.0.len() != pixels || output.1.len() != pixels / 4 || output.2.len() != pixels / 4 {
        return Err("Native program video destination format invalid");
    }
    if enabled {
        if input.0.len() != pixels || input.1.len() != pixels / 4 || input.2.len() != pixels / 4 {
            return Err("Native program video format invalid");
        }
        output.0.copy_from_slice(input.0);
        output.1.copy_from_slice(input.1);
        output.2.copy_from_slice(input.2);
    } else {
        output.0.fill(16);
        output.1.fill(128);
        output.2.fill(128);
    }
    Ok(())
}

#[cfg(test)]
mod profile_tests {
    use super::VideoProfile;
    #[test]
    fn camera_mute_replaces_pixels_with_black_and_unmute_restores_only_its_frame() {
        let profile = VideoProfile::HOST_720P;
        let pixels = (profile.width * profile.height) as usize;
        let (mut y, mut u, mut v) = (vec![99; pixels], vec![88; pixels / 4], vec![77; pixels / 4]);
        super::copy_i420(profile, false, (&[], &[], &[]), (&mut y, &mut u, &mut v)).unwrap();
        assert!(y.iter().all(|v| *v == 16));
        assert!(u.iter().chain(v.iter()).all(|v| *v == 128));
        let (source_y, source_u, source_v) =
            (vec![33; pixels], vec![44; pixels / 4], vec![55; pixels / 4]);
        super::copy_i420(
            profile,
            true,
            (&source_y, &source_u, &source_v),
            (&mut y, &mut u, &mut v),
        )
        .unwrap();
        assert_eq!(y, source_y);
        assert_eq!(u, source_u);
        assert_eq!(v, source_v);
        assert!(
            super::copy_i420(profile, true, (&[], &[], &[]), (&mut y, &mut u, &mut v)).is_err()
        );
    }

    #[test]
    fn appearance_profiles_preserve_orientation_and_bound_work() {
        assert_eq!(
            VideoProfile::appearance(720, false).unwrap(),
            VideoProfile::HOST_720P
        );
        assert_eq!(
            VideoProfile::appearance(720, true).unwrap(),
            VideoProfile {
                width: 720,
                height: 1280,
                fps: 30
            }
        );
        for portrait in [false, true] {
            assert!(VideoProfile::appearance(1080, portrait)
                .unwrap()
                .validate()
                .is_ok());
        }
        assert!(VideoProfile::appearance(2160, false).is_err());
        assert!(VideoProfile {
            fps: 60,
            ..VideoProfile::HOST_720P
        }
        .validate()
        .is_err());
        assert!(VideoProfile {
            width: 1281,
            ..VideoProfile::HOST_720P
        }
        .validate()
        .is_err());
    }
}
