# Windows parity audit — 2026-11-02

Baseline: release `v0.4.78`, commit `3bfa1d309f9fd9a19371677f117b775cc44a5c8a`.
The installed Windows app and engine were current. The missing features came
from platform guards, omitted native guest build features, and Windows runtime
failures. Mac behavior was compared with the same release's source/build paths;
a Mac runtime was not available on this Windows host.

## Implemented

| Area | Windows fix | Verification |
| --- | --- | --- |
| Sets / Atmosphere | Compile and register the shared compositor; expose real mask, backdrop and chart capabilities | Native D3D11 pixel probe, real Atmosphere layouts and portrait pixels |
| Set source creation | Enable portable room-owned source creation | Synthetic room source and source controls |
| Portrait | Enable private canvas, native preview, independent transforms and selected-output routing | Native lifecycle; Landscape / Portrait / Both UI; independent portrait drag |
| Dual recording | Enable both native recorders | Simultaneous H.264/AAC files finalized and checked with ffprobe |
| Native guests | Include `guest-rtc-production` in Windows build, dev, NSIS and MSI paths; Windows SRW locks and static CRT linkage | Eight ingress replacement/retirement cycles; two real browser guest cycles |
| Guest video / audio | Read runtime flags from the Windows process environment rather than MSVC's stale CRT environment | Rust-to-C++ environment regression; native guest pixels and host return A/V |
| Program audio deadlines | Lease Windows MMCSS Pro Audio scheduling for the native publishing worker; release it on that worker | Repeated lease cleanup; live generated host tone and advancing return video |
| Set cache | Count shared graphics leases once across cached / active / pending scenes | Shared/distinct allocation regression; six layouts stay within the existing 768 MiB limit |
| 3D Sets | Replace `/dev/urandom` with portable OS entropy | Two distinct bridge tokens and listener cleanup; actual Atmosphere WebGL layer |
| GPU presets | Use explicit vector components and avoid an HLSL reserved identifier | All 19 presets compile and paint real D3D11 pixels |
| Cutout | Replace Windows pass-through with bounded local ONNX PPHumanSeg inference, shared blur/cut/refinement shader | Person face remains opaque; wall becomes transparent; blur, bypass and eight removal/startup cycles |
| Virtual-camera mirror | Flip a private output placement, preserving shared captures and other outputs; support landscape and portrait without restarting the camera on each toggle | Real Chrome / DirectShow receiver at 1280×720 and 720×1280; asymmetric Set text reverses and frames advance |
| Virtual-camera errors | Distinguish a busy shared Windows camera queue from an installation failure | Busy queue reproduced while installed Producer was running; camera succeeds after it closes |
| Hosted source controls | Keep latest catalog through reconnects; stop source/presentation/audience writes after publisher rejection; preserve deployments without direct scene acknowledgements | Registration ordering, reconnect, renewal, rejected ownership and legacy-hosted regression checks |

Cutout embeds the Apache 2.0 OpenCV Zoo model. Windows build/dev/test staging
fetches SHA256-pinned ONNX Runtime 1.23.2 and includes its MIT license and third
party notices. Inference uses one CPU thread, one outstanding job and one
completed mask; destruction joins the worker before freeing its session. GPU
resources remain on the graphics thread. Size/mode generations reject obsolete
results. Windows quality controls adjust cadence and edge refinement with the
same model; this is not Apple's Vision implementation.

The camera mirror owns its private source/view, retains its input, and tears
it down after the output stops. Portrait uses its own canvas. A studio toggle
does not replace a selected portrait canvas with the landscape scene.

## Checks

- Production frontend build and full Windows executable link pass.
- **88 Rust tests pass; 9 opt-in tests are ignored by the default suite.**
- Six opt-in native checks pass individually: Cutout/mirror pixels and lifecycle;
  all GPU presets; Set/portrait lifecycle; native guest ingress retirement;
  timestamped program video/audio tap; simultaneous dual recordings.
- Shared native C pixel probe passes masks, backdrops, charts and turnover.
- C++ runtime environment regression passes after repeated Rust environment
  changes and removal in the same process.
- Sets v2: 16 integration checks. Module runtime: 18 checks.
- Room-control regression suite, Windows C import coverage and shim parity pass.

Run GPU checks on a Windows GPU host, separately from a running Producer:

