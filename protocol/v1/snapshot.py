#!/usr/bin/env python3
"""Freeze, verify and check out a Producer production. Requires producer-core and OpenSSH."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

NAMESPACE = "producer.bundle.v1"
LIMIT = 8 * 1024 * 1024


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Expected a regular file at {path}")
    return path


def bounded(path):
    with regular(path).open("rb") as stream:
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError(f"Metadata exceeds byte limit at {path}")
    return data


def unique(fields):
    obj = {}
    for key, value in fields:
        if key in obj:
            raise ValueError(f"Duplicate JSON key {key}")
        obj[key] = value
    return obj


def read_manifest(folder):
    return json.loads(bounded(folder / "manifest.json"), object_pairs_hook=unique)


def dump(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def core(args, *options):
    return json.loads(subprocess.check_output([args.core, *options]))


def verify(args, directory):
    # allowed_signers belongs to the receiving studio. Never import trust from a bundle.
    payload = bounded(directory / "manifest.json")
    manifest = json.loads(payload, object_pairs_hook=unique)
    author = manifest["actors"][manifest["author"]]["identity"]
    verified = subprocess.run(["ssh-keygen", "-Y", "verify", "-f", args.trust, "-I", author,
                               "-n", NAMESPACE, "-s", regular(directory / "manifest.json.sig")],
                              input=payload, stdout=subprocess.DEVNULL)
    if verified.returncode:
        raise ValueError("Snapshot signature or locally trusted signer did not verify")
    receipt = core(args, "bundle-check", directory)
    if hashlib.sha256(payload).hexdigest() != receipt["revision"]:
        raise ValueError("Manifest changed during verification")
    return receipt


def lineage(child, parent):
    if child.get("parent") != (parent and parent["revision"]):
        raise ValueError("Draft parent differs from supplied base revision")
    if parent and (child["production"] != parent["production"] or child["authoredAt"] < parent["authoredAt"]):
        raise ValueError("Child production or chronology differs from base")


def copy_payload(src, dst, manifest):
    doc = bounded(src / "production.json")
    (dst / "production.json").write_bytes(doc)
    blobs = dst / "blobs"
    blobs.mkdir()
    if (src / "blobs").is_symlink():
        raise ValueError("Blob directory cannot be a symlink")
    digests = {rep["sha256"] for media in manifest["assets"].values()
               for rep in [media["original"], *media.get("proxies", [])]}
    digests.update(s["arrangementSha256"] for s in manifest.get("musicSessions", {}).values())
    for digest in digests:
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid blob digest")
        shutil.copyfile(regular(src / "blobs" / digest), blobs / digest)
    return hashlib.sha256(doc).hexdigest()


def run(args):
    src = args.source
    if args.command == "compare":
        from revisions import report
        before = verify(args, args.parent)
        after = verify(args, src)
        lineage(after, before)
        return report(args.parent, src, before, after, bounded)
    if args.command == "verify":
        receipt = verify(args, src)
        if args.parent:
            lineage(receipt, verify(args, args.parent))
        return receipt
    # Stage next to the destination. Failed copies/signatures never expose partial output.
    dest = args.destination
    if dest.exists() or dest.is_symlink() or src.resolve() in dest.resolve().parents:
        raise ValueError("Choose a fresh destination outside the source")
    base = verify(args, src) if args.command == "checkout" else None
    manifest = read_manifest(src)
    with tempfile.TemporaryDirectory(prefix=".producer-", dir=dest.parent) as td:
        stage = Path(td) / "package"
        stage.mkdir()
        doc_hash = copy_payload(src, stage, manifest)
        if args.command == "checkout":
            if hashlib.sha256(bounded(src / "manifest.json")).hexdigest() != base["revision"]:
                raise ValueError("Base changed during checkout")
            # Check the staged bytes against the verified snapshot before opening the draft.
            (stage / "manifest.json").write_bytes(bounded(src / "manifest.json"))
            if core(args, "bundle-check", stage)["revision"] != base["revision"]:
                raise ValueError("Snapshot changed while copying")
            manifest = read_manifest(stage)
            manifest["parent"] = base["revision"]
            dump(stage / "manifest.json", manifest)
            result = {"base": base["revision"]}
        else:
            parent = verify(args, args.parent) if args.parent else None
            manifest["documentSha256"] = doc_hash
            manifest["authoredAt"] = int(time.time()) if args.at is None else args.at
            lineage(manifest, parent)
            dump(stage / "manifest.json", manifest)
            core(args, "bundle-check", stage)
            subprocess.run(["ssh-keygen", "-q", "-Y", "sign", "-f", args.key,
                            "-n", NAMESPACE, stage / "manifest.json"], check=True)
            result = verify(args, stage)
        stage.rename(dest)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", default=os.environ.get("PRODUCER_CORE", "producer-core"))
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ["verify", "compare", "checkout", "freeze"]:
        cmd = commands.add_parser(name)
        cmd.add_argument("source", type=Path)
        cmd.add_argument("--trust", type=Path, required=True, help="local OpenSSH allowed_signers file")
        if name in ("checkout", "freeze"):
            cmd.add_argument("destination", type=Path)
        if name in ("verify", "compare", "freeze"):
            cmd.add_argument("--parent", type=Path, required=name == "compare")
        if name == "freeze":
            cmd.add_argument("--key", type=Path, required=True)
            cmd.add_argument("--at", type=int, help="authored UTC epoch seconds")
    try:
        print(json.dumps(run(parser.parse_args()), indent=2))
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"snapshot: {exc}\n")


if __name__ == "__main__":
    main()
