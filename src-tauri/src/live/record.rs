//! Local recording — the file the stream should have been.
//!
//! Engine rev 3 shipped obs-ffmpeg, so `ffmpeg_muxer` is available and this
//! is pure host work. Recording owns its OWN encoders rather than sharing
//! the stream's: a recording wants quality, a stream wants a bitrate the
//! network can carry, and sharing would force one to compromise. It also
//! means recording runs whether or not a stream is live — either, both, or
//! neither, which is what people actually expect from a record button.

use std::ffi::CString;
use std::path::PathBuf;
use std::ptr;

use super::{encoders, ffi};

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap_or_else(|_| CString::new("").unwrap())
}

pub struct Recorder {
    output: *mut ffi::obs_output_t,
    venc: *mut ffi::obs_encoder_t,
    aenc: *mut ffi::obs_encoder_t,
    path: PathBuf,
    started: std::time::Instant,
}

/// Where recordings land. ~/Movies/Producer on a Mac, %USERPROFILE%\Videos\
/// Producer on Windows — created on demand, the place each OS's user looks
/// for anything they recorded.
pub fn recordings_dir() -> PathBuf {
    let dir = if cfg!(target_os = "windows") {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join("Videos").join("Producer")
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(home).join("Movies").join("Producer")
    };
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn filename(stamp: &str) -> String {
    format!("Producer {stamp}.mp4")
}

impl Recorder {
    /// Start recording to a new file. `stamp` is passed in so the engine
    /// never has to know the wall clock.
    pub fn start(stamp: &str, bitrate: i64) -> Result<Recorder, String> {
        let path = recordings_dir().join(filename(stamp));
        unsafe {
            // Quality-first: high CBR, 2s keyframes for scrubbing, on the
            // encoder the boot probe chose (hardware where the box has it,
            // x264 otherwise — encoders.rs).
            let vs = ffi::obs_data_create();
            encoders::apply_video_defaults(vs, &encoders::chosen().id, bitrate);
            let as_ = ffi::obs_data_create();
            ffi::obs_data_set_int(as_, cstr("bitrate").as_ptr(), 192);

            let (venc, _used) = encoders::create_video("Producer REC H264", vs);
            let aenc = ffi::obs_audio_encoder_create(
                cstr(encoders::audio_id()).as_ptr(),
                cstr("Producer REC AAC").as_ptr(),
                as_,
                0,
                ptr::null_mut(),
            );
            ffi::obs_data_release(vs);
            ffi::obs_data_release(as_);
            if venc.is_null() || aenc.is_null() {
                if !venc.is_null() {
                    ffi::obs_encoder_release(venc);
                }
                if !aenc.is_null() {
                    ffi::obs_encoder_release(aenc);
                }
                return Err("couldn't create the recording encoders".into());
            }
            ffi::obs_encoder_set_video(venc, ffi::obs_get_video());
            ffi::obs_encoder_set_audio(aenc, ffi::obs_get_audio());

            let settings = ffi::obs_data_create();
            let p = cstr(&path.to_string_lossy());
            ffi::obs_data_set_string(settings, cstr("path").as_ptr(), p.as_ptr());
            let output = ffi::obs_output_create(
                cstr("ffmpeg_muxer").as_ptr(),
                cstr("Producer Recording").as_ptr(),
                settings,
                ptr::null_mut(),
            );
            ffi::obs_data_release(settings);
            if output.is_null() {
                ffi::obs_encoder_release(venc);
                ffi::obs_encoder_release(aenc);
                return Err("recording needs the obs-ffmpeg engine (rev 3 or newer)".into());
            }
            ffi::obs_output_set_video_encoder(output, venc);
            ffi::obs_output_set_audio_encoder(output, aenc, 0);
            if !ffi::obs_output_start(output) {
                let err = ffi::obs_output_get_last_error(output);
                let msg = if err.is_null() {
                    "recording failed to start".to_string()
                } else {
                    std::ffi::CStr::from_ptr(err).to_string_lossy().into_owned()
                };
                ffi::obs_output_release(output);
                ffi::obs_encoder_release(venc);
                ffi::obs_encoder_release(aenc);
                return Err(msg);
            }
            Ok(Recorder {
                output,
                venc,
                aenc,
                path,
                started: std::time::Instant::now(),
            })
        }
    }

    pub fn elapsed_secs(&self) -> u64 {
        self.started.elapsed().as_secs()
    }

    /// Bytes on disk so far — the honest "is this actually recording" signal.
    pub fn bytes(&self) -> u64 {
        std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0)
    }

    pub fn path(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    pub fn stop(self) -> String {
        unsafe {
            ffi::obs_output_stop(self.output);
            // ffmpeg_muxer finalizes the container asynchronously; give it a
            // moment so the file is playable rather than truncated.
            for _ in 0..40 {
                if !ffi::obs_output_active(self.output) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            ffi::obs_output_release(self.output);
            ffi::obs_encoder_release(self.venc);
            ffi::obs_encoder_release(self.aenc);
        }
        self.path.to_string_lossy().into_owned()
    }
}
