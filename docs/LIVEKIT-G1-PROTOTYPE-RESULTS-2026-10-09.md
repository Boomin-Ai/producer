# Native guest prototype results — October 9, 2026

Verdict: native LiveKit transport and software APM execute on Apple Silicon; G0/G1 remains incomplete. Keep broader room integration gated. No production deployment or product transport switch was performed. This is a runnable experiment with recorded evidence, not release acceptance.

The isolated Producer worktree is `/Users/klevelandbishop/Documents/producer-livekit-g1`, branch `prototype/livekit-g1-2026-10-09`, based on `5723335221dfe812cac851e57f610227b16d8c35`. The release/recovery source worktrees and installed Producer app were not replaced. The experiment lives in [labs/guest-rtc](../labs/guest-rtc/README.md).

Later checkpoints below supersede the initial implementation details and timing observations.

## Initial measured results

| Proof | Result | Evidence and limit |
|---|---|---|
| Existing guest return/reconnect checks | 11 passed | [Baseline](../labs/guest-rtc/evidence/baseline.json); mocked lifecycle regressions, not WAN/physical call quality |
| Existing real OBS audio buses | Passed guest exclusion, admission silence, mute, native gain | [OBS evidence](../labs/guest-rtc/evidence/legacy-obs-audio.json); existing debug executable and installed plugins, with audible monitoring disabled; not the new RTC adapter |
| One browser guest ↔ native host | Audio/video passed both directions | [Native receive](../labs/guest-rtc/evidence/transport-1-normal.json), [browser return](../labs/guest-rtc/evidence/transport-1-normal-browser.json) |
| Three browser guests with 200 ms consumer stalls | Audio/video continued; queues stayed bounded | [25 s pressure run](../labs/guest-rtc/evidence/transport-3-pressure.json), [120 s run](../labs/guest-rtc/evidence/transport-3-pressure-120s.json); overflow drops are explicit, not lossless playback |
| Guest disconnect/rejoin | Passed with stable identity and changed publication SIDs | [Rejoin evidence](../labs/guest-rtc/evidence/transport-3-republish.json); retired sinks/queues recorded; not ICE restart, server failover or host reclaim |
| Packaged Apple Silicon WSS | Connected and passed bidirectional transport | [WSS evidence](../labs/guest-rtc/evidence/transport-packaged-wss.json), [TLS validation](../labs/guest-rtc/evidence/tls-validation.json); ad hoc hardened CLI bundle, process-local test CA, certificate validation enabled |
| APM disabled/enabled against identical PCM | Enabled AEC reduces far-only synthetic echo by median 55.94 dB, p10 52.23 dB | [Noise fixture](../labs/guest-rtc/evidence/apm/apm-fixture.json), [speech fixture](../labs/guest-rtc/evidence/apm-speech/apm-fixture.json); final physical speaker-reference wiring unproven |
| Prototype correctness checks | 4 Rust tests and Clippy passed | Bad PCM rejection, queue stall recovery, nonblocking callback contention and separated-marker matching |

The 120-second, three-guest pressure run delivered roughly 11,300–11,400 audio blocks per guest, with audio handoff p95 5.39–5.46 ms and video handoff p95 9.75–10.01 ms. Each guest deliberately lost 414 oldest audio blocks during 23 receiver pauses. Queues hold three 10 ms audio blocks and two video frames; stale-age budgets are 30 ms audio and 50 ms video. Those bounds apply to the application's decoded callback handoff, not every encoder, network or jitter buffer inside the SDK.

At this initial checkpoint, callback flash/click absolute p95 offsets were 32–43 ms in that longer run, but 73–87 ms in an earlier shorter pressure run. Both are retained. The browser paints the flash on its next timer interval, adding up to approximately 33 ms source uncertainty. Raw audio does not provide original capture timestamps, video NTP metadata was zero, and no LiveKit ingest was recorded through OBS. These measurements cannot qualify lip-sync, capture-to-playout latency or long-term drift. Missing/dropped markers must also be considered; a percentile over detected pairs is not a loss metric.

