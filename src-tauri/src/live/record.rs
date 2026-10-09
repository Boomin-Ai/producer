//! Local recording — the file the stream should have been.
//!
//! Engine rev 3 shipped obs-ffmpeg, so `ffmpeg_muxer` is available and this
//! is pure host work. Recording owns its OWN encoders rather than sharing
//! the stream's: a recording wants quality, a stream wants a bitrate the
//! network can carry, and sharing would force one to compromise. It also
//! means recording runs whether or not a stream is live — either, both, or
//! neither, which is what people actually expect from a record button.

use std::ffi::{c_void, CString};
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use super::{encoders, ffi};

fn cstr(s: &str) -> CString {
    CString::new(s).unwrap_or_else(|_| CString::new("").unwrap())
}

struct StopState {
    code: AtomicI64,
    notified: AtomicBool,
}

extern "C" fn on_stop(data: *mut c_void, cd: *mut ffi::calldata_t) {
    unsafe {
        let state = &*(data as *const StopState);
        let mut code = -1i64;
        ffi::calldata_get_data(
            cd,
            cstr("code").as_ptr(),
            &mut code as *mut i64 as *mut c_void,
            8,
        );
        state.code.store(code, Ordering::Release);
    }
}

pub struct Recorder {
    output: *mut ffi::obs_output_t,
    venc: *mut ffi::obs_encoder_t,
    aenc: *mut ffi::obs_encoder_t,
    path: PathBuf,
    started: std::time::Instant,
    stop_state: Box<StopState>,
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
        unsafe { Self::start_video(stamp, bitrate, ffi::obs_get_video()) }
    }
    pub unsafe fn start_video(
        stamp: &str,
        bitrate: i64,
        video: *mut ffi::video_t,
    ) -> Result<Recorder, String> {
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
            ffi::obs_encoder_set_video(venc, video);
            ffi::obs_encoder_set_audio(aenc, ffi::obs_get_audio());

            let settings = ffi::obs_data_create();
            let p = cstr(&path.to_string_lossy());
            ffi::obs_data_set_string(settings, cstr("path").as_ptr(), p.as_ptr());
            // Write the index up front and persist complete keyframe fragments.
            // A full disk or crashed process can lose the final fragment without
            // making all earlier footage depend on a trailer that never arrived.
            ffi::obs_data_set_string(
                settings,
                cstr("muxer_settings").as_ptr(),
                cstr("movflags=frag_keyframe+empty_moov+default_base_moof").as_ptr(),
            );
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
            ffi::obs_output_set_media(output, video, ffi::obs_get_audio());
            ffi::obs_output_set_video_encoder(output, venc);
            ffi::obs_output_set_audio_encoder(output, aenc, 0);
            let stop_state = Box::new(StopState {
                code: AtomicI64::new(i64::MIN),
                notified: AtomicBool::new(false),
            });
            ffi::signal_handler_connect(
                ffi::obs_output_get_signal_handler(output),
                cstr("stop").as_ptr(),
                on_stop,
                &*stop_state as *const StopState as *mut c_void,
            );
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
                stop_state,
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

    /// Surface a failed helper immediately, rather than waiting for the user
    /// to discover an unreadable file after pressing Stop.
    pub fn take_failure(&self) -> Option<String> {
        let code = self.stop_state.code.load(Ordering::Acquire);
        if code == i64::MIN || code == 0 || self.stop_state.notified.swap(true, Ordering::AcqRel) {
            return None;
        }
        let detail = unsafe {
            let error = ffi::obs_output_get_last_error(self.output);
            if error.is_null() {
                String::new()
            } else {
                std::ffi::CStr::from_ptr(error)
                    .to_string_lossy()
                    .into_owned()
            }
        };
        Some(format!(
            "Recording stopped unexpectedly (code {code}). {detail} The local file is kept: {}",
            self.path.display()
        ))
    }

    pub fn stop(self) -> String {
        unsafe {
            ffi::obs_output_stop(self.output);
            // ffmpeg_muxer finalizes the container asynchronously; give it a
            // moment so the file is playable rather than truncated.
            for _ in 0..100 {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "requires the bundled native engine and graphics device"]
    fn native_dual_recordings_have_playable_indexes_before_and_after_stop() {
        let temp =
            std::env::temp_dir().join(format!("producer-record-proof-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        super::super::engine::persist_video(&temp, 1080, 30);
        let report = super::super::engine::bootstrap_with_config(&temp);
        assert!(report.ok, "native bootstrap: {report:?}");
        let mut graph = super::super::graph::SceneGraph::create().unwrap();
        let stamp = format!("Finalization proof {}", std::process::id());
        let main = Recorder::start(&stamp, 2000).unwrap();
        let portrait = unsafe {
            Recorder::start_video(
                &(stamp.clone() + " Portrait"),
                2000,
                graph.portrait_video().unwrap(),
            )
        }
        .unwrap();
        // Wait for actual disk writes, not a fixed sleep on a busy machine.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let paths = [main.path(), portrait.path()];
        let indexes_written = loop {
            use std::io::Read;
            let written = paths.iter().all(|path| {
                let mut prefix = [0; 4096];
                std::fs::File::open(path)
                    .and_then(|mut f| f.read(&mut prefix))
                    .is_ok_and(|n| prefix[..n].windows(4).any(|w| w == b"moov"))
            });
            if written || std::time::Instant::now() >= deadline {
                break written;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        };
        let portrait = portrait.stop();
        let main = main.stop();
        crate::recordings::validate_mp4(std::path::Path::new(&main)).unwrap();
        crate::recordings::validate_mp4(std::path::Path::new(&portrait)).unwrap();
        assert!(indexes_written, "movie indexes must reach disk before Stop");
        println!("recording proof: {main} | {portrait}");

        // Terminate ONLY this test's helper to simulate a muxer failure. The
        // engine must see that failure once instead of silently recording on.
        let failed = Recorder::start(&(stamp + " Interrupted"), 2000).unwrap();
        std::thread::sleep(std::time::Duration::from_secs(4));
        let listing = std::process::Command::new("ps")
            .args(["-axo", "pid,ppid,comm"])
            .output()
            .unwrap();
        let helper = String::from_utf8_lossy(&listing.stdout)
            .lines()
            .find_map(|line| {
                let mut fields = line.split_whitespace();
                let pid = fields.next()?.parse::<u32>().ok()?;
                let parent = fields.next()?.parse::<u32>().ok()?;
                let command = fields.next()?;
                (parent == std::process::id() && command.ends_with("obs-ffmpeg-mux")).then_some(pid)
            })
            .expect("test-owned recording helper");
        assert!(std::process::Command::new("kill")
            .args(["-KILL", &helper.to_string()])
            .status()
            .unwrap()
            .success());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let failure = loop {
            if let Some(message) = failed.take_failure() {
                break Some(message);
            }
            if std::time::Instant::now() >= deadline {
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        assert!(failure.unwrap().contains("stopped unexpectedly"));
        assert!(failed.take_failure().is_none());
        failed.stop();
        drop(graph);
    }
}
