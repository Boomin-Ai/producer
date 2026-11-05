# Windows production validation: 0.4.84

Use the published stable 0.4.84 installer or updater, not the unreleased Mac performance branch. Check the footer version and the release's verification.json source revision. Preserve the Windows profile, credentials and stream keys. The Mac remains on performance.6 for continued graphics experiments.

The stable release includes selected-output preparation priority, prepared-layout reuse, asynchronous native wait scheduling, shared HTTP transports, responsive RTC shutdown, optional diagnostics, and native-preview close ordering. It deliberately retains the established Set graphics pipeline. The owned-raster cache under review in PR #122 is outside this release.

On real Windows hardware:

1. Enable local capture in Settings and note the display/GPU, driver, Windows version, output orientation and resolution/frame rate. Leave diagnostic sharing off unless explicitly wanted.
2. Start Producer fresh, open Atlantium with camera and microphone active, and wait for preview, moving mic meter and Set. Record first audio, first preview and first Set separately.
3. Return to the room cards, watch for camera/Set flashes, wait for cleanup, then reopen for the warm run.
4. Switch Hero, Split and Presenter in both orientations. Check output continuity and switch delay. Add and edit a source while the Set is active; it should remain on output.
5. Copy the guest link, test the guest path, move Set Controls between docks, and enter/leave layout editing. Verify outlines, square canvas and actual panel-drop completion.
6. Switch workspaces and back; confirm saved stream keys remain associated with the correct workspace without exposing them in logs or screenshots.
7. Export local diagnostics and retain the matching release source and Actions test receipts. Report real display/audio behavior alongside timings; native readiness and layout commits alone do not prove visible or audible output.

Hosted CI cannot qualify real device startup or broadcasting reliability. Unsupported graphics adapters and tests that did not run must be reported as such. This checklist does not authorize starting a public broadcast.
