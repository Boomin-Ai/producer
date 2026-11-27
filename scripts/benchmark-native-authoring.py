#!/usr/bin/env python3
"""Compare native Producer builds on one brief, using isolated offscreen studios.

    python3 scripts/benchmark-native-authoring.py baseline-bin candidate-bin \
        --fixture blank-room --brief create.txt --out qualification-create --pairs 3

The fixture directory supplies room.json, any local assets and starter installation
receipts. Use a prepared set fixture and an edit brief to benchmark revisions. Each
trial has fresh model history. Production stays offline; proposals await review.
Private journals beside the summary retain the exact proposal for visual grading.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import time


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def rpc(room, op, **kwargs):
    prefix = hashlib.sha256(os.fsencode(room)).hexdigest()[:12]
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(8)
        client.connect(f"/tmp/producer-native-{os.getuid()}-{prefix}.sock")
        client.sendall(json.dumps({"op": op, **kwargs}).encode())
        client.shutdown(socket.SHUT_WR)
        result = json.load(client.makefile())
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "Studio rejected request"))
    return result


def summarize(journal):
    events = [json.loads(line) for line in journal.read_text().splitlines()]
    def matching(name):
        return [e for e in events if e["event"] == name]
    starts = matching("model_call_started")
    ended = [e for e in events if e["event"] in ("model_call_finished", "model_call_failed")]
    measured_model_ms = sum(e["data"]["durationMs"] for e in ended)
    usage = {}
    for event in matching("provider_event"):
        data = event["data"]
        reported = data["detail"].get("usage")
        if reported:
            usage[data["call"]] = reported
    attempts = matching("authoring_attempt")
    finish = matching("turn_finished")[-1]
    validated = matching("validation_passed")
    proposals = matching("proposal")
    timings = finish["data"].get("steps", [])
    return {
        "outcome": finish["data"]["outcome"], "error": finish["data"].get("error"),
        "models": sorted({e["data"]["model"] for e in starts}),
        "turnMs": finish["elapsedMs"],
        "validationMsSinceSubmit": validated[-1]["elapsedMs"] if validated else None,
        "firstModelCallMsSinceSubmit": starts[0]["elapsedMs"] if starts else None,
        "recoveredDraft": bool(matching("preview_recovered")),
        "modelCalls": len(starts), "repairAttempts": max(0, len(attempts) - 1),
        "inputBytesAcrossCalls": sum(e["data"]["inputBytes"] for e in starts),
        "completedModelCallMs": measured_model_ms,
        "modelMs": measured_model_ms if len(ended) == len(starts) else None,
        "callsWithProviderUsage": len(usage),
        "inputTokens": sum(x["input_tokens"] for x in usage.values()) if starts and len(usage) == len(starts) else None,
        "outputTokens": sum(x["output_tokens"] for x in usage.values()) if starts and len(usage) == len(starts) else None,
        "localPreparationMs": validated[-1]["elapsedMs"] - proposals[-1]["elapsedMs"] if validated and proposals else None,
        "renderSteps": [s for s in timings if s["label"].startswith("Render ")],
        "validationFailures": [e["data"].get("error") for e in matching("validation_failed")],
    }


def run(binary, fixture, prompt, room, timeout, legacy=False):
    room.mkdir(mode=0o700)
    seed = json.loads((fixture / "room.json").read_text())
    # Earlier RoomProject schemas reject the new private authoring source field.
    # Both studios must still receive byte-equivalent playable production data.
    if legacy:
        seed.pop("authoredDesigns", None)
    (room / "room.json").write_text(json.dumps(seed))

    for receipt in fixture.glob("starter-sets-*.installed"):
        shutil.copyfile(receipt, room / receipt.name)
    if (fixture / "assets").is_dir():
        shutil.copytree(fixture / "assets", room / "assets")
    (room / "boomin-session.json").write_text('{"local":true}')
    env = dict(os.environ, PRODUCER_NATIVE_ROOM_HOME=str(room), PRODUCER_NO_AUTO_CAPTURE="1",
               PRODUCER_DEV_OPEN_LOCAL_ROOM="1")
    with (room / "native.log").open("w") as log:
        proc = subprocess.Popen([str(binary), "--tree", str(room / "tree.json"), "--realtime",
                                 "--fps", "8", "--frames", str(8 * (timeout + 90)), "--scale",
                                 "1", "--size", "1280x720"], env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise RuntimeError(f"Producer exited with {proc.returncode}")
                try:
                    status = rpc(room, "assistantStatus")
                    break
                except (OSError, RuntimeError, ValueError):
                    time.sleep(.25)
            else:
                raise RuntimeError("Offscreen studio failed to initialize")
            if status["busy"]:
                raise RuntimeError("Fresh studio was already busy")
            project = rpc(room, "state")["state"]["project"]
            playable = {k: project[k] for k in ("production", "canvas", "mountedSet", "mountedLayout")}
            project_bytes = json.dumps(playable, sort_keys=True, separators=(",", ":")).encode()
            generation = rpc(room, "assistantSend", prompt=prompt)["generation"]
            journal = None
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                status = rpc(room, "assistantStatus")
                if status.get("logTurnId") and str(status["logTurnId"]).endswith(f"-{generation}"):
                    journal = room / "assistant-logs" / (status["logTurnId"] + ".jsonl")
                if journal and not status["busy"] and '"event":"turn_finished"' in journal.read_text():
                    return dict(summarize(journal), reviewReady=status["reviewReady"],
                                initialPlayableSha256=hashlib.sha256(project_bytes).hexdigest(),
                                journal=str(journal.relative_to(room.parent)))
                time.sleep(.4)
            rpc(room, "assistantStop", generation=generation)
            raise TimeoutError(f"No completed turn after {timeout}s")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("baseline", type=Path)
    p.add_argument("candidate", type=Path)
    p.add_argument("--fixture", type=Path, required=True)
    p.add_argument("--brief", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--pairs", type=int, default=1)
    p.add_argument("--timeout", type=int, default=360)
    args = p.parse_args()
    prompt = args.brief.read_text().strip()
    if not 0 < len(prompt.encode()) <= 4096 or args.pairs < 1 or args.timeout < 1:
        p.error("Supply a 1–4096 byte brief, positive timeout and at least one pair.")
    bins = {"baseline": args.baseline.resolve(), "candidate": args.candidate.resolve()}
    report = {
        "hardware": subprocess.check_output(["sysctl", "-n", "hw.model"], text=True).strip(),
        "os": platform.platform(), "brief": prompt, "fixtureSha256": digest(args.fixture / "room.json"),
        "binarySha256": {k: digest(b) for k, b in bins.items()}, "trials": [],
        "endpoint": "Validated proposal ready for human review. Final visual acceptance is graded separately.",
    }
    out = args.out.resolve()
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    for index in range(args.pairs):
        for name in (("baseline", "candidate") if index % 2 == 0 else ("candidate", "baseline")):
            room = out / f"{index + 1:02}-{name}"
            try:
                trial = run(bins[name], args.fixture, prompt, room, args.timeout, legacy=(name == "baseline"))
            except (OSError, RuntimeError, ValueError, TimeoutError) as e:
                trial = {"outcome": "harness_error", "error": str(e), "reviewReady": False}
            report["trials"].append(dict(trial, arm=name, pair=index + 1))
            (out / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
            print(f"{room.name}: {trial['outcome']}, review ready {trial['reviewReady']}", flush=True)


if __name__ == "__main__":
    main()
