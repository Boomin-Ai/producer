#!/usr/bin/env python3
"""Generate the Apple Silicon channel manifest from the qualified release files."""

import argparse
import base64
import hashlib
import json
import re
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("artifact_directory", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", args.version):
        parser.error("version must be three numeric components")
    name = f"Producer_{args.version}_aarch64.app.tar.gz"
    folder = args.artifact_directory
    archive = folder / name
    length = archive.stat().st_size
    if not 0 < length <= 512 * 1024 * 1024:
        parser.error("unexpected updater archive size")
    with archive.open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    checksum = digest.hexdigest()
    sums = (folder / "SHA256SUMS").read_text().splitlines()
    if f"{checksum}  {name}" not in sums:
        parser.error("updater archive does not match SHA256SUMS")
    signature = (folder / (name + ".sig")).read_text().strip()
    base64.b64decode(signature, validate=True)
    args.output.write_text(json.dumps({
        "version": args.version,
        "length": length,
        "sha256": checksum,
        "signature": signature,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
