# Clips — local rolling capture

Clips is a host room panel. Add it through the room's Panels menu. Capture is
**off by default**, including after reopening a room or restarting Producer.
Turning on the switch starts a bounded encoded replay buffer of the actual
program output. It does not start a stream, a full recording, or an upload.

Choose the buffer window (1–600 seconds), encoded memory budget (64–1024 MB
total), and landscape, vertical, or both before turning on capture. Keyframes,
warm-up and the memory limit affect the actual retained window; saved files
show their measured container duration. Both creates two MP4 files sharing the
room's program audio mix. These initial buffers own independent H.264/AAC
encoders, so enabled capture has a measurable encoding cost. Off has no replay
encoder or packet-buffer allocation.

Save last… requests an asynchronous mux. Only one save may be pending. The UI
shows Saving until OBS's saved signal confirms the writer closed. The native
owner then returns the paths; container validation and a bounded MP4 duration
probe must pass before the job and existing local recording catalog become
ready. Media bytes never upload automatically. A failed save stays visible and
is never silently counted as playable.

Hiding or moving the panel preserves capture. Leaving the room, replacing its
native graph, or quitting stops it. Video/canvas changes are refused until
capture stops; the portrait canvas is retained while a vertical buffer owns
it. Either-output encoder failure stops both packet streams. A missing writer
receipt times out, surfaces an error, and stops further buffering. A crash
marks pending jobs failed on next launch, with guidance to inspect the folder.

The folder picker is a per-profile recording preference, shared by Clips and
future full Record starts. It does not move a currently open recording. A
missing selected folder (including an unmounted external drive) fails rather
than silently falling back to the internal disk. The legacy default remains
Movies/Producer on macOS and Videos/Producer on Windows; an existing symlink
continues to work.

Implementation:

- `src-tauri/src/live/replay.rs`: pinned OBS replay output, atomic signal
  receipts, owned hardware-preferred encoders and engine-thread lifecycle.
- `src-tauri/src/clips.rs`: validated IPC, local job catalog and folder setting.
- `src-tauri/src/clips_media.rs`: bounded finalized MP4 duration parsing.
- `src/features/clips`: room-owned controller, full and compact dock UI.
- Room CLI: `clips.status`, `clips.configure`, `clips.enable`, `clips.disable`,
  `clips.save`, `clips.list`, all behind the current host room/epoch boundary.
  This does not grant the Assistant recording authority.

Validation: `node scripts/test-clips-panel.mjs` exercises opt-in behavior,
concurrent-save prevention, hidden/expanded dock lifetime, room exit, recent
file durations and 140–800px widths. Rust duration tests can also run alone:
`rustc --test src-tauri/src/clips_media.rs -o /tmp/clips-media-test`.
Native compilation, signed packaging, actual A/V decoding, full-recording
concurrency and performance qualification are separate checks; browser mocks
are not evidence of native capture working. Linux builds without an engine
report the native requirement rather than simulating Clips.
