# Producer v0.4.69

Camera filter settings, order and enabled state now persist across room exits and camera replacement. Restoration keeps the saved cutout, chroma key and other user filters on the recreated source; a failed filter restoration keeps that source hidden.

Browser guest links recover lost signaling sockets using fresh session tickets and ICE credentials, while retaining their camera/microphone tracks and peer connections. Reconnect negotiation flushes pending offers and avoids replaying stale answers. Leaving cancels late reconnect work. Boomin-hosted guest pages require the corresponding web deployment; the self-hosted guest bundle is included here.

Recording now writes fragmented MP4 with its movie index available during capture. Failed helpers produce an immediate error and a native diagnostic log. Both landscape and portrait container completion are checked before marking recordings ready. Interrupted files remain on disk for recovery; footage never written cannot be restored.

Validation includes real native camera-filter restore/source replacement, native landscape and portrait recording plus forced-helper failure, browser WebRTC reconnection and video decoding, recording persistence tests, guest permissions/stage/mute checks, frontend builds and release CI. See CAMERA-FILTER-PERSISTENCE.md, GUEST-RECONNECT.md and RECORDING-FINALIZATION.md for scope and limits.

Apple Silicon builds include the native Live engine and require Developer ID signing, Apple notarization and stapling for the app and installer. Intel macOS keeps its engine-less build with signed/notarized installer; Windows keeps its Live engine and Linux keeps its engine-less build.

Release verification (2026-10-09): [all platform release jobs passed](https://github.com/Boomin-Ai/producer/actions/runs/37968320318), and [frontend/server/Rust CI passed](https://github.com/Boomin-Ai/producer/actions/runs/37968584808). Downloaded Apple Silicon and Intel apps and installers pass Developer ID signature, Apple staple validation and Gatekeeper checks. Apple Silicon, Intel, Windows NSIS and Linux AppImage updater signatures verify against the configured public key. The final manifest covers all ten platform/installer aliases and uses each uploaded artifact's signature. Hosted guest reconnect is deployed in Boomin web commit `75630c1039ccdb87aebdb8845c30e40525d1ebc8`; producer.dev serves the verified room bundle.
