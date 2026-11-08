#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/notarize-macos-artifact.sh" "${1:?Specify the signed Intel installer DMG}"
