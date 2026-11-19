#!/usr/bin/env python3
"""Exercise the actual local Rust/FFmpeg adapter, not a decoder subprocess per seek.

FFmpeg CLI is used only to generate synthetic fixtures and an external reference.
Leaves tiny take outputs and source-linked results in target/, never app profiles.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / "crates/production-runtime"
SDK = ROOT / "target/native-media-sdk/install"
FIXTURES = ROOT / "target/native-media-fixtures"


def source_hash():
    files = [p for package in ["media","contract","core","service","cli"] for p in (RUNTIME / package).rglob("*.rs")]
    files += [RUNTIME / "Cargo.toml", RUNTIME / "Cargo.lock", RUNTIME / "media/Cargo.toml"]
    files += [RUNTIME / "scripts" / name for name in ["build-media-sdk.sh", "prepare-media-fixtures.py", "prove-media.py"]]
    h = hashlib.sha256()
    for path in sorted(files):
        h.update(str(path.relative_to(ROOT)).encode() + b"\0" + path.read_bytes() + b"\0")
    return h.hexdigest()


def run(destination):
    env = os.environ.copy()
    env["FFMPEG_DIR"] = str(SDK)
    if platform.system() == "Darwin":
        env.setdefault("LIBCLANG_PATH", "/Library/Developer/CommandLineTools/usr/lib")
    target = Path(env.get("CARGO_TARGET_DIR", str(ROOT / "target/production-core")))
    env["CARGO_TARGET_DIR"] = str(target)
    destination.parent.mkdir(parents=True, exist_ok=True)
    log_root = ROOT / "target/native-media-proof-logs"
    log_root.mkdir(exist_ok=True)
    checks = []

    def command(name, args, parse=False):
        start = time.monotonic()
        with (log_root / (name + ".stderr.log")).open("wb") as stderr:
            result = subprocess.run(args, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=stderr, check=True)
        (log_root / (name + ".stdout.log")).write_bytes(result.stdout)
        checks.append({"name": name, "passed": True, "elapsedSeconds": round(time.monotonic()-start, 4)})
        return json.loads(result.stdout) if parse else result.stdout

    before = source_hash()
    command("workspace-fmt", ["cargo", "fmt", "--manifest-path", str(RUNTIME / "Cargo.toml"), "--all", "--check"])
    command("workspace-clippy", ["cargo", "clippy", "--manifest-path", str(RUNTIME / "Cargo.toml"), "--workspace", "--locked", "--all-targets", "--", "-D", "warnings"])
    command("workspace-tests", ["cargo", "test", "--manifest-path", str(RUNTIME / "Cargo.toml"), "--workspace", "--locked"])
    command("fixtures", ["python3", str(RUNTIME / "scripts/prepare-media-fixtures.py")])
    command("native-clippy", ["cargo", "clippy", "--manifest-path", str(RUNTIME / "Cargo.toml"), "-p", "producer-native-media", "--locked", "--features", "ffmpeg", "--all-targets", "--", "-D", "warnings"])
    command("native-workers", ["cargo", "test", "--manifest-path", str(RUNTIME / "Cargo.toml"), "-p", "producer-native-media", "--locked", "--features", "ffmpeg"])
    command("native-build", ["cargo", "build", "--manifest-path", str(RUNTIME / "Cargo.toml"), "-p", "producer-native-media", "--locked", "--features", "ffmpeg", "--examples"])
    references = json.loads((FIXTURES / "reference.json").read_text())
    results = {}
    for name in references:
        results[name] = command("decode-" + name, [str(target / "debug/examples/media_proof"), str(FIXTURES / (name+".mov"))], parse=True)
        assert results[name]["oracleChecks"] == 72
        assert results[name]["sequentialPlaybackExtraSeeks"] == 0
        assert results[name]["frameBytesAfterRelease"] == results[name]["workersAfterShutdown"] == 0

    # Independent raw RGB oracle: known generated pixels, not ffmpeg's reference path.
    rgb = (FIXTURES / "video.rgb").read_bytes()
    for index, expected in enumerate(references["cfr"]["frames"]):
        source = rgb[index*64*48*3:(index+1)*64*48*3]
        rgba = bytearray()
        for i in range(0, len(source), 3):
            rgba.extend(source[i:i+3]); rgba.append(255)
        assert hashlib.sha256(rgba).hexdigest() == expected["sha256"]
    checks.append({"name": "independent-raw-rgb-oracle", "passed": True, "frames": 24})
    take_root = FIXTURES / ("take-" + uuid.uuid4().hex)
    take = command("growing-takes", [str(target / "debug/examples/take_proof"), str(FIXTURES / "cfr.mov"), str(take_root)], parse=True)
    assert len(take["checkpointsWhileWriting"]) == 4
    assert take["snapshotReaderCannotSeeLaterRanges"]
    assert take["failedCheckpointRetainedPreviousRange"]
    assert take["writerAdmissionRejectedSecond"]
    for lane in ["program", "original"]:
        pcm = command("audio-"+lane, [str(SDK / "bin/ffmpeg"), "-v", "error", "-i", str(take_root / (lane+".mov")), "-vn", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"])
        assert hashlib.sha256(pcm).hexdigest() == references["cfr"]["audioSha256"]
        assert len(pcm)//2 == references["cfr"]["audioSamples"]
    after = source_hash()
    assert before == after
    evidence = {"scope": "isolated N1 native MOV/frame-pull and raw/PCM growing-take prototype", "platform": platform.platform(), "architecture": platform.machine(), "sourceSha256": before, "sourceUnchanged": True, "sdk": {"version": "8.0.3", "archiveSha256": "6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818"}, "checks": checks, "decode": results, "fixtures": references, "takes": take, "audioPreserved": {"lanes":2,"samplesEach":references["cfr"]["audioSamples"],"sha256":references["cfr"]["audioSha256"]}, "notQualified": ["GPUI/GPU/zero-copy/native rendering", "capture or live device/encoder callbacks", "audio device playback/mix/clock", "hardware decode and sustained dual 1080p60", "hostile-file isolation and interruptible blocked filesystem IO", "negative-origin display PTS (B-frame negative DTS is covered)", "compressed growing takes, crash/power-loss/disk removal/full", "persistent reader refresh without reopen", "Windows, Intel Mac, Linux native media", "earlier core RSS gate remains open"]}
    destination.write_text(json.dumps(evidence, indent=2)+"\n")
    print(json.dumps({"passed": True, "oracleFrameChecks":sum(r["oracleChecks"] for r in results.values()),"scrubFloodRequests":sum(r["scrubFloodRequests"] for r in results.values()),"growingCheckpoints":4,"audioSamplesEach":references["cfr"]["audioSamples"],"evidence":str(destination)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=RUNTIME / "evidence/native-media-proof.json")
    run(parser.parse_args().output)
