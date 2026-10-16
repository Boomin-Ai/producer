# Incoming audio contention comparison

Status: debug-only, not live. Neither comparison passed the full marker gate.

The existing incoming PCM delivery rejects a block when its trylock finds the
OBS render callback holding the queue mutex. The diagnostic candidate lets only
the incoming media worker wait for that lock; render_audio retains trylock and
never blocks. It measures total and maximum worker wait. No release behavior
changes. Indefinite mutex waiting is not considered a qualified production design.

With 32 diagnostic queue blocks: five matched pairs, 106.667 ms p95, nine unmatched
audio markers, nine missing video labels, two uncertain tones. There were 36
incoming contention encounters, maximum wait 0.425 ms, eight full-queue rejections
and one render contention event. The test failed.

With a 48-block diagnostic queue: all 14 recorded markers matched, 43.333 ms p95,
no unmatched/missing markers, but one uncertain audio fragment. The strict overall
gate remained false. All 56 incoming contention encounters waited rather than
being rejected for contention; maximum wait 6.285 ms (8.262 ms total). Full-queue
rejections and render contention were zero. This is a useful single-run result,
not repeatable production qualification or a fix for late native video.

The queue bound increases storage capacity only; sample timestamps and presentation
delays are unchanged. Release builds retain 16 queue blocks and incoming trylock.
The candidate uses 48 blocks only in diagnostic builds. The desktop diagnostic
built successfully with a temporary rlib-only manifest, restored after the build.
All owned Cloud test rooms were deleted; recordings and numeric traces retained.
