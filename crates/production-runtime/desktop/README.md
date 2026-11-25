# Producer Native Dev with Rune

An isolated macOS development application, not the production desktop. The existing Tauri app, production library, account credentials, backend and releases are unchanged.

## Ownership

- **Rust production contract/core:** typed document, immutable assets, live sources, placements, animation targets, paired Set layouts, linked Show, exact timeline time, validation and compilation.
- **Rust desktop control worker:** bounded UI/CLI commands, compile/admission, durable room edits, asset-worker supervision and current Assistant context.
- **Rust render/audio worker:** continuous output clock, seekable editorial transport, compiled scene evaluation, preallocated PCM mixing and submission to the platform adapter. File import, document validation and disk saving do not run here.
- **macOS adapter:** AVFoundation camera/microphone/MOV, ScreenCaptureKit, Metal compositing and AVAssetWriter. The narrow Objective-C bridge does not own the production document or layout rules.
- **Rune** draws the native operator panels, docked timeline and landscape and portrait previews. The production engine owns animation time.

The source/player/asset distinction is real: importing a MOV creates an immutable content-hashed asset, rebinds a stable player source, and changes that source's timed placement. A file is not the live camera, and the timeline lane is not a second media owner. The initial five lanes are screen, camera, MOV, graphics/animation and microphone. Placing a committed take adds a separate V4 lane; the core supports additional placements and nested sequences.

## Room output dimensions

Each `RoomProject` owns its own canvas settings, persisted with that room:

- landscape role defaults to 1920 × 1080;
- vertical role defaults to 1080 × 1920;
- either role accepts a custom even size, including 1080 × 1080;
- this native media profile admits 64–4096 pixels per side and at most 8,847,360 pixels per output;
- output size changes are refused while recording, and GPU pool allocation is transactional.

Landscape/vertical are output roles, rather than restrictions forbidding custom ratios. A Set retains its authored dimensions. Preparation adapts a copy to the current room size using its responsive layout rules; it does not rewrite the library Set. Fixed-position designs still need appropriate responsive authoring. A Show's paired layout references resolve through those room outputs. The CLI's `state.assistantContext` includes the exact current dimensions; `scaffoldSet` creates the new paired layouts at those dimensions, preserves the previous Set, links the Show and retains the source bindings and animation targets.

## Build and run

Build this leaf crate with the repository's Rust toolchain:

```sh
CARGO_TARGET_DIR=target/native-room CARGO_PROFILE_DEV_STRIP=none \
  cargo build --manifest-path crates/production-runtime/desktop/Cargo.toml
```

Rune is pinned in Cargo.toml and Cargo.lock. This build uses runtime Metal shaders and the Command Line Tools SDK. It does not need a second browser/webview application.

Run the packaged **Producer Native Dev.app** with its camera, microphone and Screen Recording permissions. The profile defaults to `~/Library/Application Support/Producer Native Dev`, independent of production. `PRODUCER_NATIVE_ROOM_HOME` can select another isolated profile. This local prototype is ad-hoc signed; rebuilt executable identities can require macOS permission renewal. A stable developer/release signing identity is a remaining distribution requirement.

On this Mac an old ad-hoc Screen Recording entry remained enabled but its saved code requirement no longer matched the rebuilt executable. Removing only this dev app's entry and adding the current bundle through System Settings restored capture; toggling the stale entry alone did not. Camera and microphone were subsequently approved by the user. No TCC database edits or permission bypasses are part of the setup.

## Shared local control path

All UI mutations use the same typed `RoomCommand` handler as the same-user Unix-socket CLI. Socket access is mode 0600, peer UID checked, request bounded to 256 KiB, with bounded queues and timeouts. It is not a remotely exposed unauthenticated server. Internal asset-import completions cannot be sent through IPC.

```sh
target/native-room/debug/producer-native-room --request '{"op":"state"}'
target/native-room/debug/producer-native-room --request '{"op":"canvasSize","target":"landscape","width":1080,"height":1080}'
target/native-room/debug/producer-native-room --request '{"op":"scaffoldSet","id":"new-studio","title":"My Studio"}'
target/native-room/debug/producer-native-room --request '{"op":"timelineDock","edge":"top"}'
target/native-room/debug/producer-native-room --request '{"op":"trim","clip":"movie-clip","start":4,"duration":6,"source_in":1}'
```

