#!/usr/bin/env python3
"""Read-only macOS process-family profiling for an installed Producer app.

Examples:
  python3 scripts/profile-production.py --out /tmp/producer-baseline --duration 300
  python3 scripts/profile-production.py --pid 12345 --out /tmp/producer-baseline --duration 60
  python3 scripts/profile-production.py --out /tmp/producer-baseline --mark room.open
  python3 scripts/profile-production.py --out /tmp/producer-baseline --status

This does not modify, restart, inject into, or control Producer. It records no
command arguments, screen/audio, room names, text, URLs, credentials or keys.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import plistlib
import re
import resource
import signal
import stat
import subprocess
import sys
import time
import uuid

SCHEMA = "producer.external-profile/1"
MARKERS = (
    "baseline.begin", "baseline.end", "idle.begin", "idle.end", "room.open",
    "room.close", "workspace.switch", "set.apply", "layout.drop", "layout.select",
    "edit.enter", "edit.exit", "camera.toggle", "microphone.toggle", "click",
    "record.begin", "record.end", "stream.begin", "stream.end",
)
SUFFIX = "/Producer.app/Contents/MacOS/producer"
STOP = False


def stamp():
    return {"utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds"),
            "monotonic_ns": time.monotonic_ns()}


def cpu_seconds(value):
    """ps TIME: [[days-]hours:]minutes:seconds[.fraction]."""
    days = 0
    if "-" in value:
        day, value = value.split("-", 1)
        days = int(day)
    parts = value.split(":")
    if len(parts) not in (2, 3):
        raise ValueError("invalid ps CPU time")
    values = [float(p) for p in parts]
    if any(not math.isfinite(v) or v < 0 for v in values):
        raise ValueError("invalid ps CPU time")
    total = values[-1] + 60 * values[-2]
    if len(values) == 3:
        total += 3600 * values[0]
    return days * 86400 + total


def parse_ps(text):
    rows = {}
    for line in text.splitlines():
        # pid ppid [weekday month day hh:mm:ss year] time rss %cpu comm...
        fields = line.split(None, 10)
        if len(fields) != 11:
            continue
        try:
            pid, ppid = int(fields[0]), int(fields[1])
            start = " ".join(fields[2:7])
            dt.datetime.strptime(start, "%a %b %d %H:%M:%S %Y")
            seconds, rss, decay = cpu_seconds(fields[7]), int(fields[8]), float(fields[9])
            if pid <= 0 or rss < 0 or not math.isfinite(decay):
                continue
        except (ValueError, OverflowError):
            continue
        rows[pid] = {"pid": pid, "ppid": ppid, "start": start, "cpu_seconds": seconds,
                     "rss_kib": rss, "cpu_pct_ps_decay": decay, "exe": fields[10]}
    return rows


def read_processes(timeout=10):
    env = dict(os.environ, LC_ALL="C")
    result = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,lstart=,time=,rss=,%cpu=,comm="],
        text=True, capture_output=True, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError("macOS denied or failed ps access. Run this monitor from a terminal allowed to inspect processes; it never requests sudo or changes permissions.")
    return parse_ps(result.stdout)


def is_producer(row):
    return row["exe"].endswith(SUFFIX)


def family(rows, root):
    found = {root}
    changed = True
    while changed:
        before = len(found)
        found.update(pid for pid, row in rows.items() if row["ppid"] in found)
        changed = before != len(found)
    return {pid: rows[pid] for pid in found if pid in rows}


def role(row, root):
    if row["pid"] == root:
        return "app"
    name = Path(row["exe"]).name.lower()
    if "helper (gpu)" in name:
        return "cef_gpu"
    if "helper (renderer)" in name:
        return "cef_renderer"
    if "helper" in name:
        return "cef_utility"
    if "webkit" in name:
        return "associated_webkit"
    return "descendant_other"


def redact_path(path):
    try:
        return "~/" + str(Path(path).relative_to(Path.home()))
    except ValueError:
        return str(path)


def app_metadata(row, hash_binary=False):
    bundle = Path(row["exe"]).parents[2]
    record = {"pid": row["pid"], "process_start": row["start"],
              "bundle_path": redact_path(bundle), "binary_hash_requested": hash_binary}
    try:
        info = plistlib.loads((bundle / "Contents/Info.plist").read_bytes())
        for source, target in (("CFBundleIdentifier", "bundle_id"),
                               ("CFBundleShortVersionString", "version"),
                               ("CFBundleVersion", "build")):
            value = info.get(source)
            if isinstance(value, (str, int)):
                record[target] = value
        record["bundle_read_only_filesystem"] = bool(os.statvfs(bundle).f_flag & os.ST_RDONLY)
    except (OSError, ValueError, plistlib.InvalidFileException):
        record["bundle_metadata_unavailable"] = True
    if hash_binary:
        try:
            digest = hashlib.sha256()
            with Path(row["exe"]).open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            record["binary_file_sha256"] = digest.hexdigest()
        except OSError:
            record["binary_hash_unavailable"] = True
    return record


def nofollow_open(path, flags, mode=0o600):
    return os.open(str(path), flags | getattr(os, "O_NOFOLLOW", 0), mode)


def atomic_json(path, value):
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    fd = nofollow_open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, indent=2, allow_nan=False)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class Store:
    def __init__(self, directory, max_bytes, keep):
        self.directory, self.max_bytes, self.keep = directory, max_bytes, keep
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lock = nofollow_open(directory / ".write.lock", os.O_RDWR | os.O_CREAT)

    def append(self, name, record):
        data = (json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n").encode()
        if len(data) > self.max_bytes:
            raise RuntimeError("sample exceeds configured maximum file size")
        fcntl.flock(self.lock, fcntl.LOCK_EX)
        try:
            target = self.directory / name
            if target.is_symlink():
                raise RuntimeError("refusing a symlinked profile log")
            if target.exists() and target.stat().st_size + len(data) > self.max_bytes:
                (self.directory / (name + "." + str(self.keep))).unlink(missing_ok=True)
                for index in range(self.keep - 1, 0, -1):
                    old = self.directory / (name + "." + str(index))
                    if old.exists():
                        os.replace(old, self.directory / (name + "." + str(index + 1)))
                os.replace(target, self.directory / (name + ".1"))
            fd = nofollow_open(target, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
            with os.fdopen(fd, "ab") as handle:
                handle.write(data)
        finally:
            fcntl.flock(self.lock, fcntl.LOCK_UN)

    def close(self):
        os.close(self.lock)


def percent(current, previous, elapsed):
    if previous is None or current["start"] != previous["start"] or elapsed <= 0:
        return None
    delta = current["cpu_seconds"] - previous["cpu_seconds"]
    if delta < 0:
        return None
    return round(100 * delta / elapsed, 2)


def sampler_cpu():
    # RUSAGE_CHILDREN includes the completed /bin/ps child, including one reaped
    # by subprocess.run after a timeout. Never count Producer CPU as overhead.
    return (sum(resource.getrusage(resource.RUSAGE_SELF)[:2]),
            sum(resource.getrusage(resource.RUSAGE_CHILDREN)[:2]))


def sampler_metrics(previous, current, elapsed, collection_seconds):
    own, children = current
    own_delta, child_delta = own - previous[0], children - previous[1]
    return {"self_cpu_seconds": own, "child_cpu_seconds": children,
            "overhead_interval_seconds": elapsed,
            "self_cpu_pct_interval": round(100 * own_delta / elapsed, 3) if elapsed > 0 else None,
            "child_cpu_pct_interval": round(100 * child_delta / elapsed, 3) if elapsed > 0 else None,
            "combined_cpu_pct_interval": round(100 * (own_delta + child_delta) / elapsed, 3) if elapsed > 0 else None,
            "ps_and_collection_ms": round(1000 * collection_seconds, 2)}


def retry_seconds(consecutive_errors, interval):
    return min(30.0, max(1.0, interval) * 2 ** min(consecutive_errors - 1, 5))


def run(args):
    global STOP
    directory = args.out.expanduser().resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    owner = nofollow_open(directory / ".monitor.lock", os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(owner)
        raise RuntimeError("another monitor is already writing to this directory")
    store = Store(directory, args.max_mb * 1024 * 1024, args.keep)
    session = uuid.uuid4().hex
    started = stamp()
    metadata = {"schema": SCHEMA, "session": session, "started": started,
                "sampler_pid": os.getpid(), "platform": platform.platform(),
                "logical_cpus": os.cpu_count(), "interval_seconds": args.interval,
                "duration_seconds": args.duration, "requested_pid": args.pid,
                "follow_restarts": args.follow_restarts,
                "rotation": {"max_file_bytes": store.max_bytes, "archives_per_log": args.keep},
                "limitations": [
                    "CPU interval values use ps cumulative CPU-time deltas; 100% equals one logical CPU core.",
                    "ps CPU time is quantized; short-lived/exited processes can be missed between polls.",
                    "RSS sums can double-count shared memory; they are not unique physical footprint.",
                    "Orphaned XPC WebKit processes are not attributed or included without proven parentage.",
                    "No GPU percentage, native stack sampling, click interception, room timing or device/output status is collected.",
                    "Markers are manual operator events, not proof a click occurred or an operation completed.",
                    "This monitor does not modify or attach to the signed app and has its own measurable overhead.",
                    "Sampler overhead includes this Python process and completed ps children; it excludes external tools and filesystem/kernel costs not charged to them.",
                ]}
    atomic_json(directory / "session.json", metadata)
    start_clock, last_clock = time.monotonic(), None
    last_rows, last_family = {}, {}
    root_pid, root_start = args.pid, None
    previous_usage, usage_clock = sampler_cpu(), start_clock
    samples, failures, consecutive_errors, state = 0, 0, 0, "starting"
    status = {"schema": SCHEMA, "session": session, "sampler_pid": os.getpid(),
              "running": True, "samples": samples, **stamp()}
    atomic_json(directory / "status.json", status)
    try:
        while not STOP:
            cycle_started = time.monotonic()
            if args.duration and cycle_started - start_clock >= args.duration:
                break
            deadline_remaining = args.duration - (cycle_started - start_clock) if args.duration else None
            try:
                # A slow ps must not overrun a bounded observation by 10 seconds.
                rows = read_processes(timeout=min(10, deadline_remaining) if deadline_remaining is not None else 10)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                failures += 1
                consecutive_errors += 1
                now = time.monotonic()
                usage = sampler_cpu()
                sampler = sampler_metrics(previous_usage, usage, now - usage_clock, now - cycle_started)
                previous_usage, usage_clock = usage, now
                # Do not serialize exception text, stderr, or command arguments.
                category = "ps_timeout" if isinstance(error, subprocess.TimeoutExpired) else "ps_unavailable"
                delay = retry_seconds(consecutive_errors, args.interval)
                if args.duration:
                    delay = max(0.0, min(delay, args.duration - (now - start_clock)))
                record = {"schema": SCHEMA, "session": session, "kind": "sampler_error", **stamp(),
                          "state": "sampler_error", "category": category,
                          "root_pid": root_pid, "samples": samples,
                          "failure_count": failures, "consecutive_errors": consecutive_errors,
                          "retry_seconds": delay, "sampler": sampler}
                store.append("samples.jsonl", record)
                status = {**record, "sampler_pid": os.getpid(), "running": True,
                          "last_observed_app_state": state}
                atomic_json(directory / "status.json", status)
                if delay > 0:
                    time.sleep(delay)
                # Keep last successful process/clock baselines. The next CPU
                # delta spans the actual gap instead of reporting a false zero.
                continue
            recovered_errors = consecutive_errors
            consecutive_errors = 0
            root = rows.get(root_pid) if root_pid else None
            if root and (not is_producer(root) or root_start and root["start"] != root_start):
                root = None  # Never attribute a reused PID to a previous Producer.
            if root is None and (root_pid is None or args.follow_restarts and not args.pid):
                candidates = [row for row in rows.values() if is_producer(row)]
                if len(candidates) > 1:
                    raise RuntimeError("multiple Producer instances detected; specify --pid to avoid mixing baselines (PIDs: " + ", ".join(str(r["pid"]) for r in candidates) + ")")
                root = candidates[0] if candidates else None
            if root:
                if root_start != root["start"] or root_pid != root["pid"]:
                    root_pid, root_start = root["pid"], root["start"]
                    last_rows, last_family = {}, {}
                    store.append("samples.jsonl", {"schema": SCHEMA, "session": session,
                                 "kind": "app_detected", **stamp(), **app_metadata(root, args.hash_binary)})
                current = family(rows, root_pid)
                state = "observing"
            else:
                current, state = {}, "waiting_for_app" if root_start is None else "app_exited"
            now = time.monotonic()
            elapsed = now - last_clock if last_clock is not None else None
            processes = []
            counts = {}
            for pid, row in sorted(current.items()):
                tag = role(row, root_pid)
                counts[tag] = counts.get(tag, 0) + 1
                processes.append({"pid": pid, "ppid": row["ppid"], "process_start": row["start"],
                                  "role": tag, "cpu_seconds": row["cpu_seconds"],
                                  "cpu_pct_interval": percent(row, last_rows.get(pid), elapsed or 0),
                                  "cpu_pct_ps_decay": row["cpu_pct_ps_decay"], "rss_kib": row["rss_kib"]})
            known = [p["cpu_pct_interval"] for p in processes if p["cpu_pct_interval"] is not None]
            usage = sampler_cpu()
            record = {"schema": SCHEMA, "session": session, "kind": "sample", **stamp(),
                      "state": state, "root_pid": root_pid, "interval_seconds": elapsed,
                      "sampler_failures_total": failures, "recovered_sampler_errors": recovered_errors,
                      "processes": processes,
                      "aggregate": {"cpu_pct_interval_sum": round(sum(known), 2) if known else None,
                                    "cpu_interval_complete": bool(processes) and len(known) == len(processes),
                                    "unknown_interval_processes": len(processes) - len(known),
                                    "rss_sum_kib_not_unique": sum(p["rss_kib"] for p in processes),
                                    "process_count": len(processes), "role_counts": counts},
                      "spawned_pids": sorted(set(current) - set(last_family)),
                      "departed_pids": sorted(set(last_family) - set(current)),
                      "unattributed_webkit_process_count": sum("WebKit.WebContent" in r["exe"] and pid not in current for pid, r in rows.items()),
                      "sampler": sampler_metrics(previous_usage, usage, now - usage_clock, now - cycle_started)}
            store.append("samples.jsonl", record)
            samples += 1
            status = {"schema": SCHEMA, "session": session, "sampler_pid": os.getpid(),
                      "running": True, "state": state, "root_pid": root_pid, "samples": samples,
                      "failure_count": failures, "consecutive_errors": consecutive_errors,
                      "aggregate": record["aggregate"], **stamp()}
            atomic_json(directory / "status.json", status)
            last_rows, last_family, last_clock = current, current, now
            previous_usage, usage_clock = usage, now
            remaining = args.interval - (time.monotonic() - cycle_started)
            if args.duration:
                remaining = min(remaining, args.duration - (time.monotonic() - start_clock))
            if remaining > 0:
                time.sleep(remaining)
    finally:
        status.update({"running": False, "state": "stopped", "last_observed_state": state,
                       "samples": samples, "failure_count": failures, **stamp()})
        atomic_json(directory / "status.json", status)
        store.close()
        fcntl.flock(owner, fcntl.LOCK_UN)
        os.close(owner)
    print(json.dumps({"out": str(directory), "samples": samples, "state": state}))


def self_test():
    assert cpu_seconds("2:03.45") == 123.45
    assert cpu_seconds("1:02:03.50") == 3723.5
    assert cpu_seconds("2-01:02:03") == 176523
    for value in ("nan:01", "bad", "1:-2", "1:inf"):
        try:
            cpu_seconds(value)
            raise AssertionError(value)
        except ValueError:
            pass
    text = "123 1 Wed Nov 4 10:21:30 2026 2:03.45 1024 99.2 /Applications/Producer.app/Contents/MacOS/producer\n124 123 Wed Nov 4 10:21:31 2026 0:01.10 2048 4.0 /Applications/Producer.app/Contents/Frameworks/Producer Helper (GPU).app/Contents/MacOS/Producer Helper (GPU)\n125 1 Wed Nov 4 10:21:31 2026 0:12.10 4096 8.0 /System/Library/WebKit.WebContent\n"
    rows = parse_ps(text)
    assert len(rows) == 3 and is_producer(rows[123])
    selected = family(rows, 123)
    assert set(selected) == {123, 124} and role(rows[124], 123) == "cef_gpu"
    before = dict(rows[123], cpu_seconds=120)
    assert percent(rows[123], before, 2) == 172.5
    assert percent(rows[123], dict(before, start="different"), 2) is None
    assert percent(rows[123], dict(before, cpu_seconds=999), 2) is None
    import tempfile
    with tempfile.TemporaryDirectory() as directory:
        out = Path(directory)
        store = Store(out, 100, 2)
        for index in range(10):
            store.append("test.jsonl", {"sample": index, "padding": "x" * 30})
        assert len(list(out.glob("test.jsonl*"))) <= 3
        assert all(p.stat().st_size <= 100 for p in out.glob("test.jsonl*"))
        atomic_json(out / "status.json", {"state": "stopped"})
        assert json.loads((out / "status.json").read_text())["state"] == "stopped"
        store.close()
    assert retry_seconds(1, 0.5) == 1 and retry_seconds(99, 2) == 30
    metrics = sampler_metrics((1, 2), (1.1, 2.2), 2, .1)
    assert metrics["combined_cpu_pct_interval"] == 15
    assert metrics["child_cpu_pct_interval"] == 10
    # Simulate one ps timeout followed by recovery without invoking ps or sleeping.
    from unittest.mock import patch
    from types import SimpleNamespace
    import contextlib
    import io
    clock, attempts = [100.0], [0]
    def fake_read(timeout=10):
        assert 0 < timeout <= 10
        attempts[0] += 1
        if attempts[0] == 1:
            raise subprocess.TimeoutExpired(["ps"], timeout)
        return rows
    def fake_sleep(seconds):
        clock[0] += max(seconds, .000001)
    with tempfile.TemporaryDirectory() as directory:
        args = SimpleNamespace(out=Path(directory), max_mb=1, keep=1, interval=.5,
                               duration=2.1, pid=123, follow_restarts=False, hash_binary=False)
        with patch(__name__ + ".read_processes", fake_read), patch("time.monotonic", lambda: clock[0]), patch("time.sleep", fake_sleep), contextlib.redirect_stdout(io.StringIO()):
            run(args)
        records = [json.loads(line) for line in (Path(directory) / "samples.jsonl").read_text().splitlines()]
        assert records[0]["kind"] == "sampler_error" and records[0]["category"] == "ps_timeout"
        successful = [record for record in records if record["kind"] == "sample"]
        assert successful and successful[0]["recovered_sampler_errors"] == 1
        assert "child_cpu_pct_interval" in successful[0]["sampler"]
        assert clock[0] <= 102.100001
        status = json.loads((Path(directory) / "status.json").read_text())
        assert status["running"] is False and status["failure_count"] == 1
    print("PASS: CPU parsing/deltas, PID reuse, family attribution, orphan exclusion, bounded rotation, atomic status, sampler timeout recovery/backoff/deadline, child overhead")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, help="Profile directory. Logs rotate; session/status metadata is replaced on a new run.")
    parser.add_argument("--pid", type=int, help="Pin to one Producer PID and its start identity; never follows PID reuse.")
    parser.add_argument("--duration", type=float, default=300, help="Seconds to observe; 0 runs until interrupted. Default: 300.")
    parser.add_argument("--interval", type=float, default=2, help="Poll interval in seconds, minimum 0.5. Default: 2.")
    parser.add_argument("--follow-restarts", action="store_true", help="In auto-detect mode, follow a single new Producer after the prior app exits.")
    parser.add_argument("--hash-binary", action="store_true", help="Record SHA-256 of the executable file when an app is detected; adds one-time I/O.")
    parser.add_argument("--max-mb", type=int, default=16, help="Maximum size of each JSONL file, MiB. Default: 16.")
    parser.add_argument("--keep", type=int, default=3, help="Archives per JSONL file, in addition to the current file. Default: 3.")
    parser.add_argument("--mark", choices=MARKERS, help="Append a manual category marker to an existing session and exit. No custom text is accepted.")
    parser.add_argument("--status", action="store_true", help="Print the last saved monitor status and exit; it may be stale after an unclean shutdown.")
    parser.add_argument("--self-test", action="store_true", help="Exercise parsers/rotation without reading process data.")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.out is None:
        parser.error("--out is required")
    if not math.isfinite(args.duration) or args.duration < 0 or not math.isfinite(args.interval) or args.interval < 0.5:
        parser.error("duration must be finite and nonnegative; interval must be finite and at least 0.5s")
    if not 1 <= args.max_mb <= 128 or not 1 <= args.keep <= 10:
        parser.error("--max-mb must be 1–128 and --keep 1–10")
    if args.pid is not None and args.pid <= 0:
        parser.error("--pid must be positive")
    if args.pid and args.follow_restarts:
        parser.error("--follow-restarts is only available with automatic PID detection")
    if args.status and args.mark:
        parser.error("--status and --mark are mutually exclusive")
    if args.status:
        print((args.out.expanduser().resolve() / "status.json").read_text())
        return
    if args.mark:
        directory = args.out.expanduser().resolve()
        meta = json.loads((directory / "session.json").read_text())
        rotation = meta["rotation"]
        store = Store(directory, rotation["max_file_bytes"], rotation["archives_per_log"])
        try:
            record = {"schema": SCHEMA, "session": meta["session"], "kind": "manual_marker", "category": args.mark, **stamp()}
            store.append("markers.jsonl", record)
            print(json.dumps(record))
        finally:
            store.close()
        return
    if sys.platform != "darwin":
        parser.error("process collection currently supports macOS only; --self-test is portable")
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: globals().__setitem__("STOP", True))
    run(args)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print("Profile monitor: " + str(error), file=sys.stderr)
        raise SystemExit(1)
