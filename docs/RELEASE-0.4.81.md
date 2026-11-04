# Producer 0.4.81

- Faster room entry, cached dashboard state, and safer workspace changes.
- Improved camera and microphone startup and room teardown.
- Corrected canvas framing, source outlines, panel movement, and Metal display lifetime.
- Sets retain their source placements through source edits and reuse prepared output resources.
- Redesigned Set and Show docks with visible layout choices and minimized playback controls.
- Room Sounds lists connected sounds with library management in Sound settings and playback in minimized docks.
- Activity opens as a sheet beneath its toolbar slot without moving the stage or docks.
- Guest-link copying reuses resolved links, coalesces concurrent requests, and preserves minted invitations through share-address failures.
- Improved first-install virtual-camera handling.

The Apple Silicon production build includes the native guest runtime.

All four primary updater payloads passed signature verification against Producer’s pinned public key before publication. macOS installers passed signing, notarization and stapling jobs. See verification.json for exact artifact hashes.

The local dev sound library import is machine-specific. The repository preserves the source sound pack and catalogs.