```powershell
.\scripts\test-windows-native.ps1 -EngineDir <engine> -OutputDir <temporary-directory>
.\scripts\test-windows-engine.ps1 -EngineDir <engine>
```

Use `CARGO_TARGET_DIR` and `TEMP` on a drive with sufficient space. The scripts
resolve Cargo's target directory and stage the native dependencies beside the
test executable. CI links the guest SDK and checks native compositor imports;
headless CI compilation does not replace the GPU checks above.

## Live evidence and limits

Tests use private QA rooms, generated camera/microphone tracks, a synthetic
host color source and a generated audio tone. No external streaming destination
was enabled and no public broadcast was started. The account credential stays
in the OS vault; tokens are not exported to the webview or test artifacts.

Two browser guest cycles on the rebuilt app confirm nonzero native video,
actual on-screen placement, advancing host return video, audible
synthetic host audio, revocation and source retirement. Evidence:
`D:/CodexBuilds/windows-live-qualified-guest-report.json`.
The final rerun waits for the native room owner and player startup before
measuring playback. LiveKit can adapt received resolution during startup.

Virtual camera is received through the actual `Producer Virtual Camera`
DirectShow device. Both landscape and portrait receiver tests pass. The
separately registered `OBS Virtual Camera` device also passed both orientations.
The installed Producer initially occupied the shared queue. It was closed only
after explicit user approval. Portrait receiver negotiation requires reopening
a receiver that cached the previous landscape device format. Evidence:
`D:/CodexBuilds/windows-producer-vcam-receiver-report.json`.

The retained-room `publisher_busy` failure was traced to the hosted hub treating
an OPEN transport with expired room authorization as a live publisher. The
Worker now requires a live grant for publisher selection, command delivery,
audience presence and room broadcasts; authorization renewal shares the
publisher mutation queue. Registration receives a direct acknowledgement after
storage commits. Active authorized hosts still reject competing publishers.
All 32 realtime tests, TypeScript checking and the Worker bundle check pass.
The previously blocked QA room now receives publisher acknowledgement and
publishes its source catalog without ownership errors. Evidence:
`D:/CodexBuilds/windows-retained-room-recovery-report.json`.

Worker-only deployment: `92ba3ba3-6d3b-401e-897e-2fb10bea705b`.
Rollback version: `08ef8b91-c73f-4896-bd7c-734ba5182c11`.
No database migrations or container rollout were performed. Source and tests:
[API draft PR #444](https://github.com/Boomin-Ai/api/pull/444), branch
`fix/expired-room-publisher`, commit `78ec0c1`. The change must be merged to
retain it in future deployments from main. Producer also preserves compatibility
with older hosted deployments that send only scene-state broadcasts.

The fresh-room Atmosphere check passes all six layouts, Today / Hourly /
7 day / Now, and a room-specific city change to Denver. Both native program
and portrait rendered receipts match the fresh weather commit; the captured
portrait shows Denver at 50°F with populated conditions. The shared integration
was not edited. Peak observed cache use in the layout sweep was below 768 MiB.
Evidence: `D:/CodexBuilds/windows-atmosphere-qualified-report.json` and
`D:/CodexBuilds/windows-atmosphere-qualified-portrait.jpg`.
The fresh room also registers its scene publisher and publishes source catalogs
through ticket renewal.

The earlier offline/packet-loss simulation did **not** stop inbound WebRTC
frames. It does not qualify a full network outage or transport recovery.
Physical microphone/camera capture, external stream delivery, mixed-monitor
DPI changes and a real network interruption remain unqualified. No physical
microphone input was available. Drag-chip/glass differences are platform UI
affordances and are not advertised as identical to AppKit.

## Portable preview

`D:/CodexBuilds/Producer-Windows-Native-Guests-Preview.zip` contains the rebuilt
executable, complete engine, Cutout runtime/licenses, current audit and qualified
QA evidence. Extract the whole directory and run `producer.exe`; keep the DLLs,
`data` and `obs-plugins` beside it. This uses a separate preview profile and is
not a signed release, updater promotion or replacement of the installed app.

Source worktree: `C:/Users/motiv/Documents/New project/producer-windows`, branch
`fix/windows-feature-parity`. The Windows build is a local preview, not a
published app release. GitHub CLI access works. Cloudflare sign-in was refreshed
and the hosted fix above was deployed. Builds and test media are on D:.
