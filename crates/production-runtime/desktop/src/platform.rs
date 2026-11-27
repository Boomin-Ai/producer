use anyhow::{bail, Context, Result};
use objc2_core_foundation::CFRetained;
use objc2_core_video::CVPixelBuffer;
use producer_native_media::boundary::{
    OutputSize,
    audio_ring, AudioBlock, AudioConsumer, AudioProducer, AudioPushError, MediaFence, BLOCK_FRAMES,
};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    ptr::NonNull,
    sync::{
        atomic::{AtomicI64, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
};

#[repr(i32)]
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenCaptureTarget {
    Any = 0,
    Window = 1,
    Display = 2,
    Stop = 3,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct Draw {
    pub rect: [f32; 4],
    pub uv: [f32; 4],
    pub color: [f32; 4],
    pub color_to: [f32; 4],
    pub border: [f32; 4],
    /// radius, local width/height, inner border width, all output pixels.
    pub metrics: [f32; 4],
    /// gradient radians, grain strength, rotation radians, reserved.
    pub surface: [f32; 4],
    pub accent: [f32; 4],
    /// Material kind, halftone cell pixels, motion strength, continuous production time.
    pub material: [f32; 4],
    /// Relative RGB gains and saturation. All zeros preserve the source.
    pub clip_grade: [f32; 4],
    pub opacity: f32,
    pub kind: u32,
    pub source: u32,
    pub reserved: u32,
    pub group: u32,
}
impl Draw {
    pub fn solid(rect: [f32; 4], color: [f32; 4]) -> Self {
        Self {
            rect,
            uv: [0., 0., 1., 1.],
            color,
            color_to: color,
            border: [0.; 4],
            metrics: [0., 1., 1., 0.],
            surface: [0.; 4],
            accent: [0.; 4],
            material: [0.; 4],
            clip_grade: [0.; 4],
            opacity: 1.,
            kind: 0,
            source: 0,
            reserved: 0,
            group: 0,
        }
    }
}
#[repr(C)]
pub struct TextSpec {
    pub rgba: *const u8,
    pub value: *const c_char,
    pub width: u32,
    pub height: u32,
    pub font_size: f32,
    pub weight: u32,
    pub align: u32,
    pub single_line: u32,
}
#[repr(C)]
pub struct GraphSpec {
    pub geometry: *const c_char,
    pub source: *const c_char,
    pub entry: *const c_char,
    pub width: u32,
    pub height: u32,
    pub inputs: [i32; 2],
    pub params: [f32; 4],
    pub groups: u64,
}
/// Immutable GPU text resources, prepared on the control lane. Metal command
/// encoding retains textures until completion; swapping a scene never mutates
/// a texture referenced by an in-flight frame.
pub struct TextCache(NonNull<c_void>);
unsafe impl Send for TextCache {}
unsafe impl Sync for TextCache {}
impl TextCache {
    pub fn dj_title(value: &str) -> Result<Self> {
        let value=CString::new(value)?;
        Self::with_graphs(&[TextSpec {
            rgba:std::ptr::null(),value:value.as_ptr(),width:920,height:54,
            font_size:35.,weight:600,align:0,single_line:1,
        }],&[])
    }
    pub fn with_graphs(specs: &[TextSpec], graphs: &[GraphSpec]) -> Result<Self> {
        let mut error = [0i8; 1024];
        let ptr = unsafe { nr_text_cache(specs.as_ptr(), specs.len(), graphs.as_ptr(), graphs.len(),
            error.as_mut_ptr(), error.len()) };
        if ptr.is_null() && error[0] != 0 {
            bail!("Metal graph preparation: {}", unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy());
        }
        NonNull::new(ptr)
            .map(Self)
            .context("Text cache exceeds native budget or could not be prepared")
    }
}
impl Drop for TextCache {
    fn drop(&mut self) {
        unsafe { nr_text_cache_release(self.0.as_ptr()) }
    }
}
unsafe extern "C" {
    fn nr_device_registry_id(room: *mut c_void) -> u64;
    fn nr_create(
        ctx: *mut c_void,
        frame: extern "C" fn(*mut c_void, u32, *mut c_void, f64, u64),
        audio: extern "C" fn(*mut c_void, *const f32, u32, f64),
        status: extern "C" fn(*mut c_void, u32, *const c_char),
    ) -> *mut c_void;
    fn nr_camera_controls(id:*const c_char, control:i32, automatic:i32)->*mut c_char;
    fn nr_camera_effects();
    fn nr_cameras() -> *mut c_char;
    fn nr_camera_device(room: *mut c_void, id: *const c_char);
    fn nr_microphones() -> *mut c_char;
    fn nr_mic_device(room: *mut c_void, device: *const c_char);
    fn nr_input_create(
        ctx: *mut c_void,
        frame: extern "C" fn(*mut c_void, u32, *mut c_void, f64, u64),
        audio: extern "C" fn(*mut c_void, *const f32, u32, f64),
        status: extern "C" fn(*mut c_void, u32, *const c_char),
        mic: i32,
        device: *const c_char,
    ) -> *mut c_void;
    fn nr_input_stop(input: *mut c_void);
    fn nr_capture_stop(room: *mut c_void, source: i32);
    fn nr_capture(room: *mut c_void, camera: i32, screen: i32, mic: i32);
    fn nr_screen_capture(room: *mut c_void, target: i32);
    fn nr_stop(room: *mut c_void);
    fn nr_text_cache(text: *const TextSpec, count: usize, graphs: *const GraphSpec, graph_count:usize, error:*mut c_char, error_capacity:usize) -> *mut c_void;
    fn nr_text_cache_release(cache: *mut c_void);
    fn nr_prepare(room: *mut c_void, w0: u32, h0: u32, w1: u32, h1: u32) -> i32;
    fn CVPixelBufferGetWidth(buffer: *mut c_void) -> usize;
    fn CVPixelBufferGetHeight(buffer: *mut c_void) -> usize;
    fn nr_set_rehearsal_timing(handle: *mut c_void, active: bool);
    fn nr_rehearsal_timing(handle: *mut c_void, output: u32, generation: u64) -> *mut c_char;
    fn nr_render(
        room: *mut c_void,
        output: u32,
        w: u32,
        h: u32,
        draws: *const Draw,
        count: usize,
        sources: *mut *mut c_void,
        grades: *const [f32; 4],
        text: *mut c_void,
        dj_title: *mut c_void,
        pts: f64,
        generation: u64,
    ) -> i32;
    fn nr_record_start(
        room: *mut c_void,
        session: u64,
        origin: f64,
        tracks: *const NativeTrack,
        count: usize,
        callback: extern "C" fn(
            *mut c_void,
            u64,
            u32,
            u32,
            *const u8,
            usize,
            *const crate::recording::NativeSpan,
            usize,
        ) -> i32,
    ) -> i32;
    fn nr_record_stop(room: *mut c_void);
    fn nr_clip_preview(path:*const c_char)->bool;
    fn nr_clip_start(
        room: *mut c_void,
        session: u64,
        origin: f64,
        tracks: *const NativeTrack,
        count: usize,
        callback: extern "C" fn(
            *mut c_void,
            u64,
            u32,
            u32,
            *const u8,
            usize,
            *const crate::recording::NativeSpan,
            usize,
        ) -> i32,
    ) -> i32;
    fn nr_clip_stop(room: *mut c_void);
    fn nr_live_start(
        room: *mut c_void,
        session: u64,
        origin: f64,
        tracks: *const NativeTrack,
        count: usize,
        callback: extern "C" fn(
            *mut c_void,
            u64,
            u32,
            u32,
            *const u8,
            usize,
            *const crate::recording::NativeSpan,
            usize,
        ) -> i32,
    ) -> i32;
    fn nr_live_stop(room: *mut c_void);
    fn nr_record_audio(
        room: *mut c_void,
        samples: *const f32,
        original: *const f32,
        frames: u32,
        pts: f64,
    );
    fn nr_movie_open(path: *const c_char, duration: *mut f64) -> *mut c_void;
    fn nr_movie_frame(movie: *mut c_void, at: f64, generation: u64) -> *mut c_void;
    fn nr_movie_cancel(movie: *mut c_void);
    fn nr_movie_start(movie: *mut c_void) -> f64;
    fn nr_audio_start(audio: *mut c_void) -> f64;
    fn nr_movie_close(movie: *mut c_void);
    fn nr_audio_open(path: *const c_char) -> *mut c_void;
    fn nr_audio_read(
        handle: *mut c_void,
        at: f64,
        generation: u64,
        out: *mut f32,
        frames: u32,
    ) -> i32;
    fn nr_audio_close(handle: *mut c_void);
    fn nr_host_time() -> f64;
    fn CFRetain(value: *const c_void) -> *const c_void;
    fn CFRelease(value: *const c_void);
}
pub fn cameras() -> serde_json::Value {
    unsafe {
        let ptr = nr_cameras();
        if ptr.is_null() {
            return serde_json::json!([]);
        }
        let json = serde_json::from_slice(CStr::from_ptr(ptr).to_bytes())
            .unwrap_or_else(|_| serde_json::json!([]));
        libc::free(ptr.cast());
        json
    }
}
pub fn camera_controls(id:&str,control:i32,value:i32)->serde_json::Value {
    let Ok(id)=CString::new(id) else{return serde_json::Value::Null};
    unsafe {
        let ptr=nr_camera_controls(id.as_ptr(),control,value);
        if ptr.is_null(){return serde_json::Value::Null;}
        let info=serde_json::from_slice(CStr::from_ptr(ptr).to_bytes()).unwrap_or_default();
        libc::free(ptr.cast());info
    }
}
pub fn camera_effects(){unsafe{nr_camera_effects()}}
pub fn microphones() -> serde_json::Value {
    unsafe {
        let ptr = nr_microphones();
        if ptr.is_null() {
            return serde_json::json!([]);
        }
        let json = serde_json::from_slice(CStr::from_ptr(ptr).to_bytes())
            .unwrap_or_else(|_| serde_json::json!([]));
        libc::free(ptr.cast());
        json
    }
}
pub fn host_time() -> f64 {
    unsafe { nr_host_time() }
}
/// Immutable once published; retained buffers cannot be recycled into the native pool.
pub struct Frame {
    pub ptr: NonNull<c_void>,
    pub at: f64,
    pub generation: u64,
    pub width: usize,
    pub height: usize,
}
unsafe impl Send for Frame {}
unsafe impl Sync for Frame {}
impl Drop for Frame {
    fn drop(&mut self) {
        unsafe {
            CFRelease(self.ptr.as_ptr());
        }
    }
}
impl Frame {
    pub fn stage(nv12:&[u8],width:usize,height:usize)->Option<Self>{
        extern "C" {fn nr_stage_surface(bytes:*const u8,w:usize,h:usize)->*mut c_void;}
        if !(2..=640).contains(&width)||!(2..=360).contains(&height)||(width|height)%2!=0||nv12.len()!=width*height*3/2{return None;}
        let ptr=NonNull::new(unsafe{nr_stage_surface(nv12.as_ptr(),width,height)})?;
        Some(Self{ptr,at:host_time(),generation:0,width,height})
    }
    pub fn guest(bgra: &[u8], width: usize, height: usize) -> Option<Self> {
        extern "C" { fn nr_p0_guest_surface(bytes: *const u8, width: usize, height: usize) -> *mut c_void; }
        if !(1..=640).contains(&width) || !(1..=360).contains(&height) || bgra.len()!=width*height*4{return None;}
        let ptr = NonNull::new(unsafe { nr_p0_guest_surface(bgra.as_ptr(),width,height) })?;
        Some(Self { ptr, at: host_time(), generation: 0, width, height })
    }

    unsafe fn retained(ptr: *mut c_void, at: f64, generation: u64) -> Self {
        CFRetain(ptr);
        Self {
            ptr: NonNull::new_unchecked(ptr),
            at,
            generation,
            width: CVPixelBufferGetWidth(ptr),
            height: CVPixelBufferGetHeight(ptr),
        }
    }
    pub fn surface(&self) -> CFRetained<CVPixelBuffer> {
        unsafe { CFRetained::retain(self.ptr.cast()) }
    }
}
#[repr(C)]
pub struct NativeTrack {
    pub width: u32,
    pub height: u32,
    pub kind: u32,
}
/// Opt-in completion mailbox for private rendered pictures. Program output never waits on it.
#[derive(Default)]
pub(crate) struct PosterFrames {
    frames: Mutex<[Option<Arc<Frame>>; 2]>,
    completed: Condvar,
}

impl PosterFrames {
    pub(crate) fn wait(&self, output: usize, generation: u64, submitted: f64) -> Result<Arc<Frame>> {
        let matches = |f: &Frame| f.generation == generation && f.at == submitted;
        let (mut frames, _) = self.completed.wait_timeout_while(
            self.frames.lock().unwrap(),
            std::time::Duration::from_secs(4),
            |frames| !frames[output].as_deref().is_some_and(matches),
        ).unwrap();
        anyhow::ensure!(frames[output].as_deref().is_some_and(matches), "Output timed out");
        Ok(frames[output].take().expect("matched private output"))
    }
}

pub struct Shared {
    pub extra_frames: [Mutex<Option<Arc<Frame>>>; 4],
    pub recorder: crate::recording::Recorder,
    pub broadcast:crate::broadcast::Broadcast,
    pub clips:crate::clips::Clips,
    pub frames: [Mutex<Option<Arc<Frame>>>; 5],
    pub(crate) poster_frames: OnceLock<PosterFrames>,
    // Access each timestamp under its corresponding program frame slot lock.
    pub first_revision_at: [AtomicU64; 2],
    pub statuses: [Mutex<String>; 10],
    pub counts: [AtomicU64; 5],
    // Only serial native mic callbacks access this endpoint. The mixer owns a
    // separate consumer; it never acquires this guard. Keep safe Rust protection
    // against accidental reentrant callbacks without a blocking callback wait.
    audio_producer: Mutex<AudioProducer>,
    pub audio_frames: AtomicU64,
    pub audio_dropped: AtomicU64,
    audio_rejections: [AtomicU64; 6],
    timestamp_discontinuities: AtomicU64,
    timestamp_min_delta: AtomicI64,
    timestamp_max_delta: AtomicI64,
    audio_end: AtomicI64,
    pub mic_peak: AtomicU64,
    pub origin: f64,
    pub fence: MediaFence,
}
impl Shared {
    fn new() -> Result<(Self, AudioConsumer)> {
        let fence = MediaFence {
            execution: 1,
            epoch: 1,
            source_incarnation: 1,
            request: 1,
        };
        let (producer, consumer) = audio_ring(fence, 32).unwrap();
        Ok((
            Self {
                extra_frames: std::array::from_fn(|_| Mutex::new(None)),
                recorder: crate::recording::Recorder::new()?,
                broadcast:Default::default(),
                clips:Default::default(),
                frames: std::array::from_fn(|_| Mutex::new(None)),
                poster_frames: OnceLock::new(),
                statuses: std::array::from_fn(|_| Mutex::new(String::new())),
                first_revision_at: Default::default(),
                counts: std::array::from_fn(|_| AtomicU64::new(0)),
                audio_producer: Mutex::new(producer),
                audio_frames: AtomicU64::new(0),
                audio_dropped: AtomicU64::new(0),
                audio_rejections: std::array::from_fn(|_| AtomicU64::new(0)),
                timestamp_discontinuities: AtomicU64::new(0),
                timestamp_min_delta: AtomicI64::new(0),
                timestamp_max_delta: AtomicI64::new(0),
                audio_end: AtomicI64::new(i64::MIN),
                mic_peak: AtomicU64::new(0),
                origin: host_time(),
                fence,
            },
            consumer,
        ))
    }
    pub fn mic_ready(&self) -> bool {
        let end = self.audio_end.load(Ordering::Relaxed);
        end > 0 && ((host_time() - self.origin) * 48000. - end as f64).abs() < 24000.
    }
    pub fn frame(&self, index: usize) -> Option<Arc<Frame>> {
        // A frame being published is still a live source. Clone its retained
        // surface rather than treating a busy slot as an empty camera.
        self.frames[index].lock().unwrap().clone()
    }
    pub fn audio_diagnostics(&self) -> AudioDiagnostics {
        let r = self
            .audio_rejections
            .each_ref()
            .map(|v| v.load(Ordering::Relaxed));
        AudioDiagnostics {
            contended_frames: r[0],
            full_frames: r[1],
            overlap_frames: r[2],
            superseded_frames: r[3],
            invalid_frames: r[4],
            clock_overflow_frames: r[5],
            timestamp_discontinuities: self.timestamp_discontinuities.load(Ordering::Relaxed),
            timestamp_min_delta: self.timestamp_min_delta.load(Ordering::Relaxed),
            timestamp_max_delta: self.timestamp_max_delta.load(Ordering::Relaxed),
            ..Default::default()
        }
    }
    pub fn status(&self, index: usize) -> String {
        self.statuses[index]
            .try_lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }
    pub fn set_status(&self, index: usize, text: String) {
        if let Ok(mut s) = self.statuses[index].try_lock() {
            *s = text;
        }
    }
}
#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDiagnostics {
    pub contended_frames: u64,
    pub full_frames: u64,
    pub overlap_frames: u64,
    pub superseded_frames: u64,
    pub invalid_frames: u64,
    pub clock_overflow_frames: u64,
    pub timestamp_discontinuities: u64,
    pub timestamp_min_delta: i64,
    pub timestamp_max_delta: i64,
    pub mix_contended_blocks: u64,
    pub mix_missing_frames: u64,
    pub clock_skipped_frames: u64,
}
extern "C" fn segment_callback(
    ctx: *mut c_void,
    session: u64,
    track: u32,
    kind: u32,
    data: *const u8,
    len: usize,
    spans: *const crate::recording::NativeSpan,
    count: usize,
) -> i32 {
    if len > producer_native_media::recording::MAX_SEGMENT_BYTES
        || count > 2
        || (len > 0 && data.is_null())
        || (count > 0 && spans.is_null())
    {
        return 0;
    }
    let shared = unsafe { &*(ctx as *const Shared) };
    let bytes = if len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(data, len) }
    };
    let mut times = [crate::recording::NativeSpan::default(); 2];
    if count > 0 {
        times[..count].copy_from_slice(unsafe { std::slice::from_raw_parts(spans, count) });
    }
    shared
        .recorder
        .event(session, track, kind, bytes, times, count) as i32
}
pub fn preview_clip(path:&std::path::Path)->Result<()>{
    let path=CString::new(path.as_os_str().as_encoded_bytes())?;
    anyhow::ensure!(unsafe{nr_clip_preview(path.as_ptr())},"Could not preview the saved clip");
    Ok(())
}
extern "C" fn clip_segment_callback(
    ctx:*mut c_void,session:u64,track:u32,kind:u32,data:*const u8,len:usize,
    spans:*const crate::recording::NativeSpan,count:usize,
)->i32{
    if len>producer_native_media::recording::MAX_SEGMENT_BYTES || count>2
        || (len>0 && data.is_null()) || (count>0 && spans.is_null()){return 0}
    let shared=unsafe{&*(ctx as *const Shared)};
    let bytes=if len==0 {&[]}else{unsafe{std::slice::from_raw_parts(data,len)}};
    let times=if count==0 {&[]}else{unsafe{std::slice::from_raw_parts(spans,count)}};
    shared.clips.event(session,track,kind,bytes,times) as i32
}
extern "C" fn live_segment_callback(ctx:*mut c_void,session:u64,track:u32,kind:u32,data:*const u8,len:usize,_spans:*const crate::recording::NativeSpan,_count:usize)->i32{
    if len>producer_native_media::recording::MAX_SEGMENT_BYTES || (len>0 && data.is_null()){return 0}
    let shared=unsafe{&*(ctx as *const Shared)};
    let bytes=if len==0{&[]}else{unsafe{std::slice::from_raw_parts(data,len)}};
    shared.broadcast.event(session,track as usize,kind,bytes);
    1
}
extern "C" fn frame_callback(
    ctx: *mut c_void,
    source: u32,
    buffer: *mut c_void,
    at: f64,
    generation: u64,
) {
    if buffer.is_null() {
        if source == 1 {
            let shared = unsafe { &*(ctx as *const Shared) };
            let previous = shared.frames[1].lock().unwrap().take();
            drop(previous);
        }
        return;
    }
    let shared = unsafe { &*(ctx as *const Shared) };
    let index = match source {
        0..=2 => source as usize,
        10..=11 => source as usize - 7,
        _ => return,
    };
    // Core Video retain, buffer queries, and release stay outside the slot lock.
    let frame = Arc::new(unsafe { Frame::retained(buffer, at, generation) });
    if index >= 3 {
        if let Some(private) = shared.poster_frames.get() {
            let mut slots = private.frames.lock().unwrap();
            // A delayed previous readback cannot replace a newer private picture.
            if slots[index - 3].as_ref().is_none_or(|old| old.at <= frame.at) {
                slots[index - 3] = Some(frame.clone());
                private.completed.notify_one();
            }
        }
    }
    if let Ok(mut slot) = shared.frames[index].try_lock() {
        if index >= 3 && slot.as_ref().map(|f| f.generation) != Some(generation) {
            shared.first_revision_at[index - 3].store(host_time().to_bits(), Ordering::Relaxed);
        }
        let previous = slot.replace(frame);
        shared.counts[index].fetch_add(1, Ordering::Relaxed);
        drop(slot);
        drop(previous);
    }
}
// AVFoundation's resampled PTS can round to either side of an integral sample
// boundary. Preserve continuous samples within that quantization tolerance;
// real gaps/discontinuities retain their host-clock positions.
fn align_audio_start(raw: i64, previous_end: i64) -> i64 {
    if raw.abs_diff(previous_end) <= 2 {
        previous_end
    } else {
        raw
    }
}

