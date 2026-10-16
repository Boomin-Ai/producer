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

## Source and handoff controls

A direct browser recording of the generated source passed: seven matched pairs,
28.367 ms absolute p95, no unmatched or missing labels. The existing generated
MOV independently measured 64 pairs with effectively zero offset.

Debug-only bounded marker tracing now records accepted audio/video submissions
and their scheduled Instants immediately before the OBS handoff. Partial audio
onsets are retried until their tone identity is confident; three new tests cover
partial onset, barcode/tone identity and bounded trace storage (41 runtime tests
pass). The first trace had a detector onset defect and remains invalid evidence.
The corrected repeat contained 14 audio and 11 video events, no trace overflow.
Several submission pairs were within 13 ms, while their recorded video lag was
107–233 ms; one recorded pair reached 533 ms. Other handoff pairs themselves
had 39–69 ms offsets. This establishes substantial additional delay after
handoff without establishing that every input pair was aligned. The recording
failed synchronization and coverage qualification.

An ordinary local OBS Media source, with no LiveKit or custom guest source,
recorded the known synchronized MOV through the ordinary Recorder. All seven
labels matched, but video lag measured 83.333–116.667 ms (p95 116.667 ms).
Therefore a shared playback/recording-path offset contributes to these results;
the guest source cannot yet be assigned the entire measured offset. Detailed
recordings and traces remain private. Production behavior remains unchanged.

A debug-only regular-MP4 control, changing only the Recorder muxer option,
measured seven matched pairs at 26.667 ms absolute p95 and passed the marker
gate, with no unmatched/missing labels or PCM PTS discontinuities. Fragmented
MP4 timestamp handling is a confirmed contributor in this local control.
Cloud guest confirmation remains required; no production muxer setting changed.

The full Cloud repeat with regular MP4 failed: nine matched pairs, 536.667 ms
absolute p95, six unmatched audio markers and missing video labels 13–18.
Accepted handoff offsets ranged from -18 to +87 ms; video submission lateness
was below 3 ms for observed markers. OBS reported one rendering-lag frame.
Regular MP4 alone is not a guest sync fix. A bounded latest-video diagnostic
is being compared under the same regular-MP4 condition; it remains debug-only.

The latest-video + regular-MP4 Cloud retry measured nine matched pairs at 40 ms
absolute p95. It still had six unmatched audio markers and missing video labels
13–18, so the full gate failed. The browser source trace painted all of those
labels, while accepted native submission omitted them. This narrows the missing
interval to between generated source painting and native submission; it does not
identify whether transport, decode metadata or presentation rejection caused it.
The preceding attempt timed out during host setup and provides no media result.
All temporary rooms were removed.

A local fragmented-MP4 control with `negative_cts_offsets` measured seven pairs,
26.667 ms absolute p95, no unmatched/missing labels or PCM PTS discontinuities,
and passed. This is a promising container correction that preserves fragmentation,
not a released change or a full guest qualification. FFmpeg documents signed CTS
offsets as permitting initial DTS/CTS zero and reducing edit-list requirements
for reordered video: https://www.ffmpeg.org/ffmpeg-formats.html

Debug proof diagnostics now include bounded, once-per-second presentation and
capture-clock snapshots (up to 25 guests, no identities/media/secrets) to identify
why source-painted labels fail to reach native submission. Runtime tests: 41 pass.

The full Cloud signed-CTS + latest-video run matched 15 consecutive video labels
6–20 at 63.333 ms absolute p95. No labels were missing within the observed video
span and PCM PTS was continuous. Audio label 5 preceded the first video marker,
so there was one unmatched audio marker and the strict overall gate remains
false. This is evidence of promising paired synchronization, not full startup
coverage or a released fix. During the active run, clock diagnostics showed only
initial binding/no-audio-origin transitions; the earlier missing interval did not
recur. The final snapshot clears when the participant is removed, so it cannot
be used as retained post-removal clock history. Further qualification must include
startup and repeatability. This run preserves fragmented MP4 rather than adopting
the ordinary-MP4 diagnostic for production.

Checkpoint: all Cloud test rooms deleted; private recordings retained. The native
build and 41 runtime tests passed. The diagnostic build initially ran out of disk
space; deleting 513 MiB of regenerable files from the dedicated build cache allowed
the rebuild to finish. User recordings and application data were preserved.
