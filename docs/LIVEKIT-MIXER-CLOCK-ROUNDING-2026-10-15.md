# Mixer clock rounding and audio gaps

Status: built and measured in the isolated diagnostic app, not live. Full guest
qualification still fails on video coverage; this is not a full guest fix.

The raw final-mix callback now stores at most 1,600 numeric 10 ms peak/nonzero
summaries after first signal. No raw PCM is retained or allocated on that callback.
Its borrowed source state is disconnected before destruction; diagnostic source
cleanup waits for the OBS destroy queue. Render diagnostics measure repeated,
backward and skipped timestamps, plus samples with/without queued PCM.

The floor-rounding run had no render clock repeats/backward/skipped windows,
maximum 1 ns timing error, no full queues or render contention. Nevertheless,
13 short zero-signal intervals interrupted substantial tones in the final mix,
before AAC encoding. The saved recording's marker gate passed at 46.667 ms p95;
this demonstrates that marker alignment alone does not prove gap-free audio.

Pinned OBS 32.1.2 mix_audio returns without mixing a custom source if its timestamp
is less than the current mix start, even by 1 ns:
https://github.com/obsproject/obs-studio/blob/32.1.2/libobs/obs-audio.c

The diagnostic next-mixer-window prediction added floor(frames * 1e9 / 48000).
Accumulated 1,024-frame windows alternate fractional nanoseconds, so that
prediction can be 1 ns early. An arithmetic check across 100,000 windows found
33,333 early floor predictions. Ceil duration never predicts early and is at most
1 ns ahead, which converts to zero whole samples at this rate.

The corrected diagnostic prediction uses ceiling division. Its hosted trial had
zero bracketed short gaps across 1,600 mixed-output windows and zero uncertain
recorded tones. There were no full-queue rejects; two render contention events
remain observable. The recording matched 13 pairs at 60 ms absolute p95, but
had two unmatched audio markers and missing video label 11. The strict overall
gate failed. Video lateness/coverage remains separate and unresolved.

This is single-run before/after evidence for the audio rounding correction, not
repeatability or release qualification. Release source clock behavior is unchanged.
All temporary Cloud rooms were deleted and detailed recordings retained privately.