// The host clock conversion can overlap a few PCM samples at a buffer seam.
// Skip only samples already on the timeline so the ring keeps the rest.
fn trim_capture_overlap(start: i64, previous_end: i64, frames: u32) -> usize {
    previous_end.saturating_sub(start).clamp(0, i64::from(frames)) as usize
}

extern "C" fn audio_callback(ctx: *mut c_void, samples: *const f32, frames: u32, at: f64) {
    if samples.is_null() || frames == 0 || frames > 8192 {
        return;
    }
    let shared = unsafe { &*(ctx as *const Shared) };
    let samples = unsafe { std::slice::from_raw_parts(samples, frames as usize * 2) };
    let Ok(mut producer) = shared.audio_producer.try_lock() else {
        shared
            .audio_dropped
            .fetch_add(frames as u64, Ordering::Relaxed);
        shared.audio_rejections[0].fetch_add(frames as u64, Ordering::Relaxed);
        return;
    };
    let raw = ((at - shared.origin) * 48000.).round() as i64 - frames as i64;
    let end = shared.audio_end.load(Ordering::Relaxed);
    if end != i64::MIN {
        let delta = raw.saturating_sub(end);
        shared
            .timestamp_min_delta
            .fetch_min(delta, Ordering::Relaxed);
        shared
            .timestamp_max_delta
            .fetch_max(delta, Ordering::Relaxed);
        if delta.abs_diff(0) > 2 {
            shared
                .timestamp_discontinuities
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    let start = align_audio_start(raw, end);
    let mut offset = trim_capture_overlap(start, end, frames);
    shared
        .audio_end
        .store(end.max(start + frames as i64), Ordering::Relaxed);
    if offset != 0 {
        shared.audio_dropped.fetch_add(offset as u64, Ordering::Relaxed);
        shared.audio_rejections[2].fetch_add(offset as u64, Ordering::Relaxed);
    }
    let mut peak = 0f32;
    while offset < frames as usize {
        let n = (frames as usize - offset).min(BLOCK_FRAMES);
        let mut b = AudioBlock::silence(shared.fence, start + offset as i64);
        b.frames = n;
        for (i, &v) in samples[offset * 2..(offset + n) * 2].iter().enumerate() {
            let v = if v.is_finite() { v.clamp(-1., 1.) } else { 0. };
            b.samples[i] = v;
            peak = peak.max(v.abs());
        }
        if let Err(error) = producer.push(&b) {
            shared.audio_dropped.fetch_add(n as u64, Ordering::Relaxed);
            let reason = match error {
                AudioPushError::Contended => 0,
                AudioPushError::Full => 1,
                AudioPushError::Overlap => 2,
                AudioPushError::Superseded => 3,
                AudioPushError::Invalid => 4,
                AudioPushError::ClockOverflow => 5,
            };
            shared.audio_rejections[reason].fetch_add(n as u64, Ordering::Relaxed);
        }
        offset += n;
    }
    shared
        .mic_peak
        .store((peak * 1000.) as u64, Ordering::Relaxed);
    shared
        .audio_frames
        .fetch_add(frames as u64, Ordering::Relaxed);
}

pub struct InputShared {
    pub frame: Mutex<Option<Arc<Frame>>>,
    pub status: Mutex<String>,
    pub count: AtomicU64,
    audio_producer: Mutex<AudioProducer>,
    pub audio_frames: AtomicU64,
    pub audio_dropped: AtomicU64,
    audio_rejections: [AtomicU64; 6],
    timestamp_discontinuities: AtomicU64,
    timestamp_min_delta: AtomicI64,
    timestamp_max_delta: AtomicI64,
    audio_end: AtomicI64,
    pub mic_peak: AtomicU64,
    pub origin: f64,
    pub fence: MediaFence,
}
pub struct CaptureInput {
    ptr: NonNull<c_void>,
    pub shared: Arc<InputShared>,
    pub audio: AudioConsumer,
}
// Endpoints are used by the serial media worker; callbacks only access Shared.
unsafe impl Send for CaptureInput {}
impl CaptureInput {
    pub fn new(mic: bool, device: &str, origin: f64) -> Result<Self> {
        let fence = MediaFence {
            execution: 1,
            epoch: 1,
            source_incarnation: 1,
            request: 1,
        };
        let (producer, audio) = audio_ring(fence, 32).unwrap();
        let shared = Arc::new(InputShared {
            frame: Mutex::new(None),
            status: Mutex::new("Starting device".into()),
            count: AtomicU64::new(0),
            audio_producer: Mutex::new(producer),
            audio_frames: AtomicU64::new(0),
            audio_dropped: AtomicU64::new(0),
            audio_rejections: std::array::from_fn(|_| AtomicU64::new(0)),
            timestamp_discontinuities: AtomicU64::new(0),
            timestamp_min_delta: AtomicI64::new(0),
            timestamp_max_delta: AtomicI64::new(0),
            audio_end: AtomicI64::new(i64::MIN),
            mic_peak: AtomicU64::new(0),
            origin,
            fence,
        });
        let device = CString::new(device)?;
        let ptr = NonNull::new(unsafe {
            nr_input_create(
                Arc::as_ptr(&shared) as *mut c_void,
                input_frame_callback,
                input_audio_callback,
                input_status_callback,
                mic as i32,
                device.as_ptr(),
            )
        })
        .context("Could not start capture endpoint")?;
        Ok(Self { ptr, shared, audio })
    }
    pub fn start_camera(&self) {
        unsafe { nr_capture(self.ptr.as_ptr(), 1, 0, 0) }
    }
    pub fn frame(&self) -> Option<Arc<Frame>> {
        self.shared.frame.lock().unwrap().clone()
    }
}
impl Drop for CaptureInput {
    fn drop(&mut self) {
        unsafe {
            nr_input_stop(self.ptr.as_ptr());
        }
    }
}
extern "C" fn input_frame_callback(
    ctx: *mut c_void,
    _source: u32,
    buffer: *mut c_void,
    at: f64,
    generation: u64,
) {
    if buffer.is_null() {
        return;
    }
    let s = unsafe { &*(ctx as *const InputShared) };
    let frame = Arc::new(unsafe { Frame::retained(buffer, at, generation) });
    if let Ok(mut slot) = s.frame.try_lock() {
        let previous = slot.replace(frame);
        s.count.fetch_add(1, Ordering::Relaxed);
        drop(slot);
        drop(previous);
    }
}
extern "C" fn input_status_callback(ctx: *mut c_void, _source: u32, text: *const c_char) {
    if text.is_null() {
        return;
    }
    let s = unsafe { &*(ctx as *const InputShared) };
    if let Ok(mut slot) = s.status.try_lock() {
        *slot = unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .chars()
            .take(400)
            .collect();
    }
}
extern "C" fn input_audio_callback(ctx: *mut c_void, samples: *const f32, frames: u32, at: f64) {
    if samples.is_null() || frames == 0 || frames > 8192 {
        return;
    }
    let shared = unsafe { &*(ctx as *const InputShared) };
    let samples = unsafe { std::slice::from_raw_parts(samples, frames as usize * 2) };
    let Ok(mut producer) = shared.audio_producer.try_lock() else {
        shared
            .audio_dropped
            .fetch_add(frames as u64, Ordering::Relaxed);
        shared.audio_rejections[0].fetch_add(frames as u64, Ordering::Relaxed);
        return;
    };
    let raw = ((at - shared.origin) * 48000.).round() as i64 - frames as i64;
    let end = shared.audio_end.load(Ordering::Relaxed);
    if end != i64::MIN {
        let delta = raw.saturating_sub(end);
        shared
            .timestamp_min_delta
            .fetch_min(delta, Ordering::Relaxed);
        shared
            .timestamp_max_delta
            .fetch_max(delta, Ordering::Relaxed);
        if delta.abs_diff(0) > 2 {
            shared
                .timestamp_discontinuities
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    let start = align_audio_start(raw, end);
    let mut offset = trim_capture_overlap(start, end, frames);
    shared
        .audio_end
        .store(end.max(start + frames as i64), Ordering::Relaxed);
    if offset != 0 {
        shared.audio_dropped.fetch_add(offset as u64, Ordering::Relaxed);
        shared.audio_rejections[2].fetch_add(offset as u64, Ordering::Relaxed);
    }
    let mut peak = 0f32;
    while offset < frames as usize {
        let n = (frames as usize - offset).min(BLOCK_FRAMES);
        let mut b = AudioBlock::silence(shared.fence, start + offset as i64);
        b.frames = n;
        for (i, &v) in samples[offset * 2..(offset + n) * 2].iter().enumerate() {
            let v = if v.is_finite() { v.clamp(-1., 1.) } else { 0. };
            b.samples[i] = v;
            peak = peak.max(v.abs());
        }
        if let Err(error) = producer.push(&b) {
            shared.audio_dropped.fetch_add(n as u64, Ordering::Relaxed);
            let reason = match error {
                AudioPushError::Contended => 0,
                AudioPushError::Full => 1,
                AudioPushError::Overlap => 2,
                AudioPushError::Superseded => 3,
                AudioPushError::Invalid => 4,
                AudioPushError::ClockOverflow => 5,
            };
            shared.audio_rejections[reason].fetch_add(n as u64, Ordering::Relaxed);
        }
        offset += n;
    }
    shared
        .mic_peak
        .store((peak * 1000.) as u64, Ordering::Relaxed);
    shared
        .audio_frames
        .fetch_add(frames as u64, Ordering::Relaxed);
}
extern "C" fn status_callback(ctx: *mut c_void, index: u32, text: *const c_char) {
    if index >= 10 || text.is_null() {
        return;
    }
    let shared = unsafe { &*(ctx as *const Shared) };
    shared.set_status(
        index as usize,
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .chars()
            .take(400)
            .collect(),
    );
}
// Submissions share immutable pool configuration. Resize and teardown take exclusive ownership.
struct RenderHandle(NonNull<c_void>);
unsafe impl Send for RenderHandle {}
unsafe impl Sync for RenderHandle {}
pub type GradeSlots = Arc<std::sync::RwLock<[[f32; 4]; 8]>>;
#[derive(Clone)]
pub struct RenderTarget(Arc<std::sync::RwLock<Option<RenderHandle>>>, GradeSlots);
impl RenderTarget {
    pub fn set_grades(&mut self, grades: GradeSlots) { self.1 = grades; }
    pub fn render(
        &self,
        output: usize,
        w: u32,
        h: u32,
        draws: &[Draw],
        frames: &[Option<Arc<Frame>>; 8],
        text: &TextCache,
        at: f64,
        revision: u64,
    ) -> bool {
        self.render_with_dj(output,w,h,draws,frames,text,None,at,revision)
    }
    pub fn render_with_dj(
        &self,
        output: usize,
        w: u32,
        h: u32,
        draws: &[Draw],
        frames: &[Option<Arc<Frame>>; 8],
        text: &TextCache,
        dj_title: Option<&TextCache>,
        at: f64,
        revision: u64,
    ) -> bool {
        let target = self.0.read().unwrap();
        let Some(handle) = target.as_ref() else { return false };
        let mut ptrs = frames
            .each_ref()
            .map(|f| f.as_ref().map_or(std::ptr::null_mut(), |f| f.ptr.as_ptr()));
        let grades = *self.1.read().unwrap();
        unsafe {
            nr_render(
                handle.0.as_ptr(),
                output as u32,
                w,
                h,
                draws.as_ptr(),
                draws.len(),
                ptrs.as_mut_ptr(),
                grades.as_ptr(),
                text.0.as_ptr(),
                dj_title.map_or(std::ptr::null_mut(),|t|t.0.as_ptr()),
                at,
                revision,
            ) != 0
        }
    }
}

pub struct NativeRoom {
    pub target: RenderTarget,
    ptr: NonNull<c_void>,
    context: *const Shared,
    pub shared: Arc<Shared>,
    pub audio: AudioConsumer,
}
unsafe impl Send for NativeRoom {}
impl NativeRoom {
    pub(crate) fn set_rehearsal_timing(&mut self, active: bool) {
        unsafe { nr_set_rehearsal_timing(self.ptr.as_ptr(),active) }
    }

    pub(crate) fn rehearsal_timing(&self, output: u32, generation: u64) -> Result<serde_json::Value> {
        unsafe {
            let ptr = nr_rehearsal_timing(self.ptr.as_ptr(), output, generation);
            anyhow::ensure!(!ptr.is_null(), "Missing rehearsal timing receipt");
            let parsed = serde_json::from_slice(CStr::from_ptr(ptr).to_bytes());
            libc::free(ptr.cast());
            Ok(parsed?)
        }
    }

    pub fn device_registry_id(&self) -> u64 {
        unsafe { nr_device_registry_id(self.ptr.as_ptr()) }
    }

    pub fn new() -> Result<Self> {
        let (shared, audio) = Shared::new()?;
        let shared = Arc::new(shared);
        let context = Arc::into_raw(shared.clone());
        let ptr = unsafe {
            nr_create(
                context as *mut _,
                frame_callback,
                audio_callback,
                status_callback,
            )
        };
        let Some(ptr) = NonNull::new(ptr) else {
            unsafe {
                drop(Arc::from_raw(context));
            }
            bail!("Native Metal renderer could not start");
        };
        Ok(Self {
            target: RenderTarget(Arc::new(std::sync::RwLock::new(Some(RenderHandle(ptr)))), Default::default()),
            ptr,
            context,
            shared,
            audio,
        })
    }
    pub fn prepare(&self, sizes: [producer_native_media::boundary::OutputSize; 2]) -> Result<()> {
        let _gate = self.target.0.write().unwrap();
        if unsafe {
            nr_prepare(
                self.ptr.as_ptr(),
                sizes[0].width,
                sizes[0].height,
                sizes[1].width,
                sizes[1].height,
            )
        } == 0
        {
            bail!("Output allocation refused; previous GPU output retained");
        }
        Ok(())
    }
    pub fn camera_device(&self, id: &str) -> Result<()> {
        let id = CString::new(id)?;
        let previous = self.shared.frames[0].lock().unwrap().take();
        drop(previous);
        unsafe {
            nr_camera_device(self.ptr.as_ptr(), id.as_ptr());
        }
        Ok(())
    }
    pub fn microphone_device(&self, id: &str) -> Result<()> {
        let id = CString::new(id)?;
        unsafe {
            nr_mic_device(self.ptr.as_ptr(), id.as_ptr());
        }
        Ok(())
    }
    pub fn stop_capture(&self, source: i32) {
        unsafe {
            nr_capture_stop(self.ptr.as_ptr(), source);
        }
    }
    pub fn capture(&self, camera: bool, screen: bool, mic: bool) {
        unsafe {
            nr_capture(self.ptr.as_ptr(), camera as i32, screen as i32, mic as i32);
        }
    }
    pub fn screen_capture(&self, target: ScreenCaptureTarget) {
        unsafe { nr_screen_capture(self.ptr.as_ptr(), target as i32) };
    }
    pub fn record(
        &self,
        session: u64,
        header: &producer_native_media::recording::RecordingHeader,
    ) -> Result<()> {
        let tracks = header
            .tracks
            .iter()
            .map(|t| NativeTrack {
                width: t.width,
                height: t.height,
                kind: match t.source.as_str() {
                    "program-landscape" => 0,
                    "program-vertical" => 1,
                    "camera" => 2,
                    "screen" => 3,
                    "microphone" => 4,
                    _ => unreachable!(),
                },
            })
            .collect::<Vec<_>>();
        if unsafe {
            nr_record_start(
                self.ptr.as_ptr(),
                session,
                header.host_origin_ns as f64 / 1e9,
                tracks.as_ptr(),
                tracks.len(),
                segment_callback,
            )
        } == 0
        {
            anyhow::bail!("Native recording setup refused");
        }
        Ok(())
    }
    pub fn start_broadcast(&self,epoch:u64,outputs:&[usize],sizes:[OutputSize;2])->Result<()>{
        let tracks:Vec<_>=outputs.iter().map(|&i| NativeTrack{width:sizes[i].width,height:sizes[i].height,kind:i as u32}).collect();
        anyhow::ensure!(unsafe{nr_live_start(self.ptr.as_ptr(),epoch,host_time(),tracks.as_ptr(),tracks.len(),live_segment_callback)}!=0,"Program encoder unavailable");
        Ok(())
    }
    pub fn stop_broadcast(&self){unsafe{nr_live_stop(self.ptr.as_ptr());}}
    pub fn start_clips(&self,session:u64,settings:crate::clips::Settings,sizes:[OutputSize;2])->Result<()>{
        let tracks=settings.output.tracks().iter().map(|source|{
            let kind=usize::from(*source=="program-vertical");
            NativeTrack{width:sizes[kind].width,height:sizes[kind].height,kind:kind as u32}
        }).collect::<Vec<_>>();
        let accepted=unsafe{nr_clip_start(self.ptr.as_ptr(),session,host_time(),tracks.as_ptr(),tracks.len(),clip_segment_callback)};
        anyhow::ensure!(accepted!=0,"Clip encoder setup refused");
        Ok(())
    }
    pub fn stop_clips(&self){
        unsafe{nr_clip_stop(self.ptr.as_ptr());}
    }
    pub fn stop_record(&self) {
        self.shared.recorder.finalizing();
        unsafe {
            nr_record_stop(self.ptr.as_ptr());
        }
    }
    pub fn audio(&self, samples: &[f32], original: &[f32], at: f64) {
        unsafe {
            nr_record_audio(
                self.ptr.as_ptr(),
                samples.as_ptr(),
                original.as_ptr(),
                (samples.len() / 2) as u32,
                at,
            );
        }
    }
}
impl Drop for NativeRoom {
    fn drop(&mut self) {
        self.target.0.write().unwrap().take();
        unsafe {
            nr_stop(self.ptr.as_ptr());
            drop(Arc::from_raw(self.context));
        }
    }
}
pub struct Movie {
    ptr: NonNull<c_void>,
    pub duration: f64,
    pub start: f64,
}
unsafe impl Send for Movie {}
impl Movie {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let path = CString::new(
            path.to_str()
                .ok_or_else(|| anyhow::anyhow!("UTF8 movie path"))?,
        )?;
        let mut duration = 0.;
        let ptr = unsafe { nr_movie_open(path.as_ptr(), &mut duration) };
        let Some(ptr) = NonNull::new(ptr) else {
            bail!("MOV has no readable video track");
        };
        let start = unsafe { nr_movie_start(ptr.as_ptr()) };
        if !start.is_finite() || start < 0. || start >= duration {
            bail!("Invalid video track time range");
        }
        Ok(Self {
            ptr,
            duration,
            start,
        })
    }
    pub fn frame(&mut self, at: f64, generation: u64) -> Option<Arc<Frame>> {
        let ptr = unsafe { nr_movie_frame(self.ptr.as_ptr(), at, generation) };
        NonNull::new(ptr).map(|ptr| {
            Arc::new(Frame {
                ptr,
                at: host_time(),
                generation,
                width: unsafe { CVPixelBufferGetWidth(ptr.as_ptr()) },
                height: unsafe { CVPixelBufferGetHeight(ptr.as_ptr()) },
            })
        })
    }
    pub fn cancel(&self) {
        unsafe {
            nr_movie_cancel(self.ptr.as_ptr());
        }
    }
}
impl Drop for Movie {
    fn drop(&mut self) {
        unsafe {
            nr_movie_close(self.ptr.as_ptr());
        }
    }
}

pub struct MovieAudio {
    ptr: NonNull<c_void>,
    pub start: f64,
}
unsafe impl Send for MovieAudio {}
impl MovieAudio {
    pub fn open(path: &std::path::Path) -> Option<Self> {
        let p = CString::new(path.to_str()?).ok()?;
        NonNull::new(unsafe { nr_audio_open(p.as_ptr()) }).map(|ptr| Self {
            ptr,
            start: unsafe { nr_audio_start(ptr.as_ptr()) },
        })
    }
    pub fn read(
        &mut self,
        at: f64,
        generation: u64,
        samples: &mut [f32; producer_native_media::boundary::BLOCK_SAMPLES],
    ) -> usize {
        unsafe {
            nr_audio_read(self.ptr.as_ptr(), at, generation, samples.as_mut_ptr(), 480).max(0)
                as usize
        }
    }
}
impl Drop for MovieAudio {
    fn drop(&mut self) {
        unsafe {
            nr_audio_close(self.ptr.as_ptr());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{align_audio_start, trim_capture_overlap, Frame, Shared};
    use std::{sync::{mpsc, Arc}, thread, time::Duration};

    #[test]
    fn camera_grade_changes_only_the_selected_source_pixels() {
        use super::{Draw, NativeRoom, OutputSize, TextCache};
        use std::{ffi::c_void, time::Instant};
        unsafe extern "C" {
            fn CVPixelBufferLockBaseAddress(buffer: *mut c_void, flags: usize) -> i32;
            fn CVPixelBufferUnlockBaseAddress(buffer: *mut c_void, flags: usize) -> i32;
            fn CVPixelBufferGetBaseAddressOfPlane(buffer: *mut c_void, plane: usize) -> *const u8;
        }
        let mut native = NativeRoom::new().unwrap();
        let size = OutputSize { width: 128, height: 64 };
        native.prepare([size, size]).unwrap();
        let grades = super::GradeSlots::default();
        native.target.set_grades(grades.clone());
        let cache = TextCache::with_graphs(&[], &[]).unwrap();
        let source = Arc::new(Frame::guest(&[40, 64, 128, 255].repeat(64), 8, 8).unwrap());
        let mut frames = std::array::from_fn(|_| None);
        frames[0] = Some(source.clone());
        frames[4] = Some(source);
        let mut draws = [Draw::solid([0.,0.,0.5,1.], [1.;4]); 2];
        for (i, draw) in draws.iter_mut().enumerate() {
            draw.kind = 1;
            draw.source = (i * 4) as u32;
            draw.rect[0] = i as f32 * 0.5;
            draw.metrics = [0.,64.,64.,0.];
        }
        for (generation, ev) in [(1, 0.), (2, 1.), (3, 0.)] {
            grades.write().unwrap()[4][0] = ev;
            assert!(native.target.render(0,128,64,&draws,&frames,&cache,super::host_time(),generation));
            let start = Instant::now();
            let frame = loop {
                if let Some(frame) = native.shared.frame(3).filter(|f| f.generation == generation) { break frame; }
                assert!(start.elapsed() < Duration::from_secs(5));
                thread::sleep(Duration::from_millis(5));
            };
            unsafe {
                let pixel = frame.ptr.as_ptr();
                assert_eq!(CVPixelBufferLockBaseAddress(pixel, 1), 0);
                let y = CVPixelBufferGetBaseAddressOfPlane(pixel, 0);
                let (left, right) = (*y.add(32), *y.add(96));
                CVPixelBufferUnlockBaseAddress(pixel, 1);
                assert!(left > 40, "Source missing");
                if ev == 0. { assert_eq!(left, right); } else { assert!(right > left + 12); }
            }
        }
    }

    #[test]
    fn camera_read_keeps_a_picture_while_capture_publishes() {
        let (shared, _) = Shared::new().unwrap();
        assert!(shared.frame(0).is_none());
        let picture = Arc::new(Frame::guest(&[255; 64], 4, 4).unwrap());
        let mut slot = shared.frames[0].lock().unwrap();
        *slot = Some(picture.clone());

        thread::scope(|scope| {
            let (started, start) = mpsc::channel();
            let (send, receive) = mpsc::channel();
            let shared = &shared;
            scope.spawn(move || {
                started.send(()).unwrap();
                send.send(shared.frame(0)).unwrap();
            });
            start.recv().unwrap();
            let during_publication = receive.recv_timeout(Duration::from_millis(20));
            drop(slot);
            assert!(matches!(during_publication, Err(mpsc::RecvTimeoutError::Timeout)));
            let visible = receive.recv_timeout(Duration::from_secs(1)).unwrap().unwrap();
            assert!(Arc::ptr_eq(&picture, &visible));
        });
    }

    #[test]
    fn resampled_mic_rounding_keeps_samples_but_does_not_hide_discontinuities() {
        let mut end = i64::MIN;
        for (raw, expected) in [(48000, 48000), (49023, 49024), (50049, 50048)] {
            let start = align_audio_start(raw, end);
            assert_eq!(start, expected);
            end = start + 1024;
        }
        assert_eq!(align_audio_start(end + 480, end), end + 480);
        assert_eq!(align_audio_start(end - 1024, end), end - 1024);
    }

    #[test]
    fn host_clock_overlap_discards_only_the_repeated_samples() {
        assert_eq!(trim_capture_overlap(47995, 48000, 1024), 5);
        assert_eq!(trim_capture_overlap(47000, 48000, 480), 480);
        assert_eq!(trim_capture_overlap(48008, 48000, 1024), 0);
        assert_eq!(trim_capture_overlap(0, i64::MIN, 1024), 0);
    }
}
