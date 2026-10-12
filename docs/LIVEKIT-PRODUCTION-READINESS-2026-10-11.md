# LiveKit production release status — October 11, 2026

**Not deployed.** GitHub's current stable Producer release is v0.4.69. The native
app and Boomin guest session routes still use the existing guest transport. The
LiveKit work is an isolated native prototype; publishing its branch does not
change users' rooms. No new Apple signing or notarization submission occurred.

## What the latest candidate proves

Opt-in Absolute Capture Time (ACT) negotiation works between the tested Chrome
155 browser publishers, actual LiveKit Cloud, and the pinned native receiver.
It uses transceiver header-extension APIs, not SDP text edits or a patched SFU.
Audio and video metadata are observed in decoded native frames. The native
adapter converts capture-system time to publisher NTP time by subtracting the
signed capture-clock offset and interpolating the exact PCM RTP position.
Remixed CSRC sources, wrong SSRCs, missing metadata and distant RTP positions are
rejected. Audio interpolation expires after 200 ms; binding/generation changes
clear it. A capture-clock jump requires another consistent packet. There is no
arrival-time substitute and no mixing of ACT scheduling with sender-report maps.

The candidate remains opt-in. Existing lab/default and application behavior are
unchanged. Cloud room stream synchronization is explicitly disabled for these
ACT trials; the mode is recorded in each conditions file.

| Trial | Scope | First audio/video scheduling | Recording | Acceptance |
| --- | --- | --- | --- | --- |
| `1791760183325409000` | One guest, 35 s; ACT availability only, old SR scheduling | 9.009 / 9.031 s | 13 pairs, 43.333 ms absolute p95 | Failed readiness; confirms metadata availability, not scheduling |
| `1791760736611968000` | Three guests, 60 s, one forced full reconnect; ACT scheduling, audio initially waited for video | Initial 0.658 / 0.691 s; recovery 2.023 / 2.035 s | 28 pairs, 63.333 ms p95; missing label 10 and unpaired label 33 | Failed readiness and marker coverage |
| `1791761280229261000` | Three guests, 35 s; ACT audio starts independently | 0.015 / 1.203 s | 17 pairs, 43.333 ms p95; no missing markers | Passed unchanged short recording gates |
| `1791761403217547000` | Same latest binary, three guests, 60 s, one forced full reconnect | Initial 0.021 / 0.933 s; recovery 1.036 / 1.234 s | 29 pairs, 63.333 ms p95; missing label 10 | Timing and local marker offset gates passed; overall acceptance still failed coverage |

These tests receive three guests but record **only selected guest-1**, using
generated media. They do not prove three-person composition, live capture lip
sync, phone compatibility, five-hour stability or a complete conference AEC path.
The latest forced-reconnect loss has no selected native video receipt for label
10. Its exact source-to-delivery cause remains unresolved; source generation
alone is not delivery proof. The preceding candidate's label 33 reached both
output queues but was dropped late. All failed evidence remains retained and the
existing 1.5-second prototype budget/coverage gates were not relaxed.

All owned Cloud trial rooms were deleted successfully. No physical devices or
audible playback were used. Server credentials stayed server-side; retained
numeric evidence was checked for the actual API credentials. The evidence index
`labs/guest-rtc/evidence/native-capture-clock-checkpoint.json` pins numeric inputs,
binary hashes, source hashes and each trial's scope.

## What still prevents a production migration

1. **G1 qualification:** resolve/measure recording loss through recovery;
   qualify all guest outputs, actual speaker-reference routing in the conference,
   supported guest browsers/devices, WAN impairment and packaged native builds.
   Chrome's experimental public header negotiation is not a Safari/Firefox proof.
2. **G2 admission/control:** implement the versioned transport manifest, backend
   token issuance, producer fencing and coordinated admission/grant/stage changes;
   prove revoke/replay/concurrency and private-cue isolation. The API has no
   LiveKit session integration or deployment bindings yet.
3. **G3 native room integration:** replace the runtime transport attached to
   stable guest source IDs; connect program return and owned audio processing;
   retain sets, filters, transforms, faders and recording behavior across exits,
   scene changes and republish. The app has no LiveKit adapter yet.
4. **G4–G6 rollout:** complete supported device/network/load/soak coverage, then
   deploy a fenced pilot cohort with legacy compatibility and rollback; build,
   sign/notarize and publish the actual integrated native release.

The reviewed [implementation plan](./LIVEKIT-GUEST-REFACTOR-PLAN.md) and
[review](./LIVEKIT-GUEST-REFACTOR-REVIEW-2026-10-09.md) remain the release contract.
The short ACT pass does not mark those gates complete.

Validation at this checkpoint: 77 native Rust tests and Clippy with warnings
denied (`obs-proof,physical-aec`), 16 recording-gate tests, nine loss-analysis
tests, two credential-profile tests, and 100 native lifecycle cycles. All 201
mixer source wrappers and 200 event logs were destroyed; threads stayed 1→1 and
file descriptors 4→4. Capture metadata adds no retained media owners, threads or
observers; transceiver references are temporary and mixer state keeps its weak
registry backlink.
