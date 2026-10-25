// Replay actual tap order/delays without opening devices, changing routes or publishing audio.
#[allow(dead_code)]
#[path = "../apm.rs"]
mod apm;
use anyhow::{ensure, Context, Result};
use serde_json::json;
use std::{
    fs::OpenOptions,
    io::{BufWriter, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

fn read_pcm(path: &Path) -> Result<Vec<i16>> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    ensure!(
        spec.sample_rate == 48000
            && spec.channels == 1
            && spec.bits_per_sample == 16
            && spec.sample_format == hound::SampleFormat::Int,
        "Expected 48kHz mono PCM16"
    );
    Ok(reader
        .samples::<i16>()
        .collect::<std::result::Result<Vec<_>, _>>()?)
}
fn write_pcm(path: &Path, data: &[i16]) -> Result<()> {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    let mut writer = hound::WavWriter::new(
        BufWriter::new(file),
        hound::WavSpec {
            channels: 1,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )?;
    for &sample in data {
        writer.write_sample(sample)?;
    }
    writer.finalize()?;
    Ok(())
}
fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let input = PathBuf::from(
        args.next()
            .context("Usage: speakerphone_replay <completed-session> <new-output-directory>")?,
    );
    let output = PathBuf::from(args.next().context("Missing output directory")?);
    let report: serde_json::Value =
        serde_json::from_slice(&std::fs::read(input.join("report.json"))?)?;
    ensure!(
        report["stop_reason"] == "completed",
        "Only completed traces can be replayed"
    );
    let speaker = read_pcm(&input.join("speaker-reference.wav"))?;
    let mic = read_pcm(&input.join("microphone-raw.wav"))?;
    let recorded = read_pcm(&input.join("processed-on.wav"))?;
    ensure!(
        speaker.len() % 480 == 0 && mic.len() % 480 == 0 && recorded.len() == mic.len(),
        "Incomplete PCM blocks"
    );
    std::fs::DirBuilder::new().mode(0o700).create(&output)?;
    let mut baseline = apm::Processor::new(true, 48000, 1)?;
    let mut candidate = apm::Processor::new(true, 48000, 1)?;
    candidate.set_high_pass_filter_enforcement(false);
    ensure!(
        baseline.high_pass_filter_enforced() && !candidate.high_pass_filter_enforced(),
        "Configuration mismatch"
    );
    let mut baseline_pcm = Vec::with_capacity(mic.len());
    let mut candidate_pcm = Vec::with_capacity(mic.len());
    let (mut render_index, mut capture_index) = (0, 0);
    let mut metrics = Vec::new();
    let mut powers = [0.0f64; 3];
    let mut window_blocks = 0;
    let mut last_phase = 0.0;
    let timestamps = std::fs::read_to_string(input.join("timestamps.csv"))?;
    for line in timestamps.lines().skip(1) {
        let cells: Vec<_> = line.split(',').collect();
        ensure!(cells.len() == 4, "Malformed trace row");
        match cells[0] {
            "speaker" => {
                let block = speaker
                    .get(render_index..render_index + 480)
                    .context("Render trace exceeds WAV")?;
                baseline.reverse(block)?;
                candidate.reverse(block)?;
                render_index += 480;
            }
            "microphone" => {
                let block = mic
                    .get(capture_index..capture_index + 480)
                    .context("Capture trace exceeds WAV")?;
                let delay = cells[3].parse::<i32>()?;
                let phase = cells[2].parse::<f64>()?;
                ensure!(
                    capture_index == 0 || phase > last_phase,
                    "Nonmonotonic phase time"
                );
                last_phase = phase;
                let (mut old, mut new) = (block.to_vec(), block.to_vec());
                baseline.capture(&mut old, delay)?;
                candidate.capture(&mut new, delay)?;
                for ((&raw, &old), &new) in block.iter().zip(&old).zip(&new) {
                    powers[0] += f64::from(raw).powi(2);
                    powers[1] += f64::from(old).powi(2);
                    powers[2] += f64::from(new).powi(2);
                }
                window_blocks += 1;
                if window_blocks == 20 {
                    metrics.push(json!({"end_seconds":phase + 0.01,"raw_rms_dbfs":10.0*((powers[0]/9600.0+1.0)/32768.0f64.powi(2)).log10(),
                        "baseline_attenuation_db":10.0*((powers[0]+1.0)/(powers[1]+1.0)).log10(),
                        "candidate_attenuation_db":10.0*((powers[0]+1.0)/(powers[2]+1.0)).log10()}));
                    window_blocks = 0;
                    powers = [0.0; 3];
                }
                baseline_pcm.extend(old);
                candidate_pcm.extend(new);
                capture_index += 480;
            }
            _ => anyhow::bail!("Unknown trace kind"),
        }
    }
    ensure!(
        render_index == speaker.len() && capture_index == mic.len(),
        "Unconsumed trace PCM"
    );
    write_pcm(&output.join("baseline.wav"), &baseline_pcm)?;
    write_pcm(&output.join("no-forced-high-pass.wav"), &candidate_pcm)?;
    let error_power: f64 = baseline_pcm
        .iter()
        .zip(&recorded)
        .map(|(&a, &b)| (f64::from(a) - f64::from(b)).powi(2))
        .sum();
    let result = json!({"offline_only":true,"trace_order_and_delays_replayed":true,"capture_blocks":capture_index/480,"render_blocks":render_index/480,
        "aec_enabled_in_both":true,"baseline_high_pass_enforced":baseline.high_pass_filter_enforced(),"candidate_high_pass_enforced":candidate.high_pass_filter_enforced(),
        "baseline_vs_recorded_rms_error_pcm":(error_power/recorded.len() as f64).sqrt(),"windows":metrics,"physical_aec_qualified":false,"g1_complete":false});
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(output.join("replay.json"))?;
    serde_json::to_writer_pretty(&mut file, &result)?;
    writeln!(file)?;
    println!("Offline comparison saved: {}", output.display());
    Ok(())
}