The double-talk waveform check does not qualify intelligibility. With synthesized near speech, enabled AEC's aligned projection gain was 0.352 and correlation 0.463; output/reference RMS ratio was 0.759. Projection gain is not perceived volume. The shaped-noise near signal was suppressed much more strongly. This is evidence that the APM executes and changes samples, plus a reason to test speech carefully; it does not establish that a speakerphone user preserves every word or passes the recognition gate. Processing cost in the speech run was p95 145 µs per 10 ms block, measured offline rather than in a device callback.

## Implementation and ownership

LiveKit Rust 0.9.4, JS 2.22.4, SFU 1.13.9 and explicit `rustls-tls-native-roots` are pinned in the lab. [Build manifest](../labs/guest-rtc/evidence/build-manifest.json) records the lockfiles, resolved libwebrtc/webrtc-sys graph and native archive checksum. A small [vendor patch](../labs/guest-rtc/vendor/README.md) exposes existing native track handles and owned video conversion for custom callback sinks; it does not change the codecs or add audio timestamp semantics. Product adoption should use an upstream supported hook.

The native callback stamps local decoded-delivery time before queueing. It counts sample discontinuities and evicts old backlog. Sinks detach through RAII. Native publication uses exact 10 ms frames with its source queue disabled; teardown aborts the publisher and clears that source. A late unsubscribe only retires its matching publication SID, preserving a replacement track. The initial callback allocated an audio Vec; later checkpoints replace it with fixed arrays and separate ingest. Full real-time suitability remains unqualified.

The lab owns synthetic media and a manual APM instance. It deliberately has no hardware capture/playback owner. The proposed production owner remains a single native audio pipeline that captures the microphone, schedules speaker output, supplies the exact final speaker PCM to APM, then routes processed microphone audio. OBS's audience/stage-return bus is not the AEC reference. Enabling PlatformAudio alongside an independent device owner would require a separate ownership design and is not implemented here.

The fixture's browsers subscribe only to the native host, with return-video muted and return-audio decoded at zero output volume. This does not freeze the final guest subscription mode. Direct conversation audio/video with an optional composed program monitor remains a product candidate requiring latency and synchronization measurements. Self-exclusion, private cue, authoritative admission/grants and host reclaim are not implemented by this lab.

## Baseline source drift

Read-only remote-head checks found Producer and web main match their pinned local source heads. API main is `0961234ef1df03ba3420171027d677ff03511379`, while the existing dirty local API worktree remains at `07991fea`. Its source was not checked out/reset. Later API main already includes:

- Cloudflare TURN credential minting/fallback in `src/services/live/guest-ice.ts`.
- `RoomMutations` serialization of link/stage/admit/accept/revoke/join/monitor operations, landed in `848d928`.
- Atomic nested grant-key updates using `jsonb_set` in `participant-grants.ts`.

These improve the older review baseline. They do not by themselves prove the reviewed full admission/grant/token/expiry/reclaim policy revision and durable outbox contract. G2 should audit the current authority rather than recreate the older implementation.

Cloudflare deployment metadata was read without deploying: API version `803dcc2e-aeb9-4fbb-9b13-2c04192a904a` at 100%, created October 2 at 12:36 UTC. There is no source commit annotation, so this report does not equate remote main with deployed code. TURN binding-name presence is recorded in [baseline evidence](../labs/guest-rtc/evidence/baseline.json); relay behavior was not functionally tested. G0 needs the source-to-deployment mapping and one/three-guest physical legacy baselines before it can close.

## Required next proofs

1. Establish a supported common audio/video presentation timeline through OBS, with original timing semantics, transport-generation resets and marker recordings under asymmetric jitter, scheduler pressure, packet loss/reconnect and extended drift. See [the narrow timing extension investigation](LIVEKIT-G1-AUDIO-TIMING-EXTENSION.md).
2. Wire one actual capture/playback owner and feed APM final speaker PCM. Record enabled/disabled far-only and human double-talk runs; measure word preservation, actual device latency and reference underflow. The offline fixtures cannot pass the physical gate.
3. Execute the same SDK/APM/WSS and restart-cleanup checks in packaged Windows and the actual Tauri/OBS integration. The signed macOS CLI bundle is only a packaging foothold; it has no Developer ID/notarization or release qualification.
4. Freeze guest viewing/subscriptions using measured conversation and composed-preview synchronization. Finish G0 deployment mapping and physical legacy baselines. Only then expand into G2 admission/authorization/private-cue integration.

