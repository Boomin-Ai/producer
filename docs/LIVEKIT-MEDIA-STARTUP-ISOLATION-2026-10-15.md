# Media startup isolation

Status: isolated debug prototypes, not live. End-to-end media delay is not fixed.

## Measured result

A baseline took 5.188 seconds from native Admit start to colored thumbnail. First positive browser outbound-video stats preceded the native decoder callback by 185 ms. Decode to thumbnail took 1.444 seconds; initial audio attachment to its verified SSRC took 1.184 seconds.

Three extra sequential audio startup stats queries, spaced by at least 100 ms of waiting, reduced the observed attach-to-binding interval to 118 ms in one candidate run. A successful binding permanently disables those startup retries for that track. Failure/reproof after an established binding keeps the ordinary cadence. This is bounded startup work, not a faster steady-state stats poll. Existing unique-SSRC, retirement, ownership, permission and timing checks remain.

The latest candidate still took 7.648 seconds overall: 6.261 seconds before positive outbound-video stats, 329 ms from that observation to native decode, and 1.058 seconds from decode to thumbnail. It matched eight numbered AV pairs at 36.667 ms absolute p95, but missed five video markers and failed the full recording gate. There is no demonstrated end-to-end speed improvement yet.

## Initial track clock experiment

Previously any binding change reset both audio and video clocks. Debug flag `PRODUCER_RTC_INITIAL_BINDING_PROOF=1` preserves an existing clock only when every change is the first binding of its owned track, its SSRC is unique, and it is not retired. Binding loss, reproof, replacement or ambiguity still resets everything. The existing transition test now checks that binding loss and replacement can never be classified as first attachment. This candidate alone did not eliminate startup delay and failed the 80 ms recording gate (83.333 ms p95).

Enable bounded startup stats separately with `PRODUCER_RTC_AUDIO_STARTUP_STATS_PROOF=1`. Release behavior retains the original reset and stats cadence.

## Rejected experiments and next measurement

A one-time wakeup on any decoded PCM did not improve initial audio binding and was removed. Starting the existing browser authorization checker while queued removed a separate three-second admission poll, but one local-bundle trial did not establish a speed benefit. That browser experiment was removed, avoiding an unproven increase in queued API traffic. Its authorization/startup and conversation checks passed nine tests, and TypeScript checking passed before removal.

The remaining native delay must be separated into first valid video sender mapping, audio-master readiness and presentation admission. Preservation of the paired clock is a plausible contributor, not a proved explanation for the remaining second. Do not widen clock freshness limits or substitute packet arrival time for sender timing to obtain a faster number. Sender readiness and API timing also remain variable.

## Validation and artifacts

43 runtime tests passed on the final candidate, including binding loss/reproof and replacement transitions. The final diagnostic desktop binary built as an ARM64 Mach-O executable; recording ran with successful browser/native exits. During an earlier full-disk build, the linker left an invalid artifact despite Cargo returning success; that artifact was rejected and was never executed successfully. Space was recovered from verified, losslessly compressed diagnostic recordings, regenerable test build files, and Chrome HTTP disk cache. Cookies, browser sessions, user recordings and the production app were untouched.

All owned temporary rooms were deleted. Detailed sanitized trial data is in `evidence/media-startup-isolation-2026-10-15.json`. Private recordings remain compressed outside the repository. Sender timestamps are 100 ms sampled observations; decoder/submission/thumbnail times come from their actual callbacks. No deployment or signing of a production release occurred.
