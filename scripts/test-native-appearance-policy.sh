#!/usr/bin/env bash
# Execute the actual dependency-free ownership/routing/profile modules. This
# neither initializes OBS/LiveKit nor accesses a profile, device or network.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
task_tmp=$(mktemp -d "${TMPDIR:-/tmp}/producer-appearance-policy.XXXXXX")
trap 'rm -rf "$task_tmp"' EXIT
for source in \
  crates/guest-runtime/src/program_profile.rs \
  crates/guest-runtime/src/media_routes.rs \
  src-tauri/src/live/program_capture_clock.rs \
  src-tauri/src/live/appearance_lease_policy.rs; do
  name=$(basename "$source" .rs)
  rustc --edition=2021 --test "$source" -o "$task_tmp/$name"
  "$task_tmp/$name"
done
