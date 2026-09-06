#!/bin/bash
# Build the mac-virtualcam OBS-PLUGIN from source with Producer's identifiers.
#
# The virtual camera is a PAIR: a CMIO system extension (the device other
# apps see) and an obs plugin (feeds it frames). They rendezvous by bundle
# id + mach service + device UUID. The DMG-extracted plugin is OBS's build,
# hardwired to com.obsproject.* — it can NEVER find our extension, so it
# reports "not installed" forever while the device sits right there.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# --stage <dir> puts the result in a build stage (source path); with no
# argument it stages into the current artifact (local DMG path).
STAGE_DIR=""
if [[ ${1:-} == "--stage" ]]; then
  STAGE_DIR="${2:?--stage needs a directory}"
fi

EXT_ID="ai.boomin.producer.camera-extension"
PLUGIN_BUNDLE_ID="ai.boomin.producer.mac-virtualcam"
SRC="engine/obs-studio/plugins/mac-virtualcam/src"
LIBOBS="engine/obs-studio/libobs"
# Never hardcode the artifact hash — it changes with every obs.lock edit.
source scripts/engine-lib.sh
ART="${STAGE_DIR:-engine/artifacts/$(artifact_name)}"
OUT="engine/virtualcam-plugin/mac-virtualcam.plugin"
# UUIDs must match the extension's Info.plist exactly — they are the device
# identity both halves agree on.
DEV_UUID="7626645E-4425-469E-9D8B-97E0FA59AC75"
SRC_UUID="A8D7B8AA-65AD-4D21-9C42-66480DBFA8E1"
SINK_UUID="A3F16177-7044-4DD8-B900-72E2419F7A9A"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp "$SRC/obs-plugin/plugin-main.mm" "$SRC/obs-plugin/OBSDALMachServer.mm" \
   "$SRC/obs-plugin/OBSDALMachServer.h" "$SRC/obs-plugin/Defines.h" \
   "$SRC/common/MachProtocol.h" "$WORK/"

