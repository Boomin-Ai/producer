# Vertical Canvas lessons for Producer

Inspected 2026-10-04, without installing or executing the supplied package.

## Evidence

Local package: `/Users/klevelandbishop/Downloads/vertical-canvas-macos-universal.pkg`.
Its bundle identifies `tv.aitum.vertical`, version **1.6.4**, with x86_64 and arm64
Mach-O slices. SHA-256:
`281348c4de542f56f0737fbdd70a9fbb644dd40d14e04acbbd4914addc9fdd2b`.
This matches the checksum in the [official 1.6.4 release](https://github.com/Aitum/obs-vertical-canvas/releases/tag/1.6.4).
`pkgutil --check-signature` reports an invalid installer signature; that observation
does not prevent read-only source research and no installer was run.

Expanded payload is at `/private/tmp/producer-vertical-canvas-review` and upstream
source at `/private/tmp/producer-vertical-source-review`. Matching tag 1.6.4 is
commit `9cd13b8f3cd9afe01d665a2c869a24e88b9a8555`; main was separately inspected at
`f408e8af55425f77763322555e6bc98dc0252d0a`. Findings below refer to the matching tag,
not an assumption that main equals the package.

Producer's [engine/obs.lock](../../engine/obs.lock) pins OBS **32.1.2**, commit
`fb4d98bf88fae5fc85cb11fc57f7c5e309282194`. Inspected the pinned upstream headers
and `obs-view.c`, and verified these exports in the local dev app's actual libobs:
`obs_canvas_create`, `obs_canvas_create_private`, `obs_canvas_scene_create`,
`obs_canvas_set_channel`, `obs_canvas_reset_video`, `obs_canvas_get_video`, and
`obs_view_add2`. Windows exports/integration still need verification.

## Transferable engine pattern

In matching [vertical-canvas.cpp](https://github.com/Aitum/obs-vertical-canvas/blob/9cd13b8f3cd9afe01d665a2c869a24e88b9a8555/vertical-canvas.cpp):

- `CanvasDock::StartVideo` (around line 4910) uses a separate canvas, assigns its
  source/transition channel, and configures independent base/output dimensions.
- Source insertion (around 4797) adds existing source references to a scene;
  scene duplication (around 790) uses `OBS_SCENE_DUP_REFS`. Layout items may differ
  while camera/guest capture references remain shared.
- Video encoder setup (around 5924 and 6005) uses
  `obs_encoder_set_video(..., obs_canvas_get_video(canvas))` rather than always
  attaching to the main global video output.

The relevant [pinned OBS API](https://github.com/obsproject/obs-studio/blob/32.1.2/libobs/obs.h)
provides private canvas creation, scene creation, channel selection and per-canvas
video configuration. As an alternative, [obs-view.c](https://github.com/obsproject/obs-studio/blob/32.1.2/libobs/obs-view.c)
shows `obs_view_add2` creates a video mix with supplied `obs_video_info`; plain
`obs_view_add` takes the main canvas configuration. Producer currently exposes
plain `obs_view_add` in its FFI, so the difference matters.

**Proposed adaptation:** one Producer-owned native output graph per active aspect,
with independent scenes/items, browser graphics dimensions and encoder routing.
Reference common capture sources rather than opening duplicate cameras or guest
connections. Apply one episode clock/rules/results to both graphs. Do not change
the global canvas dimensions to create a second output.

## Boundaries and tests

The binary links Qt Core/Gui/Widgets and `obs-frontend-api`. The source invokes
OBS frontend canvas/dock/projector functions. Producer is a custom Qt-free host;
this is not a plugin to drop into its allowlist. Use libobs APIs from Producer's
native engine and its existing frontend instead. Aitum's repository contains a
GPL v2 license file; verify the applicable source terms before copying code.
Nothing in this review vendors the plugin or changes Producer's dependencies.

Canvas flags require care: OBS's `MIX_AUDIO` flag mixes sources in that canvas into
the audio output. A second canvas sharing microphone/guest sources must not create
duplicated program audio. Investigate private canvas flags and retain Producer's
one processed program bus/mix-minus returns; validate actual recordings and guest
monitoring. Shared-source mute/filter state is global to the source, while scene
visibility/geometry is per item; do not pretend all source properties are independent.

The P0b spike should verify on Mac and Windows:

1. Main landscape output continues while an independent portrait canvas runs.
2. A shared test camera/guest is laid out differently in each canvas.
3. Transparent OBS browser graphics render correctly at each canvas size.
4. Each encoder/recording receives the right canvas; source capture stays shared.
5. Audio is neither doubled nor lost; conversation return remains mix-minus.
6. Stopping/recreating one output leaves the other running; resources release cleanly.
7. Audience/guest capture can target the desired output, not only the global virtual camera.

This is stronger evidence for feasibility than a generic multi-output proposal,
but exported functions and inspected source are not a successful Producer runtime
spike. Keep landscape MVP first; move feasibility research early so it informs
output IDs and ownership before building the rest of the show engine.
