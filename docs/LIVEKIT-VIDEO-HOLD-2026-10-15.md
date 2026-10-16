# Native video hold and numbered-media repeat — October 15

Status: isolated debug candidate, not live. The 80 ms p95 / five-pair minimum,
marker coverage and uncertain-tone gates are unchanged.

Decoded-marker traces identify two distinct cases. In one run, matching video
arrived 160–180 ms before audio, while sender origins agreed within about one
frame. Adding the existing 120 ms audio presentation delay put video about 300 ms
ahead of its deadline. The native 250 ms/8-frame hold rejected these valid early
frames. A debug flag now connects the existing tested 400 ms/14-frame hold to the
native receiver. Late deadlines, origin-age bounds and permissions remain intact.
The wider bound is a storage limit, not a fixed added delay.

The first wider-hold recording matched all 13 labels at 53.333 ms p95, with no
unmatched/missing markers, but three ambiguous 10 ms audio fragments failed the
strict gate. The fragments followed complete matched tones. This was not called
a passing result.

Audio diagnostic counting previously performed an atomic increment for each
nonzero sample while holding the source mutex. It now accumulates locally and
adds once after unlocking. Debug counters distinguish incoming try-lock failure,
render try-lock failure and a full queue. No release audio algorithm changes.

The next recording passed the full numbered marker gate: 14 pairs, 36.667 ms p95,
no uncertain, unmatched or missing markers, and continuous PCM PTS. Its source
queue never filled; render contention was zero. Incoming audio try-lock contention
rejected 38 blocks and remains a known limitation despite that recording's pass.

An unchanged repeat failed: only four matched pairs. Decoded video markers were
214–1,239 ms later than matching audio, while their sender origins still agreed
within approximately 20 ms. The receiver correctly rejected stale frames. The
wider early-video hold cannot fix genuinely late decoded video. This failure is
retained separately and the single pass is not treated as repeatable qualification.

Next isolated comparison uses the SDK's existing zero-video-playout-delay API,
called before its shared runtime initializes. This is a diagnostic flag, not a
production setting or a claim that jitter/loss resilience is qualified.

Runtime tests: 41 passed. Diagnostic app built with only the rlib crate type to
avoid generating unused static/mobile libraries on a nearly full disk. The
manifest was restored after each build; release packaging is unchanged. Older
private test MP4s were gzip compressed and SHA-256 checked against their originals
before removal of uncompressed copies, saving 723 MiB without deleting evidence.

The zero-video-playout-delay comparison completed with 14 consecutive matched
video labels, 86.667 ms absolute p95, one unmatched audio marker and three
uncertain tones. It failed. Pull diagnostics: 44 incoming lock-contention rejects,
five full-queue rejects and no render lock contention. This is not a release fix.
All owned Cloud rooms were removed. Full private recordings/traces were retained.
The remaining problem includes genuinely late decoded video as well as lossy
incoming audio submission; repeated qualification has not passed.
