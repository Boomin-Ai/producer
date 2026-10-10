"""Validate a completed physical run's files and lifecycle; does not grant AEC acceptance."""
import argparse
import csv
import json
from pathlib import Path
import wave

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
args = parser.parse_args()
report = json.loads((args.directory / "report.json").read_text())
assert report["stop_reason"] == "completed", "Stopped/invalid runs remain evidence, not acceptance runs"
assert report["hardware_capture_used"] and report["physical_speaker_reference_connected"]
assert not report["microphone_played_or_published"]
assert not any(report[k] for k in ("ns", "agc", "system_voice_processing", "physical_aec_qualified", "g1_complete"))
if "aec_enforced_high_pass" in report:
    assert report["high_pass"] == report["aec_enforced_high_pass"]
else:
    print("Legacy report high_pass field records the request only; upstream AEC implicitly enforces high-pass filtering")
life = report["lifecycle"]
assert life["owners_and_callback_state_retired"] and life["callbacks_active"] == 0
assert life["format_or_timeline_errors"] == report["invalid_delay_blocks"] == 0
for kind, blocks in [("speaker", report["speaker_blocks"]), ("microphone", report["microphone_blocks"])]:
    queue = life[kind]
    assert queue["capacity"] == 32 and queue["overflow"] == 0
    assert queue["queued"] == queue["consumed"] + queue["pending_retired"]
    held = int(report["capture_hold_retired"]) if kind == "microphone" else 0
    assert queue["consumed"] == blocks + held
for name in ("speaker-reference", "microphone-raw", "processed-on", "processed-off"):
    with wave.open(str(args.directory / (name + ".wav"))) as audio:
        assert audio.getnchannels() == 1 and audio.getframerate() == 48000 and audio.getsampwidth() == 2
        blocks = report["speaker_blocks"] if name == "speaker-reference" else report["microphone_blocks"]
        assert audio.getnframes() == blocks * 480
with (args.directory / "timestamps.csv").open() as stream:
    rows = list(csv.DictReader(stream))
for kind, blocks in [("speaker", report["speaker_blocks"]), ("microphone", report["microphone_blocks"])]:
    stamps = [int(row["host_ns"]) for row in rows if row["kind"] == kind]
    assert len(stamps) == blocks and all(b > a for a, b in zip(stamps, stamps[1:]))
print("Physical capture files, timestamps, bounded accounting and native teardown verified; human review and AEC acceptance remain open")
