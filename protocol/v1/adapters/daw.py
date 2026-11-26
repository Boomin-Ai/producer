#!/usr/bin/env python3
"""Exchange an editable DAWproject score and its synchronized PCM stem."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import wave

SNAPSHOT = Path(__file__).resolve().parents[1] / "snapshot.py"


def run(*args):
    return json.loads(subprocess.check_output(list(map(str, args))))


def load(path):
    return json.loads(path.read_bytes())


def save(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def put_blob(directory, source):
    with source.open("rb") as reader, tempfile.NamedTemporaryFile(dir=directory) as tmp:
        checksum = hashlib.sha256()
        for chunk in iter(lambda: reader.read(1024 * 1024), b""):
            tmp.write(chunk)
            checksum.update(chunk)
        tmp.flush()
        digest = checksum.hexdigest()
        target = directory / digest
        if not target.exists():
            os.link(tmp.name, target)
    return digest


def exchange(args):
    snap = [sys.executable, SNAPSHOT, "--core", args.core]
    receipt = run(*snap, "verify", args.bundle, "--trust", args.trust)
    manifest = load(args.bundle / "manifest.json")
    session = manifest["musicSessions"][args.session]
    doc = load(args.bundle / "production.json")
    seq = doc["sequences"][session["cut"]["sequence"]]
    clip = next(c for c in seq["placements"] if c["id"] == session["cut"]["placement"])
    cue = next(c for c in seq["cues"] if c["id"] == session["pictureCue"])
    asset = doc["sources"][clip["source"]]["asset"]
    handoff = {"production": receipt["production"], "base": receipt["revision"], "session": args.session,
               "pictureCue": cue, "sampleRateHz": session["sampleRateHz"]}
    if args.output.exists() or args.output.is_symlink():
        raise ValueError("Choose a fresh output directory")
    with tempfile.TemporaryDirectory(dir=args.output.parent) as tmp:
        work = Path(tmp) / "draft"
        if args.command == "export":
            work.mkdir()
            shutil.copyfile(args.bundle / "blobs" / session["arrangementSha256"], work / "score.dawproject")
            shutil.copyfile(args.bundle / "blobs" / doc["assets"][asset]["hash"], work / "stem.wav")
            save(work / "handoff.json", handoff)
        else:
            if load(args.returned / "handoff.json") != handoff:
                raise ValueError("Studio revision or picture cue changed since export")
            run(*snap, "checkout", args.bundle, work, "--trust", args.trust)
            manifest = load(work / "manifest.json")
            session = manifest["musicSessions"][args.session]
            stem = args.returned / "stem.wav"
            with wave.open(str(stem), "rb") as audio:
                if audio.getframerate() != session["sampleRateHz"]:
                    raise ValueError("Returned stem sample rate differs from the session")
            score_hash = put_blob(work / "blobs", args.returned / "score.dawproject")
            digest = put_blob(work / "blobs", stem)
            if score_hash != session["arrangementSha256"] and digest == doc["assets"][asset]["hash"]:
                raise ValueError("The score changed. Return a freshly rendered stem with the edit.")
            session["arrangementSha256"] = score_hash
            session["renderedFrom"] = score_hash
            session["renderedFrom"] = session["arrangementSha256"]
            digest = put_blob(work / "blobs", stem)
            if any(name != args.session and doc["sources"][next(c["source"] for c in doc["sequences"][s["cut"]["sequence"]]["placements"]
                   if c["id"] == s["cut"]["placement"])] .get("asset") == asset for name,s in manifest["musicSessions"].items()):
                raise ValueError("Shared stem belongs to another session")
            doc["assets"][asset]["hash"] = digest
            manifest["assets"][asset]["original"]["sha256"] = digest
            if digest != load(args.bundle / "production.json")["assets"][asset]["hash"]:
                manifest["assets"][asset]["proxies"] = []
            manifest["author"] = args.author
            save(work / "production.json", doc)
            manifest["documentSha256"] = hashlib.sha256((work / "production.json").read_bytes()).hexdigest()
            save(work / "manifest.json", manifest)
            run(args.core, "bundle-check", work)
            retained = {s["arrangementSha256"] for s in manifest["musicSessions"].values()}
            retained.update(rep["sha256"] for media in manifest["assets"].values()
                            for rep in [media["original"], *media.get("proxies", [])])
            for blob in (work / "blobs").iterdir():
                if blob.name not in retained:
                    blob.unlink()
        work.rename(args.output)
    return handoff


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", default=os.environ.get("PRODUCER_CORE", "producer-core"))
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ["export","import"]:
        command = commands.add_parser(name)
        command.add_argument("bundle", type=Path)
        command.add_argument("session")
        command.add_argument("output", type=Path)
        command.add_argument("--trust", required=True, type=Path)
        if name == "import":
            command.add_argument("--returned", required=True, type=Path)
            command.add_argument("--author", required=True)
    try:
        print(json.dumps(exchange(parser.parse_args())))
    except (OSError, KeyError, ValueError, StopIteration, wave.Error, subprocess.CalledProcessError) as error:
        parser.exit(1, f"DAW exchange failed: {error}\n")
