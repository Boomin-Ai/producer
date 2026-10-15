# Numbered native guest recording proof — October 15

This is an isolated debug test, not a production rollout. It needs no human
camera, microphone, speech or clapping. Browser playback is muted. Native
monitoring is disabled explicitly in the short local bridge control; the Cloud
fixture otherwise retains native guest monitor configuration.

`labs/guest-rtc/web/numbered-guest-input.js` replaces getUserMedia only inside the
owned test browser. It supplies canvas video and a bounded, scheduled PCM buffer.
A shared AudioContext timeline generates a 120 ms white flash every two seconds,
an eight-bit video barcode and a 997 + 128 × (label modulo 16) Hz tone. The source
records canvas observations separately from planned PCM sample positions. Source
paint is frame-quantized; planned samples do not prove downstream delivery.

The diagnostic native app records its actual OBS output to a private fixture
file using the ordinary recording encoders/muxer. The existing
`analyze-numbered-recording.swift` decodes the saved file, matches label identity,
reports unmatched/missing/repeated labels, detects PCM discontinuities and applies
the unchanged five-pair minimum / 80 ms absolute p95 marker gate. A startup
thumbnail or a submitted audio counter alone cannot pass this test.

The first three generated Cloud attempts recorded numbered video but completely
silent PCM. The first also failed the existing green-thumbnail detector because
its generated dark green background was below the detector threshold; the source
was corrected for later runs. Native receive/submission peak diagnostics and
browser outbound energy showed that tones reached the native queue.

A separate seven-second local test, with LiveKit absent, reproduced silent
recording while the custom source rendered 523,614 nonzero channel samples. OBS
was configured for fixed audio buffering (213 ms observed in the log), while the
source used a hardcoded 60 ms render delay. Its timestamps did not match the
mixer's actual window. OBS's pinned implementation excludes source windows outside
the current mix interval:
https://github.com/obsproject/obs-studio/blob/32.1.2/libobs/obs-audio.c

The debug-only correction follows the timestamp of the previous actual OBS mix
block, scheduling the next source render at its end. It adds no arrival-time
substitute for sender audio/video timing. The raw-audio observer copies only its
clock, not audio samples. Debug storage is bounded to 32 queued blocks so it can
retain audio through the observed mixer buffering interval. Release builds retain
the existing code; neither the ACT experiment nor this correction is live.

Ownership: a source owns its allocated state and registers a raw callback with a
borrowed pointer to that state. Destruction disconnects that callback before
freeing state. No callback retains an OBS source reference, and no thread is
created. The short corrected test observed one callback registration and one
unregistration after scene cleanup and the OBS destroy queue drain. It recorded
a nonzero tone (maximum 10 ms RMS approximately 2,999); the same baseline analysis
reported exactly zero. This is a bridge control, not a numbered lip-sync pass.

Remaining release qualification includes recorded Cloud alignment, repeated
initialization/teardown and full reconnect, multiple guests, supported browser
capture metadata negotiation and missing-metadata fallback. No production app,
user scene or production guest configuration was changed by these experiments.

Full Cloud recording with the observed mixer clock: 16 matched pairs, 113.333 ms
median signed video lag, 146.667 ms absolute p95, one unmatched audio marker,
no missing video labels within the observed span and no PCM PTS discontinuities.
The full marker gate failed. A subsequent debug-only async-unbuffered video trial
had 15 matched pairs, 83.333 ms median signed lag, 150 ms absolute p95, one
unmatched audio marker and missing video label 23. It also failed; its video
buffer override was removed. Neither failed run was relabeled as a sync pass.
All owned Cloud rooms were deleted; recordings and detailed numeric traces remain
private. The sanitized evidence is in
`docs/evidence/numbered-native-ingress-2026-10-15.json`.
