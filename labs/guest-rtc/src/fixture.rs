use crate::apm::Processor;
use anyhow::Result;
use serde_json::json;
use std::{path::Path, time::Instant};

const RATE: usize = 48000;
const BLOCK: usize = RATE / 100;

fn signal(seed: u32, seconds: usize) -> Vec<i16> {
    let mut state = seed;
    let (mut low, mut slow) = (0.0, 0.0);
    (0..RATE * seconds)
        .map(|n| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let noise = state as i32 as f64 / i32::MAX as f64;
            low += 0.25 * (noise - low);
            slow += 0.025 * (low - slow);
            let envelope = 0.45
                + 0.55
                    * (n as f64 * 2.0 * std::f64::consts::PI * 3.1 / RATE as f64)
                        .sin()
                        .abs();
            ((low - slow) * envelope * 16000.0) as i16
        })
        .collect()
}

fn percentile(values: &mut [f64], fraction: f64) -> f64 {
    values.sort_by(f64::total_cmp);
    values[((values.len() - 1) as f64 * fraction).round() as usize]
}

fn wav(path: &Path, samples: &[i16]) -> Result<()> {
    let mut writer = hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels: 1,
            sample_rate: RATE as u32,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )?;
    for sample in samples {
        writer.write_sample(*sample)?;
    }
    writer.finalize()?;
    Ok(())
}

// APM adds algorithmic delay. Comparing only identical sample indices would
// wrongly report removed near speech. This is a signal check, not intelligibility.
fn near_projection(output: &[i16], near: &[i16]) -> serde_json::Value {
    let score = |lag: usize| {
        let (mut dot, mut clean_power, mut output_power) = (0.0, 0.0, 0.0);
        for n in (RATE * 14..output.len()).step_by(4) {
            let clean = near[n - lag] as f64 * 0.6;
            let value = output[n] as f64;
            dot += clean * value;
            clean_power += clean * clean;
            output_power += value * value;
        }
        (dot / clean_power, dot / (clean_power * output_power).sqrt())
    };
    let coarse = (0..=RATE / 5)
        .step_by(8)
        .max_by(|a, b| score(*a).1.total_cmp(&score(*b).1))
        .unwrap();
    let lag = (coarse.saturating_sub(8)..=(coarse + 8).min(RATE / 5))
        .max_by(|a, b| score(*a).1.total_cmp(&score(*b).1))
        .unwrap();
    let (gain, correlation) = score(lag);
    json!({"best_lag_samples":lag,"best_lag_ms":lag as f64 * 1000.0 / RATE as f64,
        "aligned_signal_projection_gain":gain,"aligned_correlation":correlation,"search_max_lag_ms":200,
        "output_to_near_reference_rms_ratio":gain / correlation,
        "projection_is_not_perceived_volume_or_intelligibility":true,
        "speech_intelligibility_qualified":false})
}

pub fn run(dir: &Path, speech: Option<&Path>) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let far = signal(0x12345678, 20);
    let near = if let Some(path) = speech {
        let mut reader = hound::WavReader::open(path)?;
        anyhow::ensure!(
            reader.spec().channels == 1
                && reader.spec().sample_rate == RATE as u32
                && reader.spec().bits_per_sample == 16,
            "Near speech fixture must be 48 kHz mono PCM16 WAV"
        );
        let samples = reader
            .samples::<i16>()
            .collect::<std::result::Result<Vec<_>, _>>()?;
        anyhow::ensure!(!samples.is_empty(), "Empty speech fixture");
        (0..RATE * 20).map(|n| samples[n % samples.len()]).collect()
    } else {
        signal(0xabcddcba, 20)
    };
    let (delay, tail) = (RATE * 40 / 1000, RATE * 67 / 1000);
    let mut mic = vec![0i16; far.len()];
    for n in 0..mic.len() {
        let echo = if n >= delay {
            far[n - delay] as f64 * 0.55
        } else {
            0.0
        } + if n >= tail {
            far[n - tail] as f64 * 0.12
        } else {
            0.0
        };
        let local = if n >= RATE * 12 {
            near[n] as f64 * 0.6
        } else {
            0.0
        };
        mic[n] = (echo + local).clamp(i16::MIN as f64, i16::MAX as f64) as i16;
    }
    let mut runs = Vec::new();
    let mut passed = false;
    for enabled in [false, true] {
        let mut apm = Processor::new(enabled, RATE as i32, 1)?;
        let mut processed = Vec::with_capacity(mic.len());
        let (mut costs, mut attenuation) = (Vec::new(), Vec::new());
        for (index, (speaker, input)) in far
            .as_chunks::<BLOCK>()
            .0
            .iter()
            .zip(mic.as_chunks::<BLOCK>().0.iter())
            .enumerate()
        {
            let mut output = input.to_vec();
            let began = Instant::now();
            apm.process(speaker, &mut output, 40)?;
            costs.push(began.elapsed().as_secs_f64() * 1e6);
            if (500..1200).contains(&index) {
                let before: f64 = input.iter().map(|v| (*v as f64).powi(2)).sum();
                let after: f64 = output.iter().map(|v| (*v as f64).powi(2)).sum();
                attenuation.push(10.0 * ((before + 1.0) / (after + 1.0)).log10());
            }
            processed.extend(output);
        }
        let median = percentile(&mut attenuation, 0.5);
        let p10 = percentile(&mut attenuation, 0.1);
        let p95_us = percentile(&mut costs, 0.95);
        if enabled {
            passed = median >= 20.0 && p10 >= 10.0;
        }
        runs.push(
            json!({"aec_enabled":enabled,"far_end_attenuation_median_db":median,
            "far_end_attenuation_p10_db":p10,"processing_p95_us_per_10ms":p95_us,
            "double_talk_near_signal":near_projection(&processed, &near),
            "far_only_measured_seconds":[5,12],"double_talk_measured_seconds":[14,20]}),
        );
        wav(
            &dir.join(if enabled {
                "processed-on.wav"
            } else {
                "processed-off.wav"
            }),
            &processed,
        )?;
    }
    wav(&dir.join("speaker-reference.wav"), &far)?;
    wav(&dir.join("microphone-fixture.wav"), &mic)?;
    wav(&dir.join("near-reference.wav"), &near)?;
    let report = json!({"schema_version":1,"fixture":"synthetic linear acoustic path; no device capture",
        "livekit":"0.9.4","rate":RATE,"channels":1,"block_ms":10,"stream_delay_ms":40,
        "echo_paths":[{"delay_ms":40,"gain":0.55},{"delay_ms":67,"gain":0.12}],
        "speech_processing":{"ns":false,"agc":false,"high_pass":false},"runs":runs,
        "near_fixture":if speech.is_some() { "offline synthesized speech" } else { "independent shaped noise" },
        "synthetic_attenuation_target_met":passed,"physical_speakerphone_qualified":false,"g1_complete":false});
    std::fs::write(
        dir.join("apm-fixture.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
