#!/bin/bash
# Reuse the exact engine lock for this architecture. Never select a stale engine.
set -euo pipefail
[[ $(uname -s) == Darwin ]] || { echo 'This setup target is for macOS; see CONTRIBUTING.md for other platforms.' >&2; exit 1; }
source "$(dirname "${BASH_SOURCE[0]}")/engine-lib.sh"
ARCH="$(uname -m)"
NAME="$(artifact_name macos "$ARCH")"
STAGE="$ARTIFACT_DIR/$NAME"
if [[ ${1:-} == --print-path ]]; then printf '%s\n' "$STAGE"; exit 0; fi
cd "$REPO_ROOT"
command -v cargo >/dev/null || { echo 'Install stable Rust before make setup.' >&2; exit 1; }
xcode-select -p >/dev/null
if [[ -d "$STAGE" ]] && bash scripts/check-macos-engine.sh "$STAGE" "$ARCH"; then
  echo "Reusing verified engine: $NAME"
  exit 0
fi
if [[ $ARCH == x86_64 ]]; then
  # Intel qualification uses OpenGL; compiling the optional Metal backend is
  # not a claim of Metal GPU acceptance on Intel or a hosted runner.
  PRODUCER_ENGINE_PACK=0 PRODUCER_METAL_COMPILE_ONLY=1 bash scripts/extract-engine.sh
elif [[ $ARCH == arm64 ]]; then
  command -v gh >/dev/null || { echo 'GitHub CLI access is required to fetch the pinned Silicon engine artifact.' >&2; exit 1; }
  mkdir -p "$CACHE_DIR"
  DOWNLOAD="$(mktemp -d "$CACHE_DIR/engine-download.XXXXXX")"
  FOUND=''
  for run in $(gh run list --repo Boomin-Ai/producer --workflow engine.yml --status success --limit 10 --json databaseId -q '.[].databaseId'); do
    if gh run download "$run" --repo Boomin-Ai/producer -n producer-libobs-macos-arm64 -D "$DOWNLOAD/$run" 2>/dev/null \
      && [[ -f "$DOWNLOAD/$run/$NAME.tar.zst" ]]; then FOUND="$run"; break; fi
  done
  [[ -n $FOUND ]] || { echo "No CI engine matches $NAME; build engine.yml for this lock first." >&2; exit 1; }
  (cd "$DOWNLOAD/$FOUND" && shasum -a 256 -c "$NAME.tar.zst.sha256")
  mkdir -p "$ARTIFACT_DIR"
  tar --zstd -xf "$DOWNLOAD/$FOUND/$NAME.tar.zst" -C "$ARTIFACT_DIR"
else
  echo "Unsupported Mac architecture: $ARCH" >&2; exit 1
fi
bash scripts/check-macos-engine.sh "$STAGE" "$ARCH"
