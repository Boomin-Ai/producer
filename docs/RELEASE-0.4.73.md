# Producer v0.4.73

Replaces the separate portrait-device design with one Producer Virtual Camera, retaining the original device UUID and advertising 1920×1080 and 1080×1920. Producer selects the sink format from its canvas and verifies readback. Receivers cannot override an active writer; orientation changes with a locked receiver require a reconnect.

Fixes the mirror failure: BGRA lacked a CoreVideo mapping, silently triggered NV12 fallback, and bypassed the pixel-reflection branch. The feeder now maps BGRA natively. Actual synthetic camera frames pass normal/mirrored/restored corner-marker checks in both orientations, with one device ID and uninterrupted receiver tracks during mirror changes.

macOS removal requires the retired identifier to exist in the requesting bundle. A removal-only helper under that identifier publishes zero devices and is never activated; it enables deactivation of the previously installed portrait extension. Strict migration and camera-frame proof passed in signed dev. Publication is held for the user’s explicit dev review and approval.

Existing Windows/Intel/Linux capabilities are unchanged. This does not add new camera support on those platforms.
