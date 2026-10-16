# First-frame binding and ongoing timing diagnosis

Status: isolated debug candidate, not released. The strict recording sync and
coverage gate remains unchanged. No physical media testing is required.

One first-decoded-video event may interrupt the initial stats wait once, while
that camera track remains unbound. A successful SSRC proof disables this shortcut.
Normal stats pacing, deadline failure invalidation, unique SSRC checks and
permissions remain unchanged. This does not trust decoded frame ownership without
the track's existing SDK stats proof. The diagnostic records separate first audio
and video binding timestamps and the retry count.

The candidate exercised exactly one additional query. First video binding was
available by the first decoded-frame observation. The run matched labels 4–10 and
16–17 at 43.333 ms absolute p95, but labels 11–15 were missing; the overall gate
failed. Last active presentation diagnostics contained 285 origin-delta and 18
late-deadline video rejections. This is not a complete startup/continuity fix.

A 50-second direct generated-source control passed with 25 matched pairs at
23.9 ms absolute p95. A receiver-stats Cloud repeat matched 13 consecutive labels
5–17 at 43.333 ms p95, but had two unmatched audio markers and failed the full
gate. Video decoding was below 0.1 ms per emitted frame; per-interval video
jitter-buffer delays were below approximately 100 ms. Those measurements do not
establish the cause of a mapped sender-origin difference exceeding 500 ms.

A comparison with the existing sender-report timing path, keeping signed CTS,
latest-frame video and the startup retry, matched eight pairs at 133.333 ms p95,
with four unmatched audio markers and missing labels 13–15 and 18. It failed too.
The early capture experiment alone cannot be assigned all observed failures.

Existing stats queries now retain at most 128 numeric decoder/jitter/loss snapshots
under the diagnostic flag; no extra steady-state polling or credential/identity
logging is introduced. The last bounded presentation snapshot remains available
after test participant removal, and is never read by authorization logic.

All owned Cloud test rooms were deleted. Recordings and full numeric traces remain
private. Runtime tests: 41 passed. The native diagnostic app built successfully.
Further work isolates generated-track RTP behavior from native clock/receiver
handling using a local browser WebRTC loopback control.

The first browser-loopback attempt lacked both recorded media tracks and was
rejected. The corrected harness waits for connection, unmuted tracks and decoded
video before recording. Its 50-second direct browser WebRTC loopback recorded all
25 numbered pairs with no unmatched/missing markers, but measured 113.5 ms absolute
p95 and failed the sync gate. This supports further investigation of native
presentation rejection/continuity, while neither proving Cloud transport is free
of issues nor qualifying this synthetic source's browser WebRTC path for 80 ms.
The first-frame candidate and numeric receiver diagnostics are saved on the
prototype branch only; production is unchanged.
