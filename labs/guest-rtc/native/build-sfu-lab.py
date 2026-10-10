#!/usr/bin/env python3
"""Reproduce the pinned, loopback-only sender-report cadence experiment.

Downloads/builds only below runtime/. No credentials or deployed configuration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "runtime"
MANIFEST = json.loads((ROOT / "evidence/sfu-build-provenance.json").read_text())


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def download(url, path, expected):
    with urllib.request.urlopen(url, timeout=60) as incoming, path.open("wb") as out:
        shutil.copyfileobj(incoming, out)
    if digest(path) != expected:
        path.unlink()
        raise RuntimeError("Archive checksum mismatch: " + url)


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def prepare(early_report=False):
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("Pinned compiler archive is for macOS arm64 only")
    RUNTIME.mkdir(exist_ok=True)
    sdk = RUNTIME / "go-sdk"
    go = sdk / "go/bin/go"
    if not go.exists():
        archive = RUNTIME / "go-sdk.tar.gz"
        download("https://go.dev/dl/go1.26.0.darwin-arm64.tar.gz", archive,
                 MANIFEST["go_archive_sha256"])
        sdk.mkdir(exist_ok=True)
        run("tar", "-xzf", str(archive), "-C", str(sdk))
        archive.unlink()
    version = subprocess.check_output([str(go), "version"], text=True).strip()
    if version != "go version go1.26.0 darwin/arm64":
        raise RuntimeError("Unexpected compiler: " + version)
    source = RUNTIME / "livekit-sfu-source"
    patch = ROOT / "native/sfu-cadence.patch"
    if digest(patch) != MANIFEST["patch_sha256"]:
        raise RuntimeError("Patch provenance mismatch")
    if not source.exists():
        archive = RUNTIME / "livekit-sfu-source.tar.gz"
        download("https://codeload.github.com/livekit/livekit/tar.gz/" +
                 MANIFEST["sfu_commit"], archive, MANIFEST["source_archive_sha256"])
        source.mkdir()
        run("tar", "-xzf", str(archive), "--strip-components=1", "-C", str(source))
        archive.unlink()
    participant = source / "pkg/rtc/participant.go"
    if digest(participant) == MANIFEST["upstream_participant_sha256"]:
        if digest(source / "pkg/sfu/downtrack.go") != MANIFEST["upstream_downtrack_sha256"]:
            raise RuntimeError("Upstream downtrack source mismatch")
        run("patch", "--batch", "-p1", "-i", str(patch), cwd=source)
    for name, expected in MANIFEST["patched_files_sha256"].items():
        if digest(source / name) != expected:
            raise RuntimeError("Patched source mismatch: " + name)
    early_manifest_path = ROOT / "evidence/sfu-early-report-provenance.json"
    if early_manifest_path.exists():
        early = json.loads(early_manifest_path.read_text())
        buffer = source / "pkg/sfu/buffer/buffer.go"
        if early_report:
            patch = ROOT / "native/sfu-early-report.patch"
            if digest(patch) != early["patch_sha256"]:
                raise RuntimeError("Early-report patch provenance mismatch")
            if digest(buffer) == early["upstream_buffer_sha256"]:
                run("patch", "--batch", "-p1", "-i", str(patch), cwd=source)
            for name, expected in early["patched_files_sha256"].items():
                if digest(source / name) != expected:
                    raise RuntimeError("Early-report source mismatch: " + name)
        elif digest(buffer) != early["upstream_buffer_sha256"]:
            raise RuntimeError("Source contains the early-report patch; use --early-report or a fresh runtime source directory")
    return go, source


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--early-report", action="store_true",
                        help="Also apply the bounded RFC 6051 audio timing request experiment")
    args = parser.parse_args()
    go, source = prepare(args.early_report)
    if args.prepare_only:
        print("Verified pinned compiler and patched SFU source")
        return
    if shutil.disk_usage(RUNTIME).free < 1024 ** 3:
        raise RuntimeError("Need at least 1 GiB free before compiling; more may be required")
    env = dict(os.environ, GOMAXPROCS="1", GOMEMLIMIT="128MiB", GOTOOLCHAIN="local",
               GOCACHE=str(RUNTIME / "go-build-cache"), GOPATH=str(RUNTIME / "go-work"))
    run(str(go), "-C", str(source), "test", "pkg/rtc/lab_sender_report_interval.go",
        "pkg/rtc/lab_sender_report_interval_test.go", env=env)
    if args.early_report:
        run(str(go), "-C", str(source), "test", "pkg/sfu/buffer/lab_sr_request.go",
            "pkg/sfu/buffer/lab_sr_request_test.go", env=env)
    binary = RUNTIME / ("livekit-server-early-report-lab" if args.early_report
                        else "livekit-server-cadence-lab")
    run(str(go), "-C", str(source), "build", "-p", "1", "-trimpath",
        "-ldflags=-s -w", "-o", str(binary), "./cmd/server", env=env)
    print("Built isolated SFU:", binary, "sha256:", digest(binary))


if __name__ == "__main__":
    main()