`document` accepts the core's validated transaction contract for finer edits. The UI commits a trim once on release, with a local drag preview. Import snapshots a selected regular MOV (up to 128 MiB) through a supervised helper, verifies its identity and probes a decoded video frame before adoption. Unsupported decode retains the previous source and surfaces an error.

## Repeatable local checks

With this isolated dev room already open:

```sh
python3 crates/production-runtime/desktop/scripts/check-room.py \
  --binary target/native-room/debug/producer-native-room \
  --movie /absolute/path/to/synthetic-h264.mov \
  --evidence /tmp/native-controls-proof.json
```

Add `--record` only for the approved live camera/screen/mic test. It requires all three media sources and microphone samples before recording. Use `--camera-device <id-from-state.cameras>` to select the physical device and `--originals camera screen microphone` to explicitly retain those original inputs. It captures paired outputs, seeks and trims the MOV while recording, waits for durable take finalization, and writes local timings/counters. A successful file creation is not a recording pass. Evidence containing private recordings stays local.

The recorder now writes [durable compressed takes](../DURABLE-TAKES.md), not a pair of monolithic output MOVs. Fully hash-check/decode committed fragments with:

```sh
python3 crates/production-runtime/desktop/scripts/check-take.py \
  --take /absolute/path/to/local/take-directory \
  --ffprobe target/native-media-sdk/install/bin/ffprobe \
  --evidence /tmp/native-take-decode.json
```

`--seconds 30 --require-clean-audio` additionally requires advancing frames from all three visual sources, no rejected mic frames, no timestamp discontinuities, no mixer underflow and no skipped audio clock samples. The saved state includes separate rejection counts for contention, capacity, overlap, generation, PCM validation and clock overflow. Mixer underflow is counted separately from capture rejection; a zero aggregate rejection counter alone is not audio qualification.

### Local hardware result, 2026-11-16

The initial Apple Silicon candidate passed 201 pure-workspace tests and five desktop unit tests. The repeatable room check authored paired Sets at custom sizes, retained the previous library Set, linked its Show, restored default 1080 outputs, moved the timeline between top and bottom, and closed/reopened panels. Invalid dimensions, side docking and invalid trims were rejected without replacing the working room. Eight successive Set scaffolds compile without growing animation IDs past their limit.

A 20-second run kept the physical camera, ScreenCaptureKit, native H.264 MOV and physical mic active while seeking and trimming. Both output files fully decoded: 605 video frames each at approximately **29.84 fps**, at 1920×1080 and 1080×1920, with AAC 48 kHz stereo audio. No GPU submission refusals occurred during that run. CPU evaluation/build/submission p99 was 5.33 ms in the last sample; this is not GPU execution or end-to-end latency. The fixed-deadline frame scheduler replaces the earlier interval-plus-work schedule that yielded about 27 fps.

The mic queue reported 2,592 rejected sample frames (about **54 ms**) during the full run. Audio is therefore functional but not yet dropout-qualified. A separate six-second check muted MOV audio throughout and toggled the physical mic: the muted portion decoded to silence, while the unmuted portion contained mic audio in both outputs. It does not establish lip sync or listening quality. Native UI Record/Stop, Play, a real MOV trim-handle drag and Sources close/reopen also passed. Recording is stopped after these checks. Private media and detailed local evidence are not repository artifacts.

### Mic rejection follow-up, 2026-11-16

Per-cause instrumentation on the original handoff isolated **2,496 rejected frames**, all from contention on the mutex shared by the capture callback and mixer. Capacity, overlap, generation, invalid-PCM, clock-overflow and timestamp-discontinuity counts were zero in that trace. The fix gives capture and mixing separate producer/consumer ownership through a preallocated ring; it does not increase capacity or add buffering delay. The corrected candidate passes **205 pure-workspace tests and five desktop unit tests**.