# @import needs -fmodules, which fights ObjC++ here; plain imports work.
for f in "$WORK"/*.mm "$WORK"/*.h; do
  sed -i '' -e 's/^@import \(.*\);/#import <\1\/\1.h>/' "$f"
done

# The plugin reads its device UUID from NSBundle-by-identifier, which only
# resolves inside OBS's own app packaging — from a libobs dlopen it returns
# nil, the UUID never matches, and start fails "CameraUnavailable" with the
# device sitting right there. Bake the UUID in as a literal instead.
perl -0pi -e 's/\[\[NSBundle[^\]]*\]\s*\n?\s*objectForInfoDictionaryKey:\@"OBSCameraDeviceUUID"\]/\@"'"$DEV_UUID"'"/s' \
  "$WORK/plugin-main.mm"
grep -q "$DEV_UUID" "$WORK/plugin-main.mm" \
  || { echo "FATAL: UUID literal patch did not apply" >&2; exit 1; }

# The start gate trusts only THIS RUN's activation delegate. That fails
# whenever the bundled extension version differs from the installed one
# (replacement pending) or a request is refused (unstapled dev build) —
# even while the installed extension runs fine. Reality outranks the
# delegate: if the camera device is enumerable, the extension is running.
python3 - "$WORK/plugin-main.mm" "$DEV_UUID" <<'PYPATCH'
import sys
p, uuid = sys.argv[1], sys.argv[2]
s = open(p).read()
helper = """
static bool producer_vcam_device_present(void)
{
    CMIOObjectPropertyAddress addr = {kCMIOHardwarePropertyDevices, kCMIOObjectPropertyScopeGlobal,
                                      kCMIOObjectPropertyElementMain};
    UInt32 size = 0;
    if (CMIOObjectGetPropertyDataSize(kCMIOObjectSystemObject, &addr, 0, NULL, &size) != 0 || size == 0)
        return false;
    UInt32 count = size / sizeof(CMIOObjectID);
    CMIOObjectID *devs = (CMIOObjectID *) malloc(size);
    if (!devs)
        return false;
    UInt32 used = 0;
    bool found = false;
    if (CMIOObjectGetPropertyData(kCMIOObjectSystemObject, &addr, 0, NULL, size, &used, devs) == 0) {
        CMIOObjectPropertyAddress uidAddr = {kCMIODevicePropertyDeviceUID, kCMIOObjectPropertyScopeGlobal,
                                             kCMIOObjectPropertyElementMain};
        for (UInt32 i = 0; i < count && !found; i++) {
            CFStringRef uid = NULL;
            UInt32 got = 0;
            if (CMIOObjectGetPropertyData(devs[i], &uidAddr, 0, NULL, sizeof(uid), &got, &uid) == 0 && uid) {
                if (CFStringCompare(uid, CFSTR("%UUID%"), 0) == kCFCompareEqualTo)
                    found = true;
                CFRelease(uid);
            }
        }
    }
    free(devs);
    return found;
}

static bool virtualcam_output_start""".replace("%UUID%", uuid)
old_fn = "\nstatic bool virtualcam_output_start"
assert old_fn.replace("\n", "\n") in s
s = s.replace("\nstatic bool virtualcam_output_start", helper, 1)
old_gate = "if (!delegate.installed) {"
assert old_gate in s
s = s.replace(old_gate, "if (!delegate.installed && !producer_vcam_device_present()) {", 1)
open(p, "w").write(s)
print("gate patched")
PYPATCH

# Harden the stop path (v0.4.41).
#
# THE v0.4.40 CRASH. `obs_output_stop()` is asynchronous, so a release right
# after it lets `obs_output_destroy()` run `obs_output_actual_stop()` a SECOND
# time. Upstream's stop then CFReleases `formatDescription` and the pixel-buffer
# pool unconditionally — a double release, which trips the pointer-auth check in
# `CF_IS_OBJC` and kills the "live-engine" thread. The same unguarded release
# also fires when start bailed out before those objects existed.
#
# So: a `running` latch makes stop a no-op the second time, and every release is
# null-checked and NULLs what it released. The host stopped restarting the vcam
# on a studio toggle in the same release (src-tauri/src/live/studio.rs); this is
# the other half — the plugin must survive a double stop from ANY caller.
python3 - "$WORK/plugin-main.mm" <<'PYSTOP'
import sys

p = sys.argv[1]
s = open(p).read()

# A latch in the (bzalloc'd, so zero-initialised) output state.
old_field = "    CVPixelBufferPoolRef pool;\n"
assert old_field in s, "virtualcam_data.pool moved upstream"
s = s.replace(old_field, old_field + "    bool running;\n", 1)

# Set it last, once start has fully succeeded.
old_ok = """    if (!obs_output_begin_data_capture(vcam->output, 0)) {
        return false;
    }

    return true;
}"""
assert old_ok in s, "virtualcam_output_start tail moved upstream"
s = s.replace(old_ok, """    if (!obs_output_begin_data_capture(vcam->output, 0)) {
        return false;
    }

    vcam->running = true;
    return true;
}""", 1)

old_stop = """static void virtualcam_output_stop(void *data, uint64_t ts)
{
    UNUSED_PARAMETER(ts);

    struct virtualcam_data *vcam = (struct virtualcam_data *) data;

    obs_output_end_data_capture(vcam->output);
    if (cmio_extension_supported()) {
        CMIODeviceStopStream(vcam->deviceID, vcam->streamID);
        CFRelease(vcam->formatDescription);
    } else {
        [vcam->machServer stop];
    }
    CVPixelBufferPoolRelease(vcam->pool);
}"""
assert old_stop in s, "virtualcam_output_stop moved upstream"
s = s.replace(old_stop, """static void virtualcam_output_stop(void *data, uint64_t ts)
{
    UNUSED_PARAMETER(ts);

    struct virtualcam_data *vcam = (struct virtualcam_data *) data;

    // Producer: idempotent. obs_output_stop() is asynchronous, so
    // obs_output_destroy() can reach this a second time; upstream double-
    // released formatDescription and the pool (pointer-auth trap). A stop
    // after a FAILED start released objects that were never created.
    if (!vcam->running)
        return;
    vcam->running = false;

    obs_output_end_data_capture(vcam->output);

    if (cmio_extension_supported()) {
        if (vcam->deviceID) {
            CMIODeviceStopStream(vcam->deviceID, vcam->streamID);
            vcam->deviceID = 0;
            vcam->streamID = 0;
        }
        if (vcam->formatDescription) {
            CFRelease(vcam->formatDescription);
            vcam->formatDescription = NULL;
        }
    } else {
        [vcam->machServer stop];
    }

    if (vcam->pool) {
        CVPixelBufferPoolRelease(vcam->pool);
        vcam->pool = NULL;
    }
}""", 1)

# destroy must not release what stop already released; upstream's only drops
# ObjC references, so all it needs is the latch cleared.
old_destroy = """    if (cmio_extension_supported()) {
        vcam->extensionDelegate = nil;
    } else {
        vcam->machServer = nil;
    }

    bfree(vcam);"""
assert old_destroy in s, "virtualcam_output_destroy moved upstream"
s = s.replace(old_destroy, """    vcam->running = false;

    if (cmio_extension_supported()) {
        vcam->extensionDelegate = nil;
    } else {
        vcam->machServer = nil;
    }

    bfree(vcam);""", 1)

open(p, "w").write(s)
print("stop path hardened")
PYSTOP

# Rebrand the rendezvous identifiers. Fail loudly if upstream renames them.
grep -q 'com.obsproject.obs-studio.mac-camera-extension' "$WORK/plugin-main.mm" \
  || { echo "FATAL: extension id string moved upstream" >&2; exit 1; }
sed -i '' \
  -e "s/com\.obsproject\.obs-studio\.mac-camera-extension/$EXT_ID/g" \
  -e "s/com\.obsproject\.mac-virtualcam/$PLUGIN_BUNDLE_ID/g" \
  "$WORK/plugin-main.mm" "$WORK/OBSDALMachServer.mm"

# Minimal generated header the source expects from a CMake build.
cat > "$WORK/obsconfig.h" <<'EOF'
#pragma once
#define OBS_VERSION "32.1.2"
#define OBS_VERSION_CANONICAL "32.1.2"
#define OBS_DATA_PATH "../../data"
#define OBS_INSTALL_PREFIX ""
#define OBS_PLUGIN_DESTINATION "obs-plugins"
#define OBS_RELATIVE_PREFIX "../../"
#define OBS_RELEASE_CANDIDATE 0
#define OBS_BETA 0
#define OBS_COMMIT "producer"
EOF

mkdir -p "$(dirname "$OUT")"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/locale"

# simde: header-only SSE shim libobs needs on arm64; a CMake build gets it
# from obs-deps, we get it from brew.
SIMDE="$(brew --prefix)/include"
[[ -f "$SIMDE/simde/x86/sse2.h" ]] || { echo "FATAL: brew install simde first" >&2; exit 1; }

clang++ -bundle -std=c++17 -fobjc-arc -ObjC++ \
  -mmacosx-version-min=13.0 \
  -include Foundation/Foundation.h \
  -include CoreVideo/CoreVideo.h -include IOSurface/IOSurface.h \
  -I "$WORK" -I "$LIBOBS" -I "$SIMDE" -I "$SRC/common" \
  -F "$ART/Frameworks" -framework libobs \
  -framework Foundation -framework AppKit -framework AVFoundation \
  -framework CoreMedia -framework CoreMediaIO -framework CoreVideo \
  -framework IOSurface -framework SystemExtensions \
  -Wl,-rpath,@loader_path/../../../../Frameworks \
  -Wno-deprecated-declarations \
  -o "$OUT/Contents/MacOS/mac-virtualcam" \
  "$WORK/plugin-main.mm" "$WORK/OBSDALMachServer.mm"

cp "$SRC/obs-plugin/data/locale/en-US.ini" "$OUT/Contents/Resources/locale/en-US.ini"

cat > "$OUT/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>$PLUGIN_BUNDLE_ID</string>
	<key>CFBundleName</key>
	<string>mac-virtualcam</string>
	<key>CFBundleExecutable</key>
	<string>mac-virtualcam</string>
	<key>CFBundlePackageType</key>
	<string>BNDL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.2</string>
	<key>CFBundleVersion</key>
	<string>3</string>
	<key>OBSCameraDeviceUUID</key>
	<string>$DEV_UUID</string>
	<key>OBSCameraSourceUUID</key>
	<string>$SRC_UUID</string>
	<key>OBSCameraSinkUUID</key>
	<string>$SINK_UUID</string>
</dict>
</plist>
EOF

# Replace the DMG plugin in the artifact so assemble ships ours.
rm -rf "$ART/PlugIns/mac-virtualcam.plugin"
cp -R "$OUT" "$ART/PlugIns/mac-virtualcam.plugin"
echo "built + staged: $ART/PlugIns/mac-virtualcam.plugin"
