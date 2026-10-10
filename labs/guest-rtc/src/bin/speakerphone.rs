// This module also exposes the paired synthetic-fixture convenience API.
#[allow(dead_code)]
#[path = "../apm.rs"]
mod apm;
use anyhow::{bail, ensure, Context, Result};
use serde_json::json;
use std::{
    ffi::{c_char, c_void, CStr, CString},
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const QUEUE_CAPACITY: usize = 32;

#[repr(C)]
struct Block {
    host_ns: u64,
    samples: [i16; 480],
}
unsafe extern "C" {
    fn lab_audio_create(
        samples: *const i16,
        count: usize,
        fail_stage: i32,
        error: *mut c_char,
        length: usize,
    ) -> *mut c_void;
    fn lab_audio_start(handle: *mut c_void, error: *mut c_char, length: usize) -> i32;
    fn lab_audio_pop(handle: *mut c_void, render: i32, block: *mut Block) -> i32;
    fn lab_audio_faults(handle: *mut c_void) -> u64;
    fn lab_audio_fault_detail(handle: *mut c_void, message: *mut c_char, length: usize);
    fn lab_audio_close(handle: *mut c_void, stats: *mut u64) -> i32;
    fn lab_audio_self_test() -> i32;
    fn lab_ui_open();
    fn lab_ui_poll() -> i32;
    fn lab_ui_status(text: *const c_char);
    fn lab_permission(request: i32) -> i32;
    fn lab_output_volume_percent() -> f64;
}
fn output_volume_percent() -> Option<f64> {
    let value = unsafe { lab_output_volume_percent() };
    (value.is_finite() && (0.0..=100.0).contains(&value)).then_some(value)
}
fn status(text: &str) {
    if let Ok(text) = CString::new(text) {
        unsafe { lab_ui_status(text.as_ptr()) }
    }
}
struct Device {
    handle: *mut c_void,
}
impl Device {
    fn new(speech: &[i16]) -> Result<(Self, String)> {
        let mut message = [0i8; 1024];
        let handle = unsafe {
            lab_audio_create(
                speech.as_ptr(),
                speech.len(),
                0,
                message.as_mut_ptr(),
                message.len(),
            )
        };
        let text = unsafe { CStr::from_ptr(message.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        ensure!(!handle.is_null(), "Native device setup: {text}");
        let owner = Self { handle };
        ensure!(
            unsafe { lab_audio_start(handle, message.as_mut_ptr(), message.len()) } != 0,
            "Native device start: {}",
            unsafe { CStr::from_ptr(message.as_ptr()) }.to_string_lossy()
        );
        Ok((owner, text))
    }
    fn pop(&self, render: bool) -> Option<Block> {
        let mut block = Block {
            host_ns: 0,
            samples: [0; 480],
        };
        (unsafe { lab_audio_pop(self.handle, i32::from(render), &mut block) } != 0).then_some(block)
    }
    fn close(&mut self) -> serde_json::Value {
        if self.handle.is_null() {
            return json!({"already_closed":true});
        }
        let mut counts = [0u64; 11];
        let retired = unsafe { lab_audio_close(self.handle, counts.as_mut_ptr()) } != 0;
        self.handle = std::ptr::null_mut();
        json!({"owners_and_callback_state_retired":retired,"callbacks_active":counts[6],"format_or_timeline_errors":counts[7],"clipped_samples":counts[8],"maximum_tap_frames":{"speaker":counts[9],"microphone":counts[10]},
            "speaker":{"queued":counts[0],"consumed":counts[1],"overflow":counts[2],"pending_retired":counts[0]-counts[1],"capacity":QUEUE_CAPACITY},
            "microphone":{"queued":counts[3],"consumed":counts[4],"overflow":counts[5],"pending_retired":counts[3]-counts[4],"capacity":QUEUE_CAPACITY}})
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        self.close();
    }
}
type Wav = hound::WavWriter<BufWriter<File>>;
fn file(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?)
}
fn wav(path: &Path) -> Result<Wav> {
    Ok(hound::WavWriter::new(
        BufWriter::new(file(path)?),
        hound::WavSpec {
            channels: 1,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )?)
}
fn write_pcm(writer: &mut Wav, pcm: &[i16]) -> Result<()> {
    for sample in pcm {
        writer.write_sample(*sample)?;
    }
    Ok(())
}
struct Session {
    device: Device,
    devices: String,
    dir: PathBuf,
    began: Instant,
    on: apm::Processor,
    off: apm::Processor,
    speaker: Wav,
    mic: Wav,
    processed: Wav,
    disabled: Wav,
    stamps: BufWriter<File>,
    latest_render: Option<u64>,
    pending_mic: Option<Block>,
    pending_since: Instant,
    last_mic: Option<u64>,
    first_mic: Option<u64>,
    mic_blocks: u64,
    render_blocks: u64,
    skipped: u64,
    delay_min: i32,
    delay_max: i32,
    processing_us: Vec<u64>,
    attenuation: Vec<f64>,
    energy_raw: f64,
    energy_on: f64,
    energy_blocks: u64,
    last_status: Instant,
    output_volume_start: Option<f64>,
}
impl Session {
    fn new(root: &Path, speech: &[i16]) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        let label = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let dir = root.join(format!("speakerphone-{label}"));
        std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        let mut stamps = BufWriter::new(file(&dir.join("timestamps.csv"))?);
        writeln!(stamps, "kind,host_ns,phase_seconds,estimated_apm_delay_ms")?;
        let mut session = Self {
            on: apm::Processor::new(true, 48000, 1)?,
            off: apm::Processor::new(false, 48000, 1)?,
            speaker: wav(&dir.join("speaker-reference.wav"))?,
            mic: wav(&dir.join("microphone-raw.wav"))?,
            processed: wav(&dir.join("processed-on.wav"))?,
            disabled: wav(&dir.join("processed-off.wav"))?,
            stamps,
            device: Device {
                handle: std::ptr::null_mut(),
            },
            devices: String::new(),
            dir,
            began: Instant::now(),
            latest_render: None,
            pending_mic: None,
            pending_since: Instant::now(),
            last_mic: None,
            first_mic: None,
            mic_blocks: 0,
            render_blocks: 0,
            skipped: 0,
            delay_min: 500,
            delay_max: 0,
            processing_us: Vec::with_capacity(6100),
            attenuation: Vec::with_capacity(100),
            energy_raw: 0.0,
            energy_on: 0.0,
            energy_blocks: 0,
            last_status: Instant::now(),
            output_volume_start: output_volume_percent(),
        };
        // Set once before any capture/reference processing; preserve AEC itself.
        session.on.set_high_pass_filter_enforcement(false);
        ensure!(
            !session.on.high_pass_filter_enforced(),
            "Voice refinement configuration failed"
        );
        let (device, devices) = Device::new(speech)?;
        session.device = device;
        session.devices = devices;
        session.began = Instant::now();
        Ok(session)
    }
    fn pump(&mut self) -> Result<bool> {
        if unsafe { lab_audio_faults(self.device.handle) } != 0 {
            let mut message = [0i8; 256];
            unsafe {
                lab_audio_fault_detail(self.device.handle, message.as_mut_ptr(), message.len())
            };
            bail!(
                "Audio stopped: {}",
                unsafe { CStr::from_ptr(message.as_ptr()) }.to_string_lossy()
            );
        }
        // Feed all device-bound render blocks before capture. APM runs on this
        // owner thread; audio callbacks only copy into fixed-capacity rings.
        for _ in 0..QUEUE_CAPACITY {
            let Some(block) = self.device.pop(true) else {
                break;
            };
            if let Some(previous) = self.latest_render {
                ensure!(block.host_ns > previous, "Render timestamp regressed");
            }
            self.on.reverse(&block.samples)?;
            self.off.reverse(&block.samples)?;
            self.latest_render = Some(block.host_ns);
            self.render_blocks += 1;
            write_pcm(&mut self.speaker, &block.samples)?;
            writeln!(self.stamps, "speaker,{},,", block.host_ns)?;
        }
        if let Some(render) = self.latest_render {
            for _ in 0..QUEUE_CAPACITY {
                let waiting = self.pending_mic.is_some();
                let Some(block) = self.pending_mic.take().or_else(|| self.device.pop(false)) else {
                    break;
                };
                if !waiting {
                    self.pending_since = Instant::now();
                }
                // Input and output tap callbacks may arrive in either order.
                // Retain one capture block for at most 80 ms while waiting for
                // the corresponding render timeline, never invent a reference.
                if render < block.host_ns {
                    ensure!(
                        self.pending_since.elapsed() < Duration::from_millis(80),
                        "Render reference did not catch up within 80 ms"
                    );
                    self.pending_mic = Some(block);
                    break;
                }
                self.pending_since = Instant::now();
                if let Some(previous) = self.last_mic {
                    ensure!(block.host_ns > previous, "Microphone timestamp regressed");
                }
                self.last_mic = Some(block.host_ns);
                let first = *self.first_mic.get_or_insert(block.host_ns);
                let second = (block.host_ns - first) as f64 / 1e9;
                // Estimate capture buffering + render lead from the device
                // host-time domain. This is not calibrated acoustic latency.
                let delay = (i128::from(render) - i128::from(block.host_ns)) / 1_000_000;
                if !(0..=500).contains(&delay) {
                    self.skipped += 1;
                    bail!("Speaker/microphone timeline lacks a valid APM delay ({delay} ms)");
                }
                let delay = delay as i32;
                self.delay_min = self.delay_min.min(delay);
                self.delay_max = self.delay_max.max(delay);
                let mut on = block.samples;
                let mut off = block.samples;
                let began = Instant::now();
                self.on.capture(&mut on, delay)?;
                self.off.capture(&mut off, delay)?;
                if self.processing_us.len() < 6100 {
                    self.processing_us.push(began.elapsed().as_micros() as u64);
                }
                self.mic_blocks += 1;
                write_pcm(&mut self.mic, &block.samples)?;
                write_pcm(&mut self.processed, &on)?;
                write_pcm(&mut self.disabled, &off)?;
                writeln!(
                    self.stamps,
                    "microphone,{},{second:.6},{delay}",
                    block.host_ns
                )?;
                // 200 ms windows, after adaptation, during instructed far-only.
                // These are provisional signal metrics; human phase compliance
                // and near-speech intelligibility require separate review.
                if (12.0..29.0).contains(&second) {
                    self.energy_raw += off.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>();
                    self.energy_on += on.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>();
                    self.energy_blocks += 1;
                    if self.energy_blocks == 20 {
                        if self.energy_raw / (20.0 * 480.0) > 10000.0
                            && self.attenuation.len() < 100
                        {
                            self.attenuation.push(
                                10.0 * ((self.energy_raw + 1.0) / (self.energy_on + 1.0)).log10(),
                            );
                        }
                        self.energy_raw = 0.0;
                        self.energy_on = 0.0;
                        self.energy_blocks = 0;
                    }
                }
            }
        }
        if self.began.elapsed() > Duration::from_secs(3) {
            ensure!(
                self.mic_blocks > 0 && self.render_blocks > 0,
                "No real capture or speaker-reference blocks received"
            );
        }
        if self.last_status.elapsed() > Duration::from_millis(200) {
            let seconds = self.began.elapsed().as_secs();
            let phase = match seconds {
                0..=4 => "Stay quiet — baseline",
                5..=29 => "Stay quiet — speaker echo test",
                30..=49 => "Talk over the clip — double talk",
                _ => "Talk — speakers are silent",
            };
            status(&format!("{seconds}/60 s: {phase}\n{}", self.devices));
            self.last_status = Instant::now();
        }
        Ok(self.began.elapsed() < Duration::from_secs(60))
    }
    fn finish(mut self, reason: &str) -> Result<PathBuf> {
        let lifecycle = self.device.close();
        let output_volume_end = output_volume_percent();
        self.speaker.finalize()?;
        self.mic.finalize()?;
        self.processed.finalize()?;
        self.disabled.finalize()?;
        self.stamps.flush()?;
        self.processing_us.sort_unstable();
        self.attenuation.sort_by(f64::total_cmp);
        let percentile = |fraction: f64| {
            self.attenuation
                .get(
                    ((self.attenuation.len().saturating_sub(1)) as f64 * fraction).round() as usize,
                )
                .copied()
        };
        let p95 = self
            .processing_us
            .get(((self.processing_us.len().saturating_sub(1)) as f64 * 0.95).round() as usize);
        let report = json!({"schema_version":1,"stop_reason":reason,"devices":self.devices,"duration_seconds":self.began.elapsed().as_secs_f64(),
            "hardware_capture_used":self.mic_blocks>0,"physical_speaker_reference_connected":self.render_blocks>0,
            "default_output_volume_percent":{"start":self.output_volume_start,"end":output_volume_end,"continuous_verification":false,"acoustic_spl_calibrated":false},
            "reference_scope":"This engine's final stereo mixer output, downmixed to mono; excludes other apps and hardware-volume calibration",
            "sample_rate":48000,"apm_channels":1,"source_gain":0.20,"microphone_blocks":self.mic_blocks,"speaker_blocks":self.render_blocks,
            "apm_delay_estimate_ms":{"minimum":self.delay_min,"maximum":self.delay_max,"acoustic_delay_calibrated":false},
            "aec_profile":"no_forced_high_pass","ns":false,"agc":false,"high_pass_requested":false,"aec_enforced_high_pass":self.on.high_pass_filter_enforced(),
            "high_pass":self.on.high_pass_filter_enforced(),"system_voice_processing":false,"microphone_played_or_published":false,
            "processing_both_apms_p95_us":p95,"provisional_far_only_attenuation_db":{"median":percentile(0.5),"p10":percentile(0.1),"windows":self.attenuation.len()},
            "invalid_delay_blocks":self.skipped,"additional_capture_hold_capacity":1,"capture_hold_limit_ms":80,"capture_hold_retired":self.pending_mic.is_some(),"lifecycle":lifecycle,"user_phase_compliance_verified":false,
            "speech_intelligibility_qualified":false,"physical_aec_qualified":false,"g1_complete":false});
        let mut output = file(&self.dir.join("report.json"))?;
        serde_json::to_writer_pretty(&mut output, &report)?;
        writeln!(output)?;
        println!("Speakerphone evidence saved: {}", self.dir.display());
        Ok(self.dir)
    }
}
fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let input = match args.next() {
        Some(input) => input,
        None => std::env::current_exe()?
            .parent()
            .and_then(|path| path.parent())
            .context("Missing application bundle location")?
            .join("Resources/far-speech.wav")
            .to_string_lossy()
            .into_owned(),
    };
    if input == "--self-test" {
        ensure!(
            unsafe { lab_audio_self_test() } == 1,
            "Native ownership/queue self-test failed"
        );
        println!("20 native queue and partial-initialization teardown cycles passed");
        return Ok(());
    }
    if input == "--volume-snapshot" {
        println!("{:?}", output_volume_percent());
        return Ok(());
    }
    let root = args.next().map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").expect("Home directory required"))
            .join("Library/Application Support/Producer Guest RTC Lab")
    });
    let mut reader = hound::WavReader::open(&input)?;
    let spec = reader.spec();
    ensure!(
        spec.sample_rate == 48000
            && spec.channels == 1
            && spec.bits_per_sample == 16
            && spec.sample_format == hound::SampleFormat::Int,
        "Speech must be 48 kHz mono PCM16 WAV"
    );
    ensure!(
        reader.len() > 0 && reader.len() <= 48000 * 120,
        "Speech length must be 0–120 seconds"
    );
    let speech = reader
        .samples::<i16>()
        .collect::<std::result::Result<Vec<_>, _>>()?;
    unsafe { lab_ui_open() };
    let mut active: Option<Session> = None;
    let mut permission_pending = false;
    loop {
        let event = unsafe { lab_ui_poll() };
        if event == 3 {
            if let Some(session) = active.take() {
                session.finish("window_closed")?;
            }
            break;
        }
        if event == 2 {
            permission_pending = false;
            if let Some(session) = active.take() {
                let dir = session.finish("user_stopped")?;
                status(&format!("Stopped. Saved {}", dir.display()));
            }
        }
        if event == 1 && active.is_none() {
            permission_pending = true;
            unsafe { lab_permission(1) };
        }
        if permission_pending {
            match unsafe { lab_permission(0) } {
                1 => {
                    permission_pending = false;
                    match Session::new(&root, &speech) {
                        Ok(session) => active = Some(session),
                        Err(error) => status(&format!("Could not start: {error:#}")),
                    }
                }
                -1 => {
                    permission_pending = false;
                    status("Microphone access is denied. Enable it for Producer Speakerphone Lab in System Settings, then restart this lab.");
                }
                _ => status("Waiting for microphone permission. Capture has not started."),
            }
        }
        if let Some(session) = active.as_mut() {
            let stop = match session.pump() {
                Ok(true) => None,
                Ok(false) => Some("completed".to_owned()),
                Err(error) => Some(format!("invalid: {error:#}")),
            };
            if let Some(reason) = stop {
                let session = active.take().unwrap();
                let dir = session.finish(&reason)?;
                status(&format!("{reason}. Saved {}", dir.display()));
            }
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    Ok(())
}
