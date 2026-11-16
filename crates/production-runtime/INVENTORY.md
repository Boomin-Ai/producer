# Existing product and proposed production core ownership

Reviewed against released source `667147951452931ebbc7f26db6dec02616aee74d` (0.4.93). This is an ownership map for the isolated laboratory, not a claim that the application has been migrated. The existing app continues to execute all product behavior.

| Concern | Existing product entry points | Laboratory ownership and boundary |
| --- | --- | --- |
| Set document, controls, layouts | `src/features/presentation/schema.ts`, `SetControlsPanel.tsx` | `contract/src/model.rs`: typed Set, layout, actions, controls and scoped component references. Compact/equal-width/primary intent is semantic data; no new controls UI is mounted. |
| Show segments and live operation | Presentation feature and current server/room Show state | Local Show references paired Set layouts and a sequence. Hosted authorities remain read-only projections; the local reducer cannot create, replace or delete a hosted writer. No server state or guest policy changes. |
| Studio motion authoring | `src/features/studio/motion.ts`, `useStudioComposer.ts`, `useStudioSpotlight.ts` | `Time`, `Range`, nested sequence instances, scoped target/player bindings, track/cue document and headless transport plus compiled numeric evaluation. The current Studio motion path is not replaced or treated as proof of exact new seek behavior. |
| Studio sampling and final output | `src/lib/studioOutput.ts`, `src/features/studio/useStudioProgramMonitor.ts`, `src-tauri/src/live/studio_motion.rs`, `studio_window_capture.m`, `studio_preview.rs`, `program_capture_output.rs`, `program_capture_clock.rs`, `studio_room_gate.rs` | Native adapters must eventually provide immutable frame ownership, output PTS, density/color/alpha and actual presentation receipts. The synthetic adapter opens no windows and captures no UI. |
| OBS scenes/capture/render | `src-tauri/src/live/engine.rs`, `presentation.rs`, `presentation_probe.rs` | Rust core owns document semantics, validation and future compiled plans; qualified existing OBS/C/Objective-C bridges can execute low-level work. The new crates have no Tauri/OBS/GPU linkage. |
| Imported media and recordings | Existing source types; `src-tauri/src/live/record.rs`, `recording_name.rs`, `src-tauri/src/recordings.rs` | Immutable asset identity is distinct from runtime source/player and placement. One asset can have independent players/trims. No codec, file probe, recording, deletion or source-path access exists in this laboratory. |
| Audio/DJ/soundboard | `src/lib/dj.ts`, `djObserver.ts`, `soundboard.ts`; `src-tauri/src/live/dj_audio.rs`, `soundboard.rs`, `soundboard.c` | Explicit program/monitor audio routes are validated; no audio samples are emitted. Preserve current native mixer, monitoring, mix-minus, DJ and soundboard behavior until independently qualified. |
| Assistant/MCP/CLI authoring | Existing room tools and `crates/assistant-runtime` | Generated schemas and stdio CLI use the same native reducer/admission path. Agents author typed commands and JSON; they do not become a second authority or write frame state directly. This CLI does not connect to the production Assistant. |
| Document persistence | Existing app profile, Set folders and server storage | Separate experimental FileStore requires an explicit empty directory, takes a writer lock and uses journal/checkpoint receipts. No production default, profile migration, credentials, device permissions or network writes. |
| Frame evaluation | Existing Set/browser and Studio execution paths | Compiled numeric target handles and preallocated scratch. JSON parsing, command admission, canonical hashing and filesystem IO are control-lane work. Renderer analytic evaluation must consume supplied content time, not invent semantic wall-clock time. |

## Contract profile

`contract/src/lib.rs` owns the byte/depth/work, node, key, track and atomic-command limits. `contract/src/time.rs` owns exact rational time and decimal-string counters. `contract/src/ingress.rs` owns duplicate-key, UTF-8 and canonical JSON rules. Schema and TypeScript artifacts are generated from those Rust types by `scripts/generate.py`; JS structural validation must always be followed by native semantic admission.

The application has used Serde already. Using Serde here does not by itself accelerate rendering. The intended gain comes from compiling a bounded declarative graph once, keeping frame evaluation numeric and allocation-free, making resource lifetimes explicit, and qualifying renderer work separately.

## Features deliberately not advertised yet

The current implementation supports fixed boxes, row/column/grid allocation, nested positive-speed temporal placements, local numeric tracks, bounded cue-intent rehearsal and analytic 3D declarations. Anchors/aspect constraints, general Show occurrence ownership/cleanup, process-wide admission beyond the two-document lifecycle/compile host, segment-owned live override cleanup, native media/GPU execution and physical-platform qualification remain open. See `READINESS.md` for the acceptance ledger. A future capability must reject clearly until implemented; a model-readable schema must not silently promise it.

The isolated [workspace/compilation host](WORKSPACE-COMPILATION.md) now owns bounded workers, latest-intent coalescing, immutable fragment reuse and shared synthetic lifecycle/cache accounting. It has not replaced the production document authority or native allocation path.
