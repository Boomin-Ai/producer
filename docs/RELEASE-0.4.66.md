# Producer v0.4.66

Restores the complete recovered set authoring and room UI work alongside the current production release pipeline.

- Persistent set picker with sections for controls, import/export and advanced authoring; built-in sets and the saved Documents/boomin/docs/shows library.
- Segment media playback controls, first-segment show startup, reusable style tokens, guest focus and video sizing, media assets, animation and shader layers, and portrait output.
- Distinct edit pencil, inline layout editing, native window drag handle, room activity ledger and recording Manager action, and recording Open location metadata action.
- Keeps current branded room routing, Windows shared-filter imports, Apple installer notarization and 30-second cold set preparation timeout.
- Preserves the full recovered source snapshot on the recovery branch; release versions are aligned at 0.4.66.

Validation: frontend build and TypeScript, server and browser TypeScript, 319 server tests, 19 presentation runtime checks, 60 Rust tests (one existing ignored check), native compilation, shared output renderer and capability security proof, Windows raw-dylib import coverage, shim parity, scene restoration, room session/control/vote handling, program readiness, guest return, preview sessions, Manager cache, slot/stage/feature/domain tests, and public room route tests.

Production distribution and Apple notarization status must be verified against the release workflow before calling the release complete.
