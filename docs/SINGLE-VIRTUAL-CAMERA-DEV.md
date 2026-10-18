# Single virtual camera refactor

Replaces the two-device v0.4.72 approach. One `Producer Virtual Camera` retains the original device/stream UUIDs and extension identifier. Its source and sink advertise 1920×1080 and 1080×1920 BGRA. Producer sets the sink format from the selected canvas; the extension synchronizes its source active format and placeholder pool, then notifies clients. Format readback must match before sending frames. Receiver format requests cannot override an active writer. An incompatible orientation switch with connected receivers fails explicitly; close/reconnect their camera rather than stretching frames.

Only the original extension ships, with version 1.3/4. After successful format negotiation the plugin requests supported macOS deactivation of the retired portrait extension through a separate retained delegate. Any required macOS approval/reboot remains an OS requirement. Source selection continues to exclude the old device while migration is pending.

Mirror remains a live flag on this one feeder. Real corner-marker proof is required in both orientations, including mirror/unmirror on a stable receiver track and landscape → portrait → landscape reconnects. Local extension and feeder compile; full native signed dev and real-device validation pending. No production replacement has been published.

The first signed native run exposed the previous mirror failure: upstream did not map VIDEO_FORMAT_BGRA to kCVPixelFormatType_32BGRA, so it fell back to NV12 and never entered the mirror branch. Added explicit BGRA mapping; raw device proof is pending the corrected signed candidate. macOS has activated the single camera extension 1.3/4; retired portrait cleanup will run after successful format negotiation.