For the next review, inspect the native callback/queue lifetime, SID replacement behavior, TLS fixture, APM measurement definitions and baseline drift. Treat the recorded pass results narrowly and leave G0/G1 incomplete until the physical/timing requirements are demonstrated. The [original review](LIVEKIT-GUEST-REFACTOR-REVIEW-2026-10-09.md) remains unchanged.

## Packet impairment checkpoint

A verified UDP relay and all-RTP hard-loss control now exercise actual media
impairment. Recorded A/V offset fails the 80 ms gate: 134.02 ms p95 with video-only
jitter and 121.31 ms with audio-only jitter. Repeated rejoin results also vary beyond
the target. Complete per-generation application audio accounting and worker retirement
pass; they do not qualify timing, physical AEC or SDK-wide cleanup. See the
[latest timing evidence](LIVEKIT-G1-AUDIO-TIMING-EXTENSION.md#verified-packet-impairment-and-complete-ingest-accounting)
and [required per-frame playout bridge](LIVEKIT-G1-PLAYOUT-BRIDGE-SPEC.md).
Production remains unchanged, and G0/G1 are incomplete.

## Decoded mixer timing checkpoint

A public custom AudioMixer dependency now exposes decoded RTP/elapsed metadata
without rebuilding the pinned WebRTC archive. Native ownership tests passed
100 cycles; real three-guest rejoin tests destroyed every wrapper. A 90-second
probe and an explicit RRTR feedback experiment both retained invalid frame NTP
estimates. A video-jitter run matched the source SSRC to its guest publication
and confirmed sender reports arrive. The common clock remains unqualified, and
no timing from this probe feeds OBS yet. See the
[updated timing investigation](LIVEKIT-G1-PLAYOUT-BRIDGE-SPEC.md#public-mixer-extension-investigation).

## RTCP exchange checkpoint

Native authenticated RTCP observation confirms the RRTR experiment actually emits
requests: six in the one-guest run and 19 with repeated three-guest rejoin. Neither
run received a DLRR reply. Pinned SFU/Pion sources expose an SSRC routing mismatch
consistent with that observation; a patched server has not been tested. Incoming
sender reports provide RTP/NTP pairs for all six current guest media publications,
offering a public mapping path to test independently of the missing frame estimator.
No map feeds OBS yet and G1 remains incomplete. The
[exchange proof and next mapping requirements](LIVEKIT-G1-PLAYOUT-BRIDGE-SPEC.md#authenticated-rtcp-exchange-proof)
include bounded histories and owner-lifetime limits.

A guarded Rust sender-origin mapper now reconstructs timing from those reports.
A 45-second three-guest/rejoin diagnostic, without RRTR enabled, produced maps for
all six current media publications and origins for all three decoded audio sources.
The original frame NTP estimator stayed invalid. This is end-of-run metadata
reconstruction; per-frame PCM handoff and common OBS scheduling remain unimplemented.
The [live verification](../labs/guest-rtc/evidence/sender-clock-live-verification.json)
and mapper tests preserve that distinction.

### Paired decoded PCM checkpoint

The prototype now hands decoded mono/stereo PCM and source RTP metadata together
from the native mixer into a bounded Rust observation path. Three-guest rejoin
and measured audio-jitter runs produced more than 13,000 mapped blocks online,
with no clock resets or format rejections in the corrected runs. Native lifecycle
checks cover overflow, stale blocks, contention, retirement flush and PCM
accounting. All 12 Rust tests and lint checks pass.

A follow-up jitter run found that consecutive 10 ms PCM blocks can have mapped
RTP-origin steps from 0 to 27.5 ms. Receiver statistics also report concealment and
inserted/removed samples. Consequently, per-block mapped RTP origin cannot simply
be used as the PCM presentation timestamp. A continuous audio sample timeline and
its relation to sender time must drive video scheduling. The two-report mapper
also took about 6–8 seconds of decoded output to become usable in that run, leaving
a startup-policy constraint to resolve.

This advances the metadata bridge; OBS still consumes the previous audio path.
Recorded synchronization, physical speakerphone AEC, platform integration and
production rollout remain unqualified. See
[the paired PCM investigation](LIVEKIT-G1-PLAYOUT-BRIDGE-SPEC.md) and
[the saved handoff verifier](../labs/guest-rtc/evidence/decoded-pcm-verification.json).

### Continuous audio-master playback and raw OBS probes — October 10

OBS now consumes the paired native PCM path in the opt-in audio-master lab. The
old callback audio writer is disabled in that mode. Current guest-1 publication
IDs are bound to receiver SSRCs; replacement clears both application presentation
queues. PCM sequence numbers advance even when native observation contention drops
a block, preserving gaps rather than compressing the sample timeline.

The audio clock advances continuously in 10 ms blocks. Sender-report origins label
that position for video mapping; irregular origin steps do not replace the sample
clock. Startup requires fresh two-report audio/video maps and still costs roughly
6–8 seconds in these fixtures. Audio and video queues are bounded, drop late data,
and account for their shutdown flush. This is actual native PCM-to-OBS ingestion,
but it is not a qualified common presentation clock.

| Recording configuration | Absolute A/V p95 | Marker pairs | Local 80 ms gate |
| --- | ---: | ---: | --- |
| Direct audio-master baseline | 38.02 ms | 12 | Pass |
| Direct video jitter | 194.02 ms | 13 | Fail |
| Direct audio jitter | 104.65 ms | 11 | Fail; unmatched audio |
| Scheduled video jitter | 139.35 ms | 10 | Fail; unmatched markers |
| Scheduled audio jitter | 92.69 ms | 11 | Fail |
| Scheduled traced video jitter | 109.35 ms | 9 | Fail |
| Scheduled traced baseline | 97.35 ms | 10 | Fail |
| Raw-video-probed baseline | 76.69 ms | 7 | Fail; unmatched audio |
| Raw-audio/video-probed baseline | 78.69 ms | 10 | Pass |
| Raw-audio/video-probed video jitter | 94.02 ms | 11 | Fail |

A local pass is not G1 completion. These sequential runs vary with receiver
conditions and machine load; the first scheduled video-jitter run also overlapped
build/lint activity. They cannot establish an instrumentation performance penalty.
No current-clock repeated-rejoin recording or physical speakerphone test is qualified.

Input marker traces record the exact OBS target timestamp. Optional raw OBS mix
callbacks independently record marker PTS before encoding. In the complete
raw-audio/video runs, decoded recordings add about 38–53 ms to the raw mix's
video-minus-audio offset. The baseline raw video output differs from its input
marker targets by about −3 to +32 ms; the larger final recording offset therefore
cannot all be assigned to the sender mapper. Encoder/muxer timestamp handling,
codec priming, and independent decoding still need investigation. No fixed delay
has been applied to hide this offset.

Raw probes have one boxed recorder owner, non-owning callback pointers, bounded
64-marker arrays, try-lock callbacks and explicit unregister before destruction.
Four same-process cycles cover successful finish and active-output cancellation.
An additional injected failure after callback registration checks partial
initialization cleanup. Both raw callbacks become quiescent after unregister;
all five observers are destroyed, with stable post-warmup 11 threads and 14 file
descriptors. Native PCM
lifecycle checks also pass after the sequence correction. Fifteen Rust tests,
default/OBS Clippy, and the recorded evidence accounting verifier passed for
this checkpoint.

Evidence: [all recording and queue checks](../labs/guest-rtc/evidence/audio-master-verification.json),
[raw media callback lifecycle](../labs/guest-rtc/evidence/obs-media-pipeline-lifecycle.json),
[latest jitter recording](../labs/guest-rtc/evidence/obs-audio-master-media-pipeline-video-jitter-markers.json).
The first two direct-mode evidence files retain an obsolete `obs_connected:false`
descriptor from their binary; their `audio_master_playback` counters identify the
actual paired-PCM ingestion. Later runs correct that descriptor. Original evidence
is preserved rather than rewritten.

Next: measure encoder packet timestamps and compare another decoding path, then
repeat asymmetric jitter and rejoin qualification after any clock correction.
Speaker-reference AEC, permission/admission concurrency, cue routing, Windows
packaging and production integration remain gated. No production/provider change
was made by this checkpoint.

### Pre-mux and independent-decoder checkpoint — October 10

The recorder now observes bounded timestamp metadata immediately before OBS forwards
encoded packets to its muxer. Audio/video packets share a common monotonic origin
within 0.01 ms in the complete runs. A compressed-sample inspector and an independent
FFmpeg 7.1.1 audio decoder separate this timeline from AVFoundation decoding.

The complete fragmented baseline exposes a decoder discrepancy: video markers in
the MP4 are shifted +21.35 ms from their raw mix timestamps, while AVFoundation's
PCM markers appear about 17–30 ms earlier. FFmpeg places audio markers roughly
35–52 ms later than AVFoundation in the same file. That changes the baseline's
local marker result from 94.02 ms to 50.69 ms p95. This does not erase the original
Apple playback observation; both decoders' results and the recording hash are retained.

A fresh, valid video-jitter run still fails: 138.69 ms using AVFoundation audio,
85.35 ms using independently decoded audio. All nine markers match in that run.
The historical scheduled video-jitter recording also still fails with independent
audio at 95.35 ms and unmatched markers. The direct-clock implementations retain
large failures. Several other scheduled recordings pass with independent audio.
Thus the earlier results combined a real scheduling problem with decoder/container
behavior; changing the decoder does not complete G1.

An opt-in finalized MP4 comparison uses `movflags=faststart`. Audio decoders then
agree within about 0–7 ms, and video no longer has the +21.35 ms container shift.
This is evidence that the fragmented container/priming path contributes to the
cross-decoder discrepancy. AAC priming reports 1,024 samples. The finalized baseline
has matched-pair p95 of 28.67 ms (AVFoundation) / 23.33 ms (independent audio), but
misses five video markers and therefore fails the full local gate. The application
rejects those early video deadlines; they are not decoder-only missing samples.
A production fix must preserve crash recovery and explain container priming across
players; finalized MP4 is a diagnostic comparison, not a proposed replacement policy.

The recorder owns all three callback pointers through one boxed observer. Packet
storage is capped at 8,192 timestamp records, with no encoded payload copies or
callback allocation. Four success/cancellation cycles plus an injected failure
following packet registration destroy all five observers; post-warmup thread/FD
counts remain bounded (12 / 14 in this workload). Fifteen OBS-feature Rust
tests, default/OBS Clippy, strict C compilation, and all three saved timing
verifiers pass; synchronization failures remain represented in their reports. Querying priming after stop crashed
the first diagnostic workload; the corrected code captures it while the encoder is
active and passes repeated teardown. Production code was not changed.

Low disk space invalidated one jitter attempt and truncated an initial link artifact;
those attempts are excluded from successful timing evidence. Inactive lab logs were
compressed and stale compiled debug binaries removed. A linker-only debug stripping
option avoids another large temporary binary. The upstream cached native archive
remains intact; the attempted stripped copy failed and was removed.

Evidence: [decoder comparison](../labs/guest-rtc/evidence/decoder-comparison.json),
[packet/container verification](../labs/guest-rtc/evidence/packet-timing-verification.json),
[three-callback lifecycle](../labs/guest-rtc/evidence/obs-packet-pipeline-lifecycle.json).
Remaining gates: stable video deadlines without missing markers, startup/report
warmup, current-clock reconnect qualification, physical speakerphone AEC, admission
concurrency, cue routing and platform packaging. G1 remains incomplete.

A 45-second finalized-format test with three guests and three guest-1 rejoins now
verifies observable queue retirement but fails synchronization: matched-pair
p95 is 88.67 ms (AVFoundation) / 97.33 ms (independent audio), with one unmatched
audio marker. Six native source generations are destroyed, both application queues
are empty after teardown, and queue counts reconcile. The audio-master records
14 resets and 2,436 startup-dropped 10 ms blocks; report warmup across reconnects
interrupts the output. Nineteen late audio blocks and four late video frames remain
visible. None of these reconnect results qualify G1.

Next implementation work is stable presentation origin/deadline handling across
startup and publication replacement, with rejection reasons and measured warmup.
A fixed recording offset would not address these failures. Physical speakerphone
AEC and production integration remain separate gates.


### Deadline rejection trace checkpoint — October 10

The lab now counts explicit video rejection and audio reset reasons and retains
at most 64 diagnostic transitions with sender origins, deadline lead/late time,
and observation age. Repeated adjacent reasons are coalesced; totals cover the
whole run, while the bounded trace may omit earlier transitions. Startup-drop
accounting also includes resets that cannot immediately acquire a fresh origin.
The clock limits and two-report startup policy are unchanged.

Three new finalized-format recordings separate startup/report waiting from
presentation failures. Independent FFmpeg audio plus AVFoundation video yields:

| Run | Matched-pair absolute p95 | Missing audio/video markers | Clock reasons |
| --- | --- | --- | --- |
| 30-second baseline | 55.33 ms | 0 / 0 | 547 startup blocks; 142 video frames without audio origin |
| 45-second, three guests, three rejoins | 48.67 ms | 0 / 0 | 2,228 startup blocks; 606 video frames without audio origin |
| 30-second video jitter | 60.00 ms | 3 / 0 | 745 startup blocks; 196 frames without origin, 91 overly early deadlines, seven late deadlines |

Baseline and rejoin matched-marker tests pass locally, but they do not qualify
startup/recovery: rejoin still suppresses 22.28 seconds of observed PCM across the
initial startup and publication replacements. All 14 resets in this rejoin run
were explicit publication binding clears; no audio clock drift/reset was observed.
The previously failed rejoin run remains in the evidence. Run-to-run variability
is unresolved; this is diagnosis, not proof of a synchronization fix.

Jitter fails because three audio markers have no corresponding video. The trace
shows a late group followed by video deadlines more than 250 ms ahead; the last
reported early deadline leads arrival by 251.45 ms with sender video origin
136.87 ms ahead of the current audio origin. Changing caps would hide the failure.
The next clock experiment must address how sender origin labels relate to the
continuous decoded-audio sample clock, and measure the transition to fresh maps
without reusing another publication's clock. A nominal-rate first-report bootstrap
is a possible lab experiment, not an approved replacement for qualified mapping.

The baseline decoder analysis finished during the opening portion of the rejoin
run; treat its latency figures as diagnostic, not a clean performance benchmark.
No build/tests ran during recording. The jitter trace reports rendering stalls;
physical speakerphone AEC, packaging and broader integration remain unqualified.

Validation: 16 Rust tests; default and OBS-feature Clippy with warnings denied;
17 recording/queue accounting checks; seven pre-mux clock traces; independent
decoder comparison; formatting and diff checks. All callback/source retirement
and bounded queue accounting checks pass. A low-disk build failure was corrected
by removing inactive compiled caches. User sets/media/recordings and installed
production were left intact. G1 remains incomplete; production is unchanged.


### First-report startup experiment — October 10

Added `LIVEKIT_LAB_FIRST_REPORT_BOOTSTRAP=1` as a lab-only opt-in. The first fresh
sender report maps RTP using the fixture's explicit nominal clock rate, bounded
to five seconds of report age/extrapolation. It switches to the measured slope
when a plausible second report arrives. Any detected discontinuity requires a
fresh pair; bootstrap cannot hide it. Current SSRC/publication/generation guards
remain intact, no old-publication or arrival-time origin is substituted, and the
default two-report policy is unchanged. Separate counters show actual bootstrap
use; existing decoded-origin diagnostics still describe two-report mapping.

| Test | Prior startup-dropped PCM | Bootstrap startup-dropped PCM | Bootstrap matched p95 | Missing audio/video |
| --- | --- | --- | --- | --- |
| Three guests, three rejoins, 45 seconds | 22.28 seconds | 12.49 seconds | 42.00 ms | 7 / 0 |
| One guest, video jitter, 30 seconds | 7.45 seconds | 2.96 seconds | 54.67 ms | 0 / 0 |

These are separate sequential workloads, not controlled proof of causality. The
rejoin experiment improves observed startup suppression by 44% but **fails** the
marker gate. It has 353 overly early video deadlines, 365 frames without an audio
origin, 14 explicit binding clears, 62 late audio blocks and five late video frames.
Its 898 bootstrap audio blocks and 295 bootstrap video frames prove the experimental
path was exercised. All source/callback retirement and queue counts reconcile.
The jitter run uses 305 bootstrap audio blocks and 80 video frames; it has two late
video deadlines, 81 frames without an origin and no overly early deadline rejections.
Its local marker gate passes, without qualifying recovery or G1.

The experiment remains off by default. Next: trace first-report-to-measured-map
transitions separately for each replacement publication and the audio origin label
versus continuous PCM sample clock. Resolve early deadlines without relaxing bounds
or concealing missing markers. Physical speakerphone AEC remains outstanding.

Validation: 17 Rust tests including RTP wrap, bootstrap freshness/extrapolation,
opt-in behavior, and refusal after discontinuity; default/OBS-feature Clippy with
warnings denied; 19 recorded-run retirement/accounting checks; nine pre-mux traces;
independent decoder comparisons; formatting/diff checks. All pass while preserving
failed timing gates. A low-disk link failure was resolved by removing six older
compiled build-script caches; production and user data were unchanged.


### Audio origin drift and bounded composition-buffer experiment — October 10

A bounded (192-point) numeric trace now measures the difference between sender
origin progression and the continuous PCM sample clock. In the 45-second label
rejoin run, generation five takes a 130 ms label step before receiving the second
report and accumulates approximately −200 ms. The bootstrap-to-measured-rate
transition adds only −2.871 ms. Its last active guest has mean native audio jitter
buffer residence of 177.46 ms versus video 43.64 ms (cumulative delay / emitted
count). These are observations supporting receive-side timeline/buffering
investigation, not proof of the underlying NetEQ/SFU cause. The trace resets at
publication changes/generations, but currently does not segment presentation
reanchors within one generation; do not interpret its largest drift in such runs
as pure decoder delay. The run misses five video matches; p95 of surviving pairs
is 75.33 ms. High CPU load was also reported by the local SFU during this workload.

Added a separate opt-in `LIVEKIT_LAB_EXTENDED_VIDEO_BUFFER=1`: 400 ms maximum video
lead and 14 scheduled frames for the fixed 30 fps fixture, versus default 250 ms
and eight frames. The callback ingress remains separately bounded. This retains
valid early video when audio buffering has grown, at a composition-latency cost.
Audio delay remains 120 ms and marker acceptance remains 80 ms; neither default
nor production behavior changes. Reports expose actual mean/max accepted lead.

| 45-second / three guests / three rejoins | Buffer | Matched independent p95 | Unmatched audio/video | Accepted max video lead | Startup-dropped PCM |
| --- | --- | --- | --- | --- | --- |
| Label trace, baseline | 250 ms / 8 frames | 75.33 ms | 5 / 0 | Not recorded | 10.33 seconds |
| Extended baseline | 400 ms / 14 frames | 54.00 ms | 0 / 0 | 233.29 ms | 12.48 seconds |
| Extended audio jitter | 400 ms / 14 frames | 39.33 ms | 0 / 0 | 376.49 ms | 15.56 seconds |
| Default-buffer audio jitter | 250 ms / 8 frames | 71.33 ms | 2 / 0 | 245.60 ms | 13.44 seconds |

The extended baseline did not exercise deadlines beyond the original bound and
cannot substantiate a buffer improvement. Audio jitter did exercise that path;
mean accepted lead is 248.48 ms, with 37 frames still beyond the new limit, ten
late deadlines, 12 origin-delta rejections and two audio deadline resets. Queue
overflow is zero; 452 video frames are submitted, ten late and 20 flushed on
binding changes/shutdown. The default-buffer comparison has 91 overly early
frames, 51 origin-delta rejections and three audio deadline resets. These are
sequential recordings with different measured jitter/load, not identical-input
A/B tests or causal proof. The experimental buffer remains disabled by default.
True capture timing, total conversation latency and G1 remain unqualified.

Validation: 19 Rust tests; default/OBS Clippy with warnings denied; 23 recorded-run
queue/retirement checks; 13 pre-mux traces; independent decoder comparisons;
formatting/diff checks. New checks verify numeric trace bounds and actual accepted
lead versus declared buffer/capacity. No source or callback ownership was added.
The first extended attempt found the relay had previously died from ENOSPC and
failed connection setup; its short recording is excluded. Restarted relay runs
complete with saved packet statistics. No builds or decoder analyses ran during
the valid recordings.

To resolve repeated low-disk failures, inactive original-checkout Rust debug caches
and the cached development app bundle were removed. Source, module configuration,
user sets/media/recordings and installed production remain intact; that checkout's
development bundle now requires rebuilding. G1 is incomplete. Next work is bounded
startup/recovery and explicit receive-buffer/conversation latency accounting,
followed by physical reference-fed speakerphone AEC and platform packaging proofs.
