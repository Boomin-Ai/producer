//! Opt-in native built-in camera on its own owned thread. No pixel recording.
use anyhow::{ensure, Result};
use livekit::webrtc::{prelude::*, video_source::native::NativeVideoSource};
use serde_json::json;
use std::{
    ffi::{c_char, c_void, CStr},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
unsafe extern "C" {
    fn lab_camera_authorized() -> i32;
    fn lab_camera_permissions() -> i32;
    fn lab_camera_create(error: *mut c_char, length: usize) -> *mut c_void;
    fn lab_camera_pending(handle: *mut c_void) -> i32;
    fn lab_camera_pop(
        handle: *mut c_void,
        y: *mut u8,
        u: *mut u8,
        v: *mut u8,
        host_ns: *mut u64,
    ) -> i32;
    fn lab_camera_errors(handle: *mut c_void) -> u64;
    fn lab_camera_close(handle: *mut c_void, stats: *mut u64);
    #[cfg(test)]
    fn lab_camera_self_test() -> i32;
    fn lab_audio_now_ns() -> u64;
}
pub fn enabled() -> bool {
    std::env::var("LIVEKIT_LAB_PHYSICAL_CAMERA").as_deref() == Ok("1")
}
pub fn permissions() -> Result<()> {
    ensure!(
        unsafe { lab_camera_permissions() } == 1,
        "Camera/microphone permission denied or timed out"
    );
    Ok(())
}
pub fn preflight() -> Result<()> {
    ensure!(
        unsafe { lab_camera_authorized() } == 1,
        "Grant explicit camera permission through the packaged lab before connecting"
    );
    Ok(())
}
struct Device {
    handle: *mut c_void,
}
impl Device {
    fn new() -> Result<Self> {
        let mut error = [0i8; 512];
        let handle = unsafe { lab_camera_create(error.as_mut_ptr(), error.len()) };
        ensure!(
            !handle.is_null(),
            "Native camera: {}",
            unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy()
        );
        Ok(Self { handle })
    }
    fn close(&mut self) -> serde_json::Value {
        if self.handle.is_null() {
            return json!({"already_closed":true});
        }
        let mut stats = [0u64; 7];
        unsafe { lab_camera_close(self.handle, stats.as_mut_ptr()) };
        self.handle = std::ptr::null_mut();
        json!({"queued":stats[0],"consumed":stats[1],"overflow_newest_discarded":stats[2],"native_late_discarded":stats[3],"format_or_timestamp_errors":stats[4],"callbacks_active_after_stop":stats[5],"owners_retired":stats[6]!=0,"pending_retired":stats[0]-stats[1],"capacity_frames":3})
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        self.close();
    }
}
pub struct Publisher {
    pub stop: Arc<AtomicBool>,
    pub failed: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<serde_json::Value>>,
}
impl Publisher {
    pub fn start(source: NativeVideoSource) -> Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let failed = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let fault = failed.clone();
        let thread=std::thread::Builder::new().name("physical-camera-publisher".into()).spawn(move||{
   let mut lifecycle=json!({"hardware_opened":false});let mut submitted=0u64;let mut stale=0u64;let mut adapted=0u64;let mut ages=[0u64;201];let mut max_age=0u64;let mut previous=0u64;
   let result=(||->Result<()> {
    if done.load(Ordering::Acquire){return Ok(());}
    let mut device=Device::new()?;lifecycle=json!({"hardware_opened":true});
    let outcome=(||->Result<()> {
     while !done.load(Ordering::Acquire) {
      ensure!(unsafe{lab_camera_errors(device.handle)}==0,"Native camera format/timestamp/runtime fault");
      if unsafe{lab_camera_pending(device.handle)}==0 {std::thread::sleep(Duration::from_millis(2));continue;}
      let mut buffer=I420Buffer::new(640,480);
      ensure!(buffer.strides()==(640,320,320),"Unexpected I420 SDK strides");
      let (y,u,v)=buffer.data_mut();let mut host_ns=0;
      if unsafe{lab_camera_pop(device.handle,y.as_mut_ptr(),u.as_mut_ptr(),v.as_mut_ptr(),&mut host_ns)}==0 {std::thread::sleep(Duration::from_millis(2));continue;}
      ensure!(host_ns>previous,"Camera capture clock regressed");previous=host_ns;
      let now=unsafe{lab_audio_now_ns()};ensure!(now>=host_ns,"Camera host timestamp is in the future");
      let age=(now-host_ns)/1000;max_age=max_age.max(age);
      if age>100000 {stale+=1;continue;}
      ages[(age.div_ceil(1000) as usize).min(200)]+=1;
      if done.load(Ordering::Acquire){break;}
      if source.capture_frame(&VideoFrame{rotation:VideoRotation::VideoRotation0,timestamp_us:(host_ns/1000) as i64,frame_metadata:None,buffer}) {submitted+=1;}else{adapted+=1;}
     }
     Ok(())
    })();lifecycle=device.close();outcome
   })();
   if result.is_err(){fault.store(true,Ordering::Release);}
   let count:u64=ages.iter().sum();let target=(count*95).div_ceil(100);let mut seen=0;
   let p95=ages.iter().position(|n|{seen+=n;count>0&&seen>=target});
   json!({"enabled":true,"resolution":{"width":640,"height":480},"pixel_format":"NV12 video range to I420","submitted":submitted,"sdk_adapted_or_rejected":adapted,"stale_discarded":stale,"maximum_capture_to_sdk_us":max_age,"capture_to_sdk_p95_ms_upper_bucket":p95,"capture_timestamp_domain":"AVCaptureSession synchronizationClock converted to CMClockGetHostTimeClock","sdk_video_timestamp_alignment":"SDK TimestampAligner still translates host capture timestamps; cross-media RTP alignment not qualified","lifecycle":lifecycle,"error":result.err().map(|e|e.to_string()),"video_recorded_by_native":false,"thread_joined":true,"av_sync_qualified":false})
  })?;
        Ok(Self {
            stop,
            failed,
            thread: Some(thread),
        })
    }
    pub fn shutdown(&mut self) -> serde_json::Value {
        self.stop.store(true, Ordering::Release);
        let start = Instant::now();
        let mut report = self
            .thread
            .take()
            .map(|t| {
                t.join().unwrap_or_else(
                    |_| json!({"error":"Camera thread panicked","thread_joined":true}),
                )
            })
            .unwrap_or_else(|| json!({"already_closed":true}));
        report["shutdown_ms"] = json!(start.elapsed().as_secs_f64() * 1000.0);
        report
    }
}
impl Drop for Publisher {
    fn drop(&mut self) {
        self.shutdown();
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn camera_nv12_planes_timestamps_and_bounded_retirement() {
        assert_eq!(unsafe { super::lab_camera_self_test() }, 1);
    }
}
