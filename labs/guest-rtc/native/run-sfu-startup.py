#!/usr/bin/env python3
"""One owned loopback-only startup/rejoin recording. Requires built lab binaries."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time

LAB = Path(__file__).resolve().parents[1]


def wait_listener(port, process):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Owned service exited before port {port} was ready")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"Owned service did not open port {port}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("variant", choices=["control", "candidate"])
    parser.add_argument("--churn", action="store_true", help="Three guests, three guest-1 rejoins over 45 seconds")
    args = parser.parse_args()
    for port in (7880, 8990, 7885):
        probe = socket.socket()
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
        finally:
            probe.close()
    if shutil.disk_usage(LAB).free < 1024 ** 3:
        raise RuntimeError("Need 1 GiB free before recording")
    guests, mode, seconds = (3, "churn", 45) if args.churn else (1, "republish", 30)
    prefix = "delayed-" + args.variant + ("-churn" if args.churn else "")
    run_name = "transport-obs-audio-master-" + prefix + "-rejoin"
    if (LAB / f"evidence/sfu-{prefix}-conditions.json").exists():
        raise RuntimeError("Refusing to overwrite retained conditions")
    for previous in (LAB / "evidence").glob(run_name + "*"):
        raise RuntimeError("Refusing to overwrite retained evidence: " + previous.name)
    if (LAB / f"runtime/obs-audio-master-{prefix}-rejoin.mp4").exists():
        raise RuntimeError("Refusing to overwrite a retained recording")
    binary = LAB / "runtime/livekit-server-delayed-report-lab"
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    env = dict(os.environ)
    for key in ("LIVEKIT_LAB_EARLY_AUDIO_SR", "LIVEKIT_LAB_DELAYED_AUDIO_SR"):
        env.pop(key, None)
    env.update(LIVEKIT_LAB_FAST_RTCP="1", LIVEKIT_LAB_RTCP_TRACE="1",
               LIVEKIT_LAB_SYNC_STREAMS="1", LIVEKIT_LAB_PACKET_PROXY="1",
               LIVEKIT_LAB_PACKET_PROFILE="audio-jitter")
    if args.variant == "candidate":
        env["LIVEKIT_LAB_DELAYED_AUDIO_SR"] = "1"
    owned, logs = [], []

    def start(command, label, port):
        stream = (LAB / f"runtime/{prefix}-{label}.log").open("w")
        logs.append(stream)
        process = subprocess.Popen(command, cwd=LAB, env=env, stdout=stream, stderr=subprocess.STDOUT)
        owned.append(process)
        wait_listener(port, process)

    try:
        start([str(binary), "--dev", "--bind", "127.0.0.1",
               "--rtc.enable_loopback_candidate", "--rtc.tcp_port", "0"], "sfu", 7880)
        start(["node", "web/server.mjs"], "web", 8990)
        start(["node", "web/packet-proxy.mjs"], "relay", 7885)
        env.update(DYLD_FRAMEWORK_PATH="/Applications/Producer.app/Contents/Frameworks",
                   DYLD_LIBRARY_PATH="/Applications/Producer.app/Contents/Frameworks",
                   LIVEKIT_LAB_TIMED_MIXER="1", LIVEKIT_LAB_RTCP_PROBE="1",
                   LIVEKIT_LAB_AUDIO_MASTER="1", LIVEKIT_LAB_SCHEDULE_HANDOFF="1",
                   LIVEKIT_LAB_OBS_PIPELINE_PROBE="1", LIVEKIT_LAB_OBS_FINALIZED_MP4="1",
                   LIVEKIT_LAB_FIRST_REPORT_BOOTSTRAP="1", LIVEKIT_LAB_EXTENDED_VIDEO_BUFFER="1",
                   LIVEKIT_LAB_URL="ws://127.0.0.1:7885", LIVEKIT_LAB_SECONDS=str(seconds),
                   LIVEKIT_LAB_OBS_RECORDING=str(LAB / f"runtime/obs-audio-master-{prefix}-rejoin.mp4"),
                   LIVEKIT_LAB_RUN_NAME=run_name)
        with (LAB / f"runtime/{prefix}-run.log").open("w") as log:
            fixture = subprocess.Popen(["node", "web/smoke.mjs", str(guests), mode], cwd=LAB,
                                       env=env, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                code = fixture.wait(timeout=90)
                if code:
                    raise RuntimeError(f"Fixture exited {code}; preserve its logs and partial recording")
            finally:
                if fixture.poll() is None:
                    os.killpg(fixture.pid, signal.SIGTERM)
                    try:
                        fixture.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(fixture.pid, signal.SIGKILL)
                        fixture.wait()
        report = {"variant": args.variant, "sfu_binary_sha256": binary_hash,
                  "guests": guests, "mode": mode, "seconds": seconds,
                  "packet_profile": "audio-jitter", "report_interval_ms": 250,
                  "delayed_request_ms": 500 if args.variant == "candidate" else None,
                  "physical_speaker_playout_used": False, "g1_complete": False}
        (LAB / f"evidence/sfu-{prefix}-conditions.json").write_text(json.dumps(report, indent=2) + "\n")
        print("Completed", run_name)
    finally:
        for process in reversed(owned):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        for stream in logs:
            stream.close()


if __name__ == "__main__":
    main()
