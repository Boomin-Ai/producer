# Rehearsal on room output

Rehearsal uses the same set projection and native composition pipeline as prepared set output. When a set is on output, Start and Next select each segment's assigned layout, including camera positions, framing, graphics and public results. Simulated participant controls remain in the set dock. Applying an attached show is supported without introducing a live show runner.

An off-output rehearsal remains a preview until Apply set is selected. Exiting rehearsal restores prepared content and layout on output. Source assignments and framing remain saved. Return to room cancels further automatic updates. A failed graphics preparation preserves the previous working composition and can be retried.

The dock exposes layout, content and source controls in preparation and rehearsal. Its body scrolls as one surface, including at short bottom-dock heights. Medium widths put source/content controls underneath the run and simulated participation controls.

The local native renderer includes the existing v0.4.63 readiness fixes: blocking accepted HTTP streams, private graphics preparation with a painted receipt, and destruction of retired compositions outside the scene atomic lock. These are imported from production commit f957b7508e87d88080b3f01b9401c4a3faf5a6e0 rather than a new native rendering strategy.

Validation:
- `npm run test:presentation`
- `node scripts/test-rehearsal-room-output.mjs` (set PRODUCER_REACT_TEST_RENDERER to a React 19 test renderer entry if using a different temporary tooling directory)
- `npm run test:presentation-browser` (set PRODUCER_PLAYWRIGHT_MODULE and PRODUCER_PREVIEW_ORIGIN as needed); Chromium and WebKit.
- `npm run build`
- Native debug build against the installed Producer engine. Native acceptance probe rendered three rehearsal projections, preserved source state, rejected duplicate revisions, restored room pixels and fenced cancelled preparation. The probe allows 1.5 seconds for the video pipeline to settle before capturing pixels.
- The dev launch uses a separate CEF module cache through the debug-only PRODUCER_DEV_MODULE_CONFIG_DIR override, allowing the installed app to remain open.

The rehearsal clock and participant inputs remain simulated. No live show runner or Shaders integration is added by this change.
