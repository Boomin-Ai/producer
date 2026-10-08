# Thread recovery — 2026-10-08

The authoritative recovered development checkout is:
`/Users/klevelandbishop/Documents/producer-thread-dev`
Branch: `recovery/thread-dev`.

The original checkout at `/Users/klevelandbishop/Documents/producer` remains on production `main`. Building that checkout does not reproduce the recovered thread UI.

## Recovery evidence

- Original checkpoint: `6f27ce7`.
- Saved pre-rebase state: `87f82cc` (working and index trees match the checkpoint).
- Saved untracked tree: `3e02ac3`.
- Complete materialized snapshot: `656ede3` (checkpoint plus every one of the 503 saved untracked files).
- Native set-picker visibility fix: `1245954`.
- All 503 untracked snapshot files compared byte-for-byte after restoration: identical.
- Recovered checkout has no remaining untracked source files or unstaged edits.
- Snapshot objects are pinned under `refs/recovery/` and the complete source is committed on the recovery branch.

## Verified functionality and artifacts

Recovered source includes the distinct edit pencil, inline layout editing, window drag handle, room activity ledger, recording action and Manager Open location, persistent sectioned set menu, native set library commands, segment media controls, first-segment startup behavior, source geometry, media, shader and animation schemas, portrait output, show files, authoring documentation and scripts, backend support files, and iOS source.

Saved library: `/Users/klevelandbishop/Documents/boomin/docs/shows`.
All 11 saved JSON sets validate with the recovered schema, including Claude Code, Four Host Grid, Local Host, Own Your Distribution, AI Signal, AI Stack and shader examples.

TypeScript check passes. Presentation runtime: 19 checks pass. Native compilation and bundle signature verification pass. The native app renders; room interaction beyond the picker change has not received a full end-to-end audit. Production release changes have not yet been merged with this recovered checkpoint.

Native application:
`/Users/klevelandbishop/Documents/producer-thread-dev/src-tauri/target/thread-dev/Producer.app`

This checkpoint retains version `0.4.51`; that is its inherited version metadata, not a new production release.
