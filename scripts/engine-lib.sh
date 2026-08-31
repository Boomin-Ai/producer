#!/bin/bash
# engine-lib.sh — shared definitions for the Producer engine scripts.
# The single source of truth for the §5.2 plugin allowlist and artifact layout.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="$REPO_ROOT/engine/obs.lock"
ARTIFACT_DIR="$REPO_ROOT/engine/artifacts"
CACHE_DIR="$REPO_ROOT/engine/cache"

# LIVE-REVIEW.md §5.2 — the only plugins shipped.
ENGINE_PLUGINS=(mac-capture mac-avcapture mac-videotoolbox coreaudio-encoder
  obs-x264 obs-outputs rtmp-services image-source text-freetype2 obs-filters
  obs-transitions obs-ffmpeg mac-virtualcam)

lock_get() { python3 -c "import json,sys; d=json.load(open('$LOCK_FILE')); print(eval('d'+sys.argv[1]))" "$1"; }

lock_hash() { shasum -a 256 "$LOCK_FILE" | cut -c1-12; }

artifact_name() {
  local arch; arch="$(lock_get "['arch']")"
  echo "producer-libobs-macos-${arch}-$(lock_hash)"
}

# write_manifest <stage_dir> <provenance>
write_manifest() {
  local stage="$1" provenance="$2"
  python3 - "$stage" "$provenance" "$LOCK_FILE" <<'EOF'
import hashlib, json, os, sys
stage, provenance, lock_file = sys.argv[1:4]
files = {}
for root, _, names in os.walk(stage):
    for n in names:
        p = os.path.join(root, n)
        if os.path.islink(p) or n == "manifest.json":
            continue
        rel = os.path.relpath(p, stage)
        h = hashlib.sha256(open(p, "rb").read()).hexdigest()
        files[rel] = h
manifest = {
    "provenance": provenance,
    "lock": json.load(open(lock_file)),
    "files": dict(sorted(files.items())),
}
json.dump(manifest, open(os.path.join(stage, "manifest.json"), "w"), indent=2)
print(f"manifest: {len(files)} files")
EOF
}

# pack_artifact <stage_dir>  → tar.zst + sha256 in ARTIFACT_DIR
pack_artifact() {
  local stage="$1" name
  name="$(basename "$stage")"
  mkdir -p "$ARTIFACT_DIR"
  tar --cd "$(dirname "$stage")" --zstd -cf "$ARTIFACT_DIR/$name.tar.zst" "$name"
  (cd "$ARTIFACT_DIR" && shasum -a 256 "$name.tar.zst" > "$name.tar.zst.sha256")
  echo "packed: $ARTIFACT_DIR/$name.tar.zst"
  cat "$ARTIFACT_DIR/$name.tar.zst.sha256"
}
