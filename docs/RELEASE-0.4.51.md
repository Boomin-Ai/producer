# Producer v0.4.51

## Included

- DJ in Rooms: local music library and tracklists, artwork decks, transport,
  seeking, fades, crossfader, master volume, mic ducking and BPM tools.
- Native music reaches the recording and streaming audio mix. Playback persists
  when the DJ panel moves or hides; tracks do not autoplay when opening a room.
- Shared expanded top/bottom dock layout, independent library scrolling,
  inline search and compact library tools that slide left into the header.
- Transparent chat output controlled from the chat panel; messages remain
  visible until newer messages scroll them out.
- Recording completion uses a dismissible toast with a View in Manager action.

## Verification

Frontend production build, WebKit slider/transport/layout checks, native DJ
unit tests (gain, ducking, queue, BPM and pitch-preserving tempo), native
recording self-test, Rust formatting and shim extern parity pass locally.
CI checks the exact release checkout on Linux, Windows and macOS before tagging.
SoundTouch is bundled so the application does not require a system music library;
Linux builds compile it with position-independent code and install bindgen's
Clang dependency.

## Distribution

The established release.yml workflow assembles the engine, signs nested code,
checks camera provisioning and dependency closure, notarizes and staples the
Mac app and DMG, and publishes installers plus the signed updater manifest.
