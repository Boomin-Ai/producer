#!/usr/bin/env python3
"""Merge the darwin-aarch64 entry into a Tauri updater manifest.

Usage: SIG=<sig> REPO=<owner/repo> merge-update-manifest.py <manifest> <version> <asset>

The manifest at <manifest> (tauri-action's latest.json for the other
platforms, or a fresh skeleton) is rewritten in place with the
darwin-aarch64 platform entry pointing at the release asset <asset> of
tag v<version>, signed with $SIG. This runs in the arm64 release job,
which is the single writer of the published latest.json.
"""

import datetime
import json
import os
import sys


def main() -> None:
    manifest_path, version, asset = sys.argv[1], sys.argv[2], sys.argv[3]
    sig = os.environ["SIG"]
    repo = os.environ["REPO"]

    with open(manifest_path) as f:
        m = json.load(f)

    m.setdefault("platforms", {})
    m["version"] = m.get("version") or version
    m.setdefault(
        "pub_date",
        datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
    m["platforms"]["darwin-aarch64"] = {
        "signature": sig,
        "url": f"https://github.com/{repo}/releases/download/v{version}/{asset}",
    }

    with open(manifest_path, "w") as f:
        json.dump(m, f, indent=2)
    print("manifest platforms:", sorted(m["platforms"]))


if __name__ == "__main__":
    main()
