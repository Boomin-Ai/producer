# Portrait set color context correction

The portrait screenshot's raised blacks and pale amber source were reproduced with a native mid-tone fixture. An encoded RGB input `[136,96,46]` remained correct in a non-linear render context but became `[193,165,118]` with linear-sRGB and framebuffer conversion enabled. It was a render-state mismatch, not a defect in the generated artwork or camera settings. Earlier endpoint fixtures based on pure green/white did not expose the extra transfer function.

The native set group, program and transition sources now declare sRGB awareness. Group intermediate textures render children in an explicit encoded SDR context, then decode their texture once when drawing into a linear parent. Framebuffer and linear-sRGB state are restored on every path, including failures. Plain direct groups keep their bypass only when both inherited color states are non-linear. Transition inputs follow the same explicit texture contract. This changes the shared native compositor rather than lowering exposure or editing the portrait plate.

OBS itself switches its linear-sRGB state for sources according to `OBS_SOURCE_SRGB` and binds filter textures with or without sRGB decoding according to that state. See [OBS source rendering](https://github.com/obsproject/obs-studio/blob/master/libobs/obs-source.c). The correction was verified against the locally installed OBS runtime used by Producer; runtime identity is recorded in the regression report. This is an SDR path, not new HDR support.

The focused regression checks amber in seven native paths (direct, rounded mask, overflow clip, set program and dissolve/wipe/slide), each in both color contexts. All fourteen retain the expected center RGB values within a three-value tolerance; masks retain transparent corners, inherited graphics state is restored, and native objects are released. The full existing suite still passes ordered media/graphics/native composition, masks, opacity, motion, transitions, both orientations, prepared scene reuse and graphics sharpness.

The full dev-room check uses a separate **Producer color check** room so it does not overwrite the user's configured showcase room or camera bindings. It loads The Grand Arena at 1080p, prepares all 12 layouts, selects the real portrait output, reads its JPEG frame and samples the amber source in the camera opening. Expected RGB is `[136,96,46]`, with a six-value tolerance for JPEG. `roomInspect` opens the existing showcase room without running source-creation automation.

Artifacts: [reproduction](native/portrait-color/reproduction.json), [14 color assertions](native/portrait-color/color-proof.json), [native suite](native/portrait-color/regression-proof.json), [run hashes](native/portrait-color/regression-run.json). The focused native command is:

```sh
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 \
PRODUCER_PROBE_COLOR_ONLY=1 \
PRODUCER_PROBE_OUTPUT=/private/tmp/producer-portrait-color-after \
bash scripts/sets-v2/run-native-probe.sh
```

The final actual portrait JPEG was 1080×1920 and measured `[131,96,41,255]` at the amber camera-slot center against expected `[136,96,46]`, within the six-value conversion/compression tolerance. The native RGBA fixture itself preserves `[136,96,46]` exactly in all fourteen cases. See [room proof](native/portrait-color/room-proof.json) and [focused source hashes](native/portrait-color/color-run.json).
