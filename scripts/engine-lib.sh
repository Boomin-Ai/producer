#!/bin/bash
# engine-lib.sh — shared definitions for the Producer engine scripts.
# The single source of truth for the §5.2 plugin allowlist and artifact layout.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="$REPO_ROOT/engine/obs.lock"
ARTIFACT_DIR="$REPO_ROOT/engine/artifacts"
CACHE_DIR="$REPO_ROOT/engine/cache"

# LIVE-REVIEW.md §5.2 — the only plugins shipped.
#
# Split shared/per-os so the OVERLAP IS STATED ONCE: a plugin added to SHARED
# lands on both platforms visibly, instead of being added twice and drifting
# apart. engine_plugins() concatenates; check_plugin_lists() asserts the sets are
# disjoint so nothing quietly ends up double-listed.
ENGINE_PLUGINS_SHARED=(obs-x264 obs-outputs rtmp-services image-source
  obs-filters obs-transitions obs-ffmpeg)

# text-freetype2 is NOT shared: the text source ships under different names per
# platform (text-freetype2 on macOS, obs-text on Windows). Caught by the closure
# gate against a real artifact — which is what this split is for.
ENGINE_PLUGINS_MACOS=(mac-capture mac-avcapture mac-videotoolbox
  coreaudio-encoder mac-virtualcam text-freetype2)

# win-dshow is BOTH the camera input and the virtual camera output, so it
# replaces mac-avcapture and mac-virtualcam at once. win-wasapi takes
# coreaudio-encoder's capture role (ffmpeg still does aac encode). obs-browser
# is the one that matters most: guests are browser sources, so without it the
# guest feature cannot exist on Windows at all.
ENGINE_PLUGINS_WINDOWS=(win-capture win-dshow win-wasapi obs-browser obs-text)

# engine_plugins [os] — the full allowlist for a platform.
engine_plugins() {
  local os="${1:-macos}"
  case "$os" in
    macos)   printf '%s
' "${ENGINE_PLUGINS_SHARED[@]}" "${ENGINE_PLUGINS_MACOS[@]}" ;;
    windows) printf '%s
' "${ENGINE_PLUGINS_SHARED[@]}" "${ENGINE_PLUGINS_WINDOWS[@]}" ;;
    *) echo "engine_plugins: unknown os '$os'" >&2; return 1 ;;
  esac
}

# Fails if a plugin is listed in SHARED and also in a per-os list. That is the
# drift this split exists to prevent, so it is checked rather than trusted.
check_plugin_lists() {
  local dupes=0 p
  for p in "${ENGINE_PLUGINS_MACOS[@]}" "${ENGINE_PLUGINS_WINDOWS[@]}"; do
    if printf '%s
' "${ENGINE_PLUGINS_SHARED[@]}" | grep -qx "$p"; then
      echo "FATAL: '$p' is in ENGINE_PLUGINS_SHARED and a per-os list" >&2
      dupes=1
    fi
  done
  return $dupes
}

# Back-compat: existing macOS callers still read ENGINE_PLUGINS directly.
mapfile -t ENGINE_PLUGINS < <(engine_plugins macos)

lock_get() { python3 -c "import json,sys; d=json.load(open('$LOCK_FILE')); print(eval('d'+sys.argv[1]))" "$1"; }

# sha256 of a file, portable. macOS has shasum; Windows runners and some Linux
# images only have sha256sum. Both print "<hash>  <path>", so the cut is shared.
# Order matters: shasum first keeps macOS on the exact tool it has always used.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

lock_hash() { sha256_of "$LOCK_FILE" | cut -c1-12; }

# artifact_name [os] [arch]
#
# Defaults reproduce the macOS name exactly, so every existing caller is
# unchanged. The lock's `arch` field is DE FACTO the macOS arch — it has one
# reader (this function) and nothing else in the tree consults it — so the
# Windows port takes arguments rather than growing a per-platform lock section.
#
# NOTE the hash covers the WHOLE lock file, so editing it re-keys EVERY
# platform's artifact name at once. That is deliberate (one lock, one identity)
# but it means a lock edit must be followed immediately by rebuilding artifacts
# for all platforms, or release.yml cannot find the engine it computes the name
# for.
artifact_name() {
  local os="${1:-macos}"
  local arch="${2:-$(lock_get "['arch']")}"
  echo "producer-libobs-${os}-${arch}-$(lock_hash)"
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
  # -C, not --cd: `--cd` is bsdtar-only (macOS), while `-C` means the same thing
  # on BOTH bsdtar and GNU tar, which is what a Windows runner's Git Bash has.
  tar -C "$(dirname "$stage")" --zstd -cf "$ARTIFACT_DIR/$name.tar.zst" "$name"
  (cd "$ARTIFACT_DIR" && echo "$(sha256_of "$name.tar.zst")  $name.tar.zst" > "$name.tar.zst.sha256")
  echo "packed: $ARTIFACT_DIR/$name.tar.zst"
  cat "$ARTIFACT_DIR/$name.tar.zst.sha256"
}
