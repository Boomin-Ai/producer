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

Waveform follow-up: the ambiguous fragment begins at recorded PTS 25,390 ms.
The 25,400–25,410 ms window is exactly zero PCM, and the 25,460–25,470 ms window
has peak amplitude 2 (16-bit PCM), between substantial tone segments. This is real
recorded fragmentation, not grounds to relax the detector. The point at which
samples become silent remains unproven: decoded PCM, submission scheduling and
mixer consumption need separate observations.

Speed accounting for that individual candidate run: Admit API 1,009 ms,
Admit request start to native thumbnail 4,747 ms, first decoded frame to first
ingest 1,036 ms. The earlier measured baseline was 11,466 ms to thumbnail, so
this individual comparison is approximately 59% shorter (6.7 seconds saved).
These are isolated run observations, not latency percentiles or live guarantees.
Audio/video sync p95 43.333 ms measures alignment, not join speed. Candidate is
not live and has not passed repeatable qualification.
