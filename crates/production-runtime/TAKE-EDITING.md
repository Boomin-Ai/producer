# Committed-take editing: native development slice

The recorder can keep running while the editor plays an immutable snapshot of
its committed fragments. This is an isolated Native Dev path, not a production
cutover or a completed NLE.

## Identity and ownership

A growing recording directory is not an imported movie. `CommittedTrack` freezes
one published head, indexes one selected track, and hashes its immutable header
and ordered chunk metadata into an asset identity. It rejects unpublished chunk
indices, overlapping/changing streams and oversized indexes. Video and audio use
independent half-open sample intervals: capture gaps stay unavailable/silent.
The index is an envelope, not a claim that every instant inside it has samples.
Separate bounded video/audio indexes handle a fragment with no samples for one
medium without breaking binary lookup or shifting the other medium's time.

The existing authoring DSL remains sufficient: an immutable `Asset`, a `Player`
source and ordinary timeline placements, trims and source-in times. The private
local grant maps the asset digest to a take name, track and frozen head. Neither
recording paths nor codec objects enter the production document. Refreshing
publishes a new asset identity and rebinds the source; it preserves clip trims,
other media sources, the library's prior assets and the recording clock.

Indexing, digest checks and AVFoundation decoding run on control/media workers.
The render/audio lane only maps compiled placement times, queues bounded
requests, polls generation-qualified replies and submits GPU textures. It does
not read fragment files or open codecs. A full request queue is retried; a
paused seek cannot lose its only request. Replies from the wrong generation or
a remote source-time interval cannot be displayed over a new cut.

Independent fMP4 fragments retain recording PTS in the manifest, but AVFoundation
rebases their asset timelines. The adapter maps each medium through its own
manifest start and AVFoundation track start before decoding. Ten-millisecond
audio blocks can span two adjacent fragments without shifting host sample time.

## Native room commands

Use the already running isolated Native Dev room's same-user socket:

```json
{"op":"takePlace","name":"take-<local-id>","track":0,"start":0}
{"op":"trim","clip":"take-clip","start":2,"duration":3,"source_in":1}
{"op":"takeRefresh"}
{"op":"seek","seconds":3}
```

`takePlace` also accepts optional `duration` and `source_in` in seconds. Omission
chooses a valid start rounded inward to the editor's 48 kHz time grid and up to
eight seconds of committed video. A requested trim outside the frozen available
range is rejected. `takeRefresh` exposes newly committed material but never
extends a user's clip automatically. An unchanged checkpoint is still safe to
read. Saved, interrupted and actively recording takes share the same reader.

The native Set media column gets an additional take tile, and a separate V4
lane appears in the timeline. Controls expose **Edit committed take** for the
current recording and **Refresh committed footage** for a placed snapshot.
Normal document transactions can add nonoverlapping cuts of that source;
playback resolves the active placement rather than only its first clip.

Recording progress is fenced by session. A delayed Saved/Failed snapshot from
the preceding take cannot replace a new take's head or clear its recording
state. Stop also checks the recorder's actual busy state.

`state.takePlayback` reports the frozen head revision, available envelope,
asset digest, decoded frame count, generation, ready frame, output draw counts
and decoder error. Recording progress remains separately under `state.take`.
`--inspect-take <name> <track> <times...>` tests the actual native fragment
reader without starting devices or exporting captured frames.

## Bounded first-pass limits

- One placed take source alongside the existing MOV player. Up to four media
  workers cover two active readers and retiring/replacement readers.
- One video and one audio fragment decoder per take worker; bounded request,
  audio and latest-frame handoffs. No whole-take raw-frame cache.
- At most 4,096 fragments in a view (roughly 2.3 hours at two-second cadence).
  This is a reader-index limit, not the durable recorder's 24-hour limit. A
  paged/windowed index is needed for larger takes.
- A video track is required. Audio-only original editing, arbitrary additional
  simultaneous take players and independent mixed-source take comping remain
  later slices.
- The first native Set adapter has an explicit media column. This does not add
  automatic take slots to arbitrary third-party Set layouts.
- Opening a native codec is bounded by admission/request timeouts, but a stuck
  platform codec or filesystem call cannot yet be forcibly terminated. Worker
  slots stay charged until the worker actually exits.
- Long-run RSS, lip sync/listening, device reconnect, real drive removal/full
  and Windows/Linux/Intel qualifications remain separate gates.

Production's app, profile, existing Set engine and published release are not
modified by this development path.

## Qualification status, 2026-11-18

The pure workspace passes 217 tests, including frozen views, sparse per-medium
availability, missing required streams, corruption and range rejection. The
desktop passes 14 tests, including later-cut lookup, stale-session progress and
the prior bounded recorder/audio regressions. Actual native reads of landscape,
portrait and camera-original fragments return frames across later fragment
boundaries and return no frame after the committed end. Two separate cuts also
render into both output roles through the same-user room CLI.

Two consecutive device-free recordings on the installed reader candidate saved
with distinct sessions; all eight committed fragments hash-checked and fully
decoded. These runs do not qualify physical input or real-time editing.

The unlocked five-track recording/editing run now passes on installed UUID
`8406CEF2-17ED-3857-909E-17B186700177`. Physical camera, ScreenCaptureKit, MOV and
mic remained active while a frozen program snapshot was placed, trimmed,
refreshed and given a second cut. Invalid trim rejection retained the document;
refresh preserved trims and live-source bindings while the recording head
continued advancing independently. Both program outputs and camera/screen/mic
originals saved; all **55 fragments** hash-checked and fully decoded. Each 1080
program output contains **595 frames at about 29.99 fps**, with no reported
inter-fragment media gaps.

During the 4.51-second sampled continuous interval across two fragment
boundaries, all **19/19 samples** had a ready take frame and one take draw in
each output. Mic rejection, mixer missing frames, audio clock skips, timestamp
discontinuities and GPU submission refusals each had zero delta. Program audio
was non-silent in the playback fragments with the live mic and MOV program lanes
muted. Sampled CPU evaluation/build/submission p99 was at most **2.70 ms**;
this excludes GPU execution, encoding and end-to-end latency. Sampling readiness
is not proof that every display frame met its deadline, and decoded non-silence
is not subjective listening or lip-sync qualification.

Earlier locked-host continuous-readiness and finalization/handoff failures are
retained, not reclassified as passes. The exact cause of the earlier bounded
handoff failure is still unproven. The unchanged readiness threshold passed in
the unlocked rerun. A stale ad-hoc Screen Recording grant also rejected this
executable until only Native Dev's entry was re-added through normal System
Settings and Quit & Reopen. No executable change or OS bypass was involved.
See the [sanitized record](evidence/native-take-editing-proof.json). Long-session,
quiet-host memory, subjective A/V and cross-platform gates remain open.

```sh
python3 crates/production-runtime/desktop/scripts/check-edit-take.py \
  --binary target/native-room/debug/producer-native-room --record --live \
  --evidence /absolute/private/local-proof.json
```

This opts into local camera/screen/mic originals as well as paired program
outputs. Omit `--live` only for the explicitly device-free variant.
