//! Real OBS verification with synthetic audio, no device or network access.
use super::{drain, start, stop};
use crate::live::{engine, ffi, graph, idle_tick};
use std::{
    ffi::CString,
    ptr,
    time::{Duration, Instant},
};

fn measure() -> [f64; 2] {
    std::thread::sleep(Duration::from_millis(200));
    drain();
    let mut sums = [0f64; 2];
    let mut counts = [0usize; 2];
    let began = Instant::now();
    while began.elapsed() < Duration::from_millis(700) {
        std::thread::sleep(Duration::from_millis(15));
        let packet = drain();
        let mut pos = 0;
        while pos + 16 <= packet.len() {
            let bus = u32::from_le_bytes(packet[pos..pos + 4].try_into().unwrap()) as usize;
            let frames = u32::from_le_bytes(packet[pos + 4..pos + 8].try_into().unwrap()) as usize;
            let end = pos + 16 + frames * 8;
            if bus > 1 || end > packet.len() {
                break;
            }
            for sample in packet[pos + 16..end].chunks_exact(4) {
                let value = f32::from_le_bytes(sample.try_into().unwrap()) as f64;
                sums[bus] += value * value;
                counts[bus] += 1;
            }
            pos = end;
        }
    }
    [0, 1].map(|bus| (sums[bus] / counts[bus].max(1) as f64).sqrt())
}
fn verify() -> Result<serde_json::Value, String> {
    let dir = std::env::temp_dir().join(format!("producer-program-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let report = engine::bootstrap_with_config(&dir.join("config"));
    // A bare headless executable cannot locate CEF's bundle. This harness
    // exercises audio only; source creation and the real audio tap below are
    // the relevant checks, and must both succeed.
    if unsafe { ffi::obs_get_audio() }.is_null() {
        return Err(format!("Audio bootstrap failed: {report:?}"));
    }
    let path = dir.join("tone.wav");
    let mut writer = hound::WavWriter::create(
        &path,
        hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|e| e.to_string())?;
    for n in 0..48000 * 10 {
        let sample = ((n as f32 * 2. * std::f32::consts::PI * 440. / 48000.).sin() * 12000.) as i16;
        writer.write_sample(sample).map_err(|e| e.to_string())?;
        writer.write_sample(sample).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    let local = CString::new(path.to_string_lossy().as_bytes()).unwrap();
    let source = unsafe {
        let settings = ffi::obs_data_create();
        ffi::obs_data_set_bool(settings, c"is_local_file".as_ptr(), true);
        ffi::obs_data_set_string(settings, c"local_file".as_ptr(), local.as_ptr());
        ffi::obs_data_set_bool(settings, c"looping".as_ptr(), true);
        let source = ffi::obs_source_create(
            c"ffmpeg_source".as_ptr(),
            c"Program bus verification".as_ptr(),
            settings,
            ptr::null_mut(),
        );
        ffi::obs_data_release(settings);
        if !source.is_null() {
            graph::configure_remote_audio(source);
            if ffi::obs_source_get_monitoring_type(source) != 2 || !ffi::obs_source_muted(source) {
                return Err("Remote must start muted with host playback enabled".into());
            }
            // Verify the production configuration without playing the test
            // tone through the user's speakers during an active rehearsal.
            ffi::obs_source_set_monitoring_type(source, 0);
            ffi::obs_source_set_volume(source, 0.5);
            ffi::obs_set_output_source(5, source);
        }
        source
    };
    if source.is_null() {
        return Err("Tone source unavailable".into());
    }
    start()?;
    let admitted_muted = measure();
    unsafe {
        ffi::obs_source_set_muted(source, false);
    }
    let guest_only = measure();
    unsafe {
        ffi::obs_source_set_audio_mixers(source, 3);
    }
    let host_mix = measure();
    unsafe {
        ffi::obs_source_set_volume(source, 0.25);
    }
    let half_gain = measure();
    unsafe {
        ffi::obs_source_set_muted(source, true);
    }
    let muted = measure();
    stop();
    unsafe {
        ffi::obs_set_output_source(5, ptr::null_mut());
        ffi::obs_source_release(source);
    }
    if admitted_muted.iter().any(|value| *value > 0.001) {
        return Err(format!("Admission leaked audio: {admitted_muted:?}"));
    }
    if guest_only[0] < 0.02 || guest_only[1] > 0.001 {
        return Err(format!("Guest isolation failed: {guest_only:?}"));
    }
    if host_mix[1] < 0.02 || (host_mix[0] - host_mix[1]).abs() > 0.005 {
        return Err(format!("Host mix failed: {host_mix:?}"));
    }
    if !(0.4..0.6).contains(&(half_gain[0] / host_mix[0])) {
        return Err(format!("Native gain missing: {half_gain:?}"));
    }
    if muted.iter().any(|value| *value > 0.001) {
        return Err(format!("Native mute missing: {muted:?}"));
    }
    Ok(
        serde_json::json!({"ok":true,"admitted_muted_rms":admitted_muted,"guest_only_rms":guest_only,"host_rms":host_mix,"half_gain_rms":half_gain,"muted_rms":muted,"checks":["remote host playback configured","admission starts silent","guest excluded from stage return","host in both buses","native volume","native mute"]}),
    )
}
pub fn run() -> ! {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(verify());
    });
    loop {
        match rx.try_recv() {
            Ok(Ok(report)) => {
                println!("{}", serde_json::to_string_pretty(&report).unwrap());
                std::process::exit(0);
            }
            Ok(Err(error)) => {
                eprintln!("PROGRAM AUDIO SELFTEST FAILED: {error}");
                std::process::exit(1);
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => idle_tick(),
            Err(_) => std::process::exit(2),
        }
    }
}
