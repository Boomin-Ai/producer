# DJ in Rooms

DJ is a host-controlled room panel. It uses the existing top/bottom mini docks,
expanded row docks, side rails, placement menu, drag handles and saved layout.
It is introduced in the bottom dock once. Hiding it preserves music playback.

## Controls

The default view is a simple player and tracklist. **Mix** reveals both decks
and the crossfader; that preference is saved per room.

- Local MP3, M4A, WAV, FLAC and OGG tracks; `~/Music/Producer` is the Mac default.
  Choose another folder or add individual files. Folder scanning includes nested
  directories, skips symlinks, caches unchanged metadata and scans on panel open.
- Embedded title/artist/cover art, or a chosen cover stored separately from the
  original audio. The source file is never rewritten.
- Two native decks, seek, play/pause/stop, previous/next, and loop per deck.
  In Mix, click a deck to select the library loading destination; clicking a
  track loads that deck paused. Selection does not move the crossfader or stop
  the other deck. Simple mode still plays a clicked track immediately.
- Library scrolling is independent of the decks/mixer. Search expands from
  the magnifying-glass button; closing it or Escape clears the filter. The
  three-dot button slides compact library tools left into the same header: tracklist
  selection/creation, adding files, choosing the folder and rescanning it.
  Escape or the three-dot button closes the tools. Tracks remain visible and
  keep their scroll position while the tools are shown.
- Vertical master volume sits at the far left in wide docks; in
  side rails it sits to the left of the decks with the library below. Mini docks keep
  a horizontal volume control. A/B crossfader, 0–12 second fades and
  repeat/shuffle tracklist are also available.
  Mix opens at the center (equal A/B), marked on a neutral rail with a mixer
  handle. Double-click centers it. Mix Play preserves the chosen balance;
  simple-player Play routes fully to the selected playing deck.
- Compact Shuffle/Repeat/Duck mic buttons use icons, tooltips and accessible labels.
- Artwork-backed decks use circular covers that rotate during playback and pause
  in place. Deck A is mint; deck B is lavender. Side docks stack compact decks;
  expanded top and bottom docks share the same layout, placing decks beside
  the library when space permits. All controls remain available.
- Sliders calculate values directly from pointer position, avoiding native WebKit
  range/capture conflicts. Keyboard arrows, Home/End and Page Up/Down work too.
  Drags keep a local value while playback polls arrive. Timeline seeks
  commit on release; volume and the crossfader update live. All sliders have
  zero text-field insets and reach both endpoints.
- Mic ducking: microphone peaks lower music, with a slower recovery after speech.
- Named tracklists, persisted order, add/remove membership and reorder arrows.
- BPM metadata/detection, manual correction and tap tempo.
- **Sync to A** prepares a paused deck B at A's tempo with pitch preserved.
  Changes are limited to 0.75–1.33 of original tempo. This is tempo matching,
  not automatic beat-grid alignment. Loading the original again restores its tempo.

The simple view and mini strip operate the current deck and pauses/stops both decks coherently.
Expanded transport buttons operate each deck. Deck Stop fades toward the other
side; mini Stop fades all music out. Tracks never autoplay on room open.

## Ownership and output

`live/dj.rs` runs on the existing engine thread. Each deck is an audio-only
`ffmpeg_source` on reserved main-view output channels 3 and 4 (room 0, legacy
mic 1, Studio 2). It is not a scene item, so scene cuts, hiding Sources, switching
Studio and moving/hiding DJ do not stop music. Native monitoring is set to
monitor-and-output; the same main audio mix feeds stream and recording encoders.
Virtual camera is a video output and does not itself transport music audio.

The engine tick owns queue progression, fades, looping and ducking. Webview polls
only show transport state. No React timer schedules audio. Paused/stopped decks
have zero gain, including decoder startup. Idle room release clears both decks;
leaving while a stream/recording is running keeps the output intact.

`dj.rs` owns the local library and worker-thread metadata/BPM/tempo processing.
Lofty reads tags and artwork, Symphonia decodes in bounded packet-sized blocks,
SoundTouch detects BPM and changes tempo without changing pitch. No external
FFmpeg executable is required. Original tracks remain at their chosen paths.

App data `dj/library.json` stores tracks/tracklists and cached analysis; cover
images and derived tempo WAVs also live under app data `dj/`. Their size is
included in Settings → Storage app data. Room tracklist/mix preferences use
local storage keyed by room ID. This is a local library, not brand cloud storage.

## Verification

- `npm run build`
- `PRODUCER_ENGINE_DIR=/Applications/Producer.app/Contents cargo test --manifest-path src-tauri/Cargo.toml dj:: --lib`
- `scripts/dj-browser.html`: dock normalization, ordered tracklists, tap BPM,
  no autoplay, import duplicate guard, transport, mini form, playback after hide,
  and preserving an active deck B when reopening.
- `scripts/test-dj-sliders.mjs`: Chromium pointer regression via CDP port 9337.
- `scripts/test-dj-ui.mjs`: Playwright WebKit pointer/thumb, keyboard, delayed
  playback responses, seek-on-release, responsive 200–900px dock geometry and
  spinning/paused covers, independent wheel scrolling, collapsed search and
  loading a selected deck without autoplay. Install Playwright separately or use `PLAYWRIGHT_MODULE`
  to point to its module; tests use mocked IPC and do not control real playback.
- Debug-only `PRODUCER_DJ_SELFTEST=1 <bundled-debug-app>/Contents/MacOS/producer`:
  synthetic WAVs, real native transport and recording, auto crossfade, pause,
  seek, fade stop, room release. Checks decoded recording RMS/peak. It creates
  no devices/network connections and does not write the user database. Host
  monitoring is disabled in this harness. The recording is moved to a reported
  temporary folder. Normal app playback uses monitor-and-output.

BPM estimates can have half/double-time ambiguity; tap/edit is the correction.
No YouTube integration or automatic beat-grid alignment is implemented.
This feature has not been released or notarized.

## Design references

- [djay deck views](https://help.algoriddim.com/user-manual/djay-pro-mac/getting-started/decks): compact one/two deck layouts and vinyl platters.
- [VirtualDJ decks](https://virtualdj.com/manuals/virtualdj/interface/decks.html): grouped track information and transport controls.