Two corrected 30-second paired recordings passed the strict audio check while camera, ScreenCaptureKit and MOV were active, including MOV seeks and trimming. Both runs had zero new capture rejections, mixer missing frames, clock skips, timestamp discontinuities and GPU submission refusals. All four H.264/AAC output files fully decoded: the first pair had 906 video frames each at approximately 29.96 fps, and the cold-relaunch pair had 910 frames each at approximately 30.00 fps. Output sizes remained 1920×1080 and 1080×1920, with 48 kHz stereo audio. Extracted recorded frames show the camera, shared screen and MOV together in each output.

The cold-relaunch trace covered capture startup and about 50 seconds of operation with zero total capture rejections. First mic samples were observed within 0.7 seconds of the trace starting, with 100 ms polling and already-approved permissions; this is not a fresh-permission or universal startup guarantee. Expected silence before the capture became ready was counted separately and stopped increasing once audio arrived. A preceding permission-renewal session accumulated 7,168 capacity rejections before its recorded interval; that counterexample is retained in local evidence, rather than cleared or included in the clean cold-start claim. Lip sync, subjective listening and full device-reconnect qualification remain open.

## Fidelity and limits

The Metal compositor converts BGRA to full-range NV12. Recording uses its native output buffers. A dedicated preview worker copies the latest completed NV12 planes for each output into Rune surfaces, releasing the producer buffer before upload. Both previews keep their output aspect ratio.

Run the dock and interaction checks with `python3 scripts/check-rune-studio.py /absolute/path/to/producer-native-room`. The check uses temporary local studios and Rune’s headless renderer.

The mic boundary uses a fixed 32-block `rtrb` 0.4.1 SPSC ring of 10 ms, 48 kHz stereo blocks, exact sample positions and generation rejection. The serial capture callback owns the producer; the Rust mixer exclusively owns the consumer. A producer-only `try_lock` guard safely rejects unexpected reentrant callbacks, but mixing never acquires that guard. The consumer peeks partial/future blocks without releasing their storage, so capture cannot overwrite samples still in use. Buffer capacity and the 40 ms mixer offset are unchanged. The resettable MOV queue remains independent. Device timestamps, rather than callback-arrival jitter, establish mic positions. Stale seek generations cannot overwrite the latest movie frame. Camera rate negotiation stays inside supported ranges.

The audio-ring regressions cover 3,000 1,024-frame capture packets split across independent 480-frame output boundaries with zero measured handoff allocations, 20,000 concurrent ordered blocks, bounded capacity, partial/future samples, stale generations, overlap rejection and nonmonotonic mix requests. Reopen creates fresh owned endpoints rather than allowing a third thread to reset a live ring.

This first room does **not** finish N1/N2 or replace production. Native compressed program/original takes have partial hardware/recovery qualification. The [committed-take editing slice](../TAKE-EDITING.md) adds frozen take assets, trim/seek and explicit refresh alongside a running recorder. Its short unlocked five-track record/edit test now passes: 55 fragments fully decoded, both 1080 program outputs about 29.99 fps, and 19/19 sampled ready frames across two playback fragment boundaries with no new counted audio or GPU submission loss. This is not long-session, subjective A/V or memory qualification. Hostile codec/IO termination, audio hardware monitoring, full source reconnect/format-change qualification, broader native Set/Show controls, actual ChatGPT/MCP adapters, full text/vector/effect rendering and Windows/Linux/Intel physical tests remain open. The previous N0 quiet-host memory qualification is unchanged. CPU submission timing is not GPU duration, end-to-end latency or proof of 60 fps.

### Native surface renderer follow-up, 2026-11-18

The [native 2D surface slice](../NATIVE-SURFACES.md) replaces the one-title strip with cached, individually styled system-font text and typed alpha-gradient surfaces, pixel radii, borders and grain. A public train fixture passed paired dark/light recording, local surface editing and dock roundtrips. This is a compositor specimen for Classic, rather than its completed eight-layout design. It does not qualify the pending full renderer, Assistant adapter or public beta. The previous camera/mic/take results retain their original exact-source scope.
