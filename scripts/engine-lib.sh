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
#
# NOT `mapfile`/`readarray`: macOS ships bash 3.2 (GPLv2), where both are
# missing entirely - `mapfile: command not found`, exit 127, before the build
# even starts. A read loop is the spelling that works on both bashes.
ENGINE_PLUGINS=()
while IFS= read -r _plugin; do ENGINE_PLUGINS+=("$_plugin"); done < <(engine_plugins macos)
unset _plugin

# A WORKING python, resolved by EXECUTION rather than presence, memoised.
#
# Windows ships a "python3" App Execution Alias that EXISTS on PATH and fails
# when run (it prints a Store advert to stderr and exits non-zero), so
# `command -v python3` proves nothing. Without this probe lock_get returns EMPTY
# on such a box and the callers cheerfully build with an empty OBS commit and an
# artifact named producer-libobs-macos--<hash>. Order keeps macOS on python3,
# the interpreter it has always used.
PYTHON_BIN=""
resolve_python() {
  if [[ -n $PYTHON_BIN ]]; then echo "$PYTHON_BIN"; return 0; fi
  local cand
  for cand in python3 python py; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c pass >/dev/null 2>&1; then
      PYTHON_BIN="$cand"; echo "$cand"; return 0
    fi
  done
  echo "FATAL: no working python found (tried python3, python, py)" >&2
  return 1
}

# host_path <path> - a path the HOST interpreter can open.
#
# The pythons on a Windows box are native Windows builds; they cannot open an
# MSYS path like /c/Users/x. Git Bash hands us exactly those. cygpath -m gives
# back C:/Users/x - a real Windows path that still uses forward slashes, so it
# needs no re-escaping inside a python string literal. cygpath does not exist on
# macOS, where the path was already fine, so this is a no-op there.
host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi
}

# lock_get <python-index-expr> - read one value out of engine/obs.lock.
# Fails loudly on an empty read: every caller feeds a build input, and an empty
# one is worse than an error because it yields a plausible-looking wrong build.
lock_get() {
  local py out
  py="$(resolve_python)" || return 1
  local lock; lock="$(host_path "$LOCK_FILE")"
  out="$("$py" -c "import json,sys; d=json.load(open('$lock')); print(eval('d'+sys.argv[1]))" "$1")" \
    || { echo "FATAL: lock_get $1 failed against $LOCK_FILE" >&2; return 1; }
  [[ -n $out ]] || { echo "FATAL: lock_get $1 read empty from $LOCK_FILE" >&2; return 1; }
  printf '%s\n' "$out"
}

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
  local os="${1:-macos}" arch="${2:-}"
  # NOT `local arch="${2:-$(lock_get ...)}"`: a failing command substitution in a
  # `local` declaration does NOT trip set -e, so that spelling silently yields an
  # empty arch and a name like producer-libobs-macos--<hash>.
  if [[ -z $arch ]]; then arch="$(lock_get "['arch']")" || return 1; fi
  echo "producer-libobs-${os}-${arch}-$(lock_hash)"
}

# write_manifest <stage_dir> <provenance>
write_manifest() {
  local stage="$1" provenance="$2"
  local py; py="$(resolve_python)" || return 1
  "$py" - "$(host_path "$stage")" "$provenance" "$(host_path "$LOCK_FILE")" <<'EOF'
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

# apply_patchsets <obs source dir>
#
# obs.lock carries a LIST of patchsets, each with its own apply target: the
# obs-browser one applies inside the submodule (its paths are relative to
# plugins/obs-browser, which is its own git repo), the win-dshow one applies at
# the obs-studio root. Every patchset is sha256-verified against the lock,
# applied idempotently (a tree that already carries it is detected and
# skipped), and the same code runs on both platforms: patches whose hunks are
# irrelevant on a platform are still applied so the lock stays one identity.
apply_patchsets() {
  local src="$1" count i dir target want have patch
  count="$(lock_get "['patchsets']" | python_len)" || return 1
  for ((i = 0; i < count; i++)); do
    dir="$REPO_ROOT/$(lock_get "['patchsets'][$i]['dir']")"
    target="$src/$(lock_get "['patchsets'][$i]['target']")"
    want="$(lock_get "['patchsets'][$i]['sha256']")"
    have="$(cat $(ls "$dir"/*.patch | sort) > "$src/.patchcat" && sha256_of "$src/.patchcat")"
    rm -f "$src/.patchcat"
    [[ $want == "$have" ]] || { echo "FATAL: patchset $dir sha256 mismatch (lock $want, files $have)" >&2; return 1; }
    for patch in $(ls "$dir"/*.patch | sort); do
      if git -C "$target" apply --check "$patch" 2>/dev/null; then
        git -C "$target" apply "$patch"
        echo "patch applied: $(basename "$patch") @ $(lock_get "['patchsets'][$i]['target']")"
      elif git -C "$target" apply --reverse --check "$patch" 2>/dev/null; then
        echo "patch already present: $(basename "$patch")"
      else
        echo "FATAL: patch neither applies nor is present: $patch" >&2
        return 1
      fi
    done
  done
}

# Length of a python-list printed by lock_get (e.g. "[{...}, {...}]").
python_len() {
  local py; py="$(resolve_python)" || return 1
  "$py" -c "import sys,ast; print(len(ast.literal_eval(sys.stdin.read())))"
}

# lock_get_file <json file> <python expr over d> -- like lock_get, any JSON file.
lock_get_file() {
  local py; py="$(resolve_python)" || return 1
  "$py" -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$(host_path "$REPO_ROOT/$1")" "$2"
}
