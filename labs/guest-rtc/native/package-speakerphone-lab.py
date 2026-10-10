#!/usr/bin/env python3
"""Package the isolated physical lab with its own microphone permission identity."""
import hashlib
import json
import plistlib
import shutil
import subprocess
from pathlib import Path

LAB = Path(__file__).resolve().parents[1]
BINARY = LAB / "target/debug/producer-speakerphone-lab"
APP = Path.home() / "Applications/Producer Speakerphone Lab.app"
if not BINARY.exists() or BINARY.stat().st_size < 1_000_000:
    raise RuntimeError("Build the physical-aec native binary first")
subprocess.run([str(BINARY), "--self-test"], check=True)
macos = APP / "Contents/MacOS"
macos.mkdir(parents=True, exist_ok=True)
shutil.copy2(BINARY, macos / BINARY.name)
resources = APP / "Contents/Resources"
resources.mkdir(exist_ok=True)
shutil.copy2(LAB / "runtime/near-speech.wav", resources / "far-speech.wav")
info = {"CFBundleExecutable": BINARY.name,
        "CFBundleIdentifier": "ai.boomin.producer.speakerphone-lab",
        "CFBundleName": "Producer Speakerphone Lab",
        "CFBundleDisplayName": "Producer Speakerphone Lab",
        "CFBundleVersion": "1", "CFBundleShortVersionString": "0.1",
        "CFBundlePackageType": "APPL", "LSMinimumSystemVersion": "13.0",
        "NSMicrophoneUsageDescription": "Record a local speakerphone echo-cancellation test. Microphone audio is never played or published.",
        "NSHighResolutionCapable": True}
(APP / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
subprocess.run(["codesign", "--force", "--sign", "-", str(APP)], check=True)
subprocess.run(["codesign", "--verify", "--strict", str(APP)], check=True)
report = {"binary_sha256": hashlib.sha256(BINARY.read_bytes()).hexdigest(),
          "application_location": "~/Applications/Producer Speakerphone Lab.app",
          "default_capture_root": "~/Library/Application Support/Producer Guest RTC Lab",
          "physical_aec_profile": "no_forced_high_pass",
          "bundled_speech_sha256": hashlib.sha256((resources / "far-speech.wav").read_bytes()).hexdigest(),
          "native_queue_and_partial_initialization_cycles": 20,
          "signing": "ad hoc development signature; not a production release or Apple notarization",
          "hardware_capture_started_by_packaging": False,
          "physical_aec_qualified": False, "g1_complete": False}
(LAB / "evidence/speakerphone-lab-build.json").write_text(json.dumps(report, indent=2) + "\n")
print(APP)
