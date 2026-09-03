#!/bin/bash
# One plugin list, enforced.
#
# engine-closure.sh once kept its own copy of the plugin list. It drifted from
# engine-lib.sh, so the dependency gate walked a different set than we ship:
# artifacts went out missing libavdevice/libavfilter/obs-frontend-api, modules
# died at dlopen, and the gate stayed green the whole time. It regressed a
# second time when a plain `git checkout` restored the forked version.
#
# A gate that checks a different set than it protects is worse than no gate,
# so this asserts the fork cannot come back.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
CLOSURE="scripts/engine-closure.sh"

# 1. engine-closure.sh must DERIVE its list, never spell one out.
if grep -Eq '^[[:space:]]*PLUGINS=\([[:space:]]*[a-z]' "$CLOSURE"; then
  echo "FAIL: $CLOSURE hardcodes a plugin list." >&2
  echo "      It must read ENGINE_PLUGINS from scripts/engine-lib.sh instead." >&2
  exit 1
fi
if ! grep -q 'ENGINE_PLUGINS\[@\]' "$CLOSURE"; then
  echo "FAIL: $CLOSURE does not use ENGINE_PLUGINS." >&2
  exit 1
fi

# 2. The list the gate actually ends up with must equal the canonical one.
source scripts/engine-lib.sh
canonical="${ENGINE_PLUGINS[*]}"
effective="$(bash -c 'source scripts/engine-lib.sh; PLUGINS=("${ENGINE_PLUGINS[@]}"); echo "${PLUGINS[*]}"')"
if [[ $canonical != "$effective" ]]; then
  echo "FAIL: plugin lists differ." >&2
  echo "  canonical: $canonical" >&2
  echo "  effective: $effective" >&2
  exit 1
fi

echo "RESULT: PASS — one plugin list (${#ENGINE_PLUGINS[@]} plugins)"

# The virtual camera CLSID lives in two places by necessity (a CMake cache var
# for the engine build, a C literal for the shim's registry probe). They must
# agree or "Install cam" registers one filter and probes for another.
preset_guid="$(lock_get_file engine/producer-presets.json "[c for c in d['configurePresets'] if c['name']=='producer-windows'][0]['cacheVariables']['VIRTUALCAM_GUID']['value']")"
shim_guid="$(grep -o 'PRODUCER_VCAM_CLSID L"{[0-9A-Fa-f-]*}"' src-tauri/src/live/shim_win.c | sed 's/.*{\(.*\)}.*/\1/')"
if [[ "$preset_guid" != "$shim_guid" ]]; then
  echo "FATAL: VIRTUALCAM_GUID differs: preset=$preset_guid shim=$shim_guid" >&2
  exit 1
fi
echo "  ok   VIRTUALCAM_GUID agrees: $preset_guid"
