# Audio gap localization

Status: diagnostic only, not live. Strict marker gates unchanged.

The initial trace retained eight seconds after the first substantial decoded
signal. It captured 800 decoded blocks and 800 accepted submissions with no
bracketed decoded silence or scheduling discontinuity, but the first ambiguous
recorded fragment occurred just outside that window. Its failed result remains
private and was not treated as localization of later gaps.

The bounded trace was extended to 16 seconds / 4,096 rows. It retains only
sequence, timing, peak, nonzero count and submission acceptance; no raw PCM,
identities or credentials. A new test covers initial silence, time/count bounds
and rejection retention. Runtime suite: 42 pass.

The repeat traced 1,600 decoded blocks and 1,599 submissions. Two rejected blocks
were silent, after the first affected tone. Decoded sequences 702–714 and
1502–1514 cover the tones corresponding to ambiguous recorded fragments near
33,140 and 41,140 ms. Both examples had substantial decoded signal throughout,
every block accepted and exact 10,000 us submission increments. The recording
still split these tones. Therefore these particular gaps occur downstream of
native submission, not because the source PCM was silent or the tone submissions
were rejected. This does not distinguish OBS source render consumption, mixer
processing or encoder/muxer behavior yet.

Recorded repeat: 13 matched pairs, 26.667 ms absolute p95, three uncertain tones;
strict overall gate failed. Pull counters: two full-queue events, two render
contentions, maximum incoming worker wait 0.717 ms. These remain real limitations.
All temporary Cloud rooms removed. Private recordings and numeric traces retained.
Next diagnostic targets actual OBS render timestamps and consumed sample ranges.
