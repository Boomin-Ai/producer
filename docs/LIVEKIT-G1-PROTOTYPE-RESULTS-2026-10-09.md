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


### Startup milestones and label reanchor correction — October 10

New playback evidence retains at most 64 first-observation startup milestones,
keyed by binding epoch: audio/video binding, first bound PCM pull, usable clock
maps, and first scheduled media. These use receiver-local observation/pull clocks;
they do not prove sender capture time or physical speaker latency. A paired PCM
pull can precede the stats-binding observation by a few milliseconds without
preceding the binding epoch. Audio label observations now segment on every
presentation reanchor, including reanchors within the same source generation.
Older maximum label drift values remain saved and retain the prior caveat.

Two 45-second audio-jitter recordings use three publishers and three guest-1
rejoins, with both bounded experimental policies enabled. Build/decode analysis
did not overlap either recording. See `startup-rejoin-milestones.json` and the
full native/browser/packet/container/decoder evidence.

| Run | Binding discovery | First audio scheduled after binding epoch | Independent matched p95 | Missing audio/video |
| --- | --- | --- | --- | --- |
| Startup trace, prior binding polling | 114–804 ms | 2,844–4,689 ms | 72.00 ms | 1 / 0 — local gate fails |
| Event-triggered binding discovery | 10–520 ms | 3,224–4,941 ms | 65.33 ms | 0 / 0 — local gate passes |

Publication subscription/valid unsubscription now triggers immediate stats-based
binding discovery; already bound publications skip redundant stats awaits.
Unsuccessful discovery still retries every 500 ms, with a 100 ms timeout per
track. The trace shows a remaining approximately 500 ms binding retry in several
epochs: event notification can arrive before usable inbound SSRC stats. Stats
awaits still share the 10 ms application loop; this is not a qualified production
scheduling design. These sequential workloads differ in jitter/load and do not
prove overall recovery improved. The several-second usable-clock wait dominates
and remains unresolved; removing the binding poll alone does not solve it.

Corrected traces show maximum label step/shift of 10.014/11.193 ms in the first
run and 10.000/39.992 ms in the second. They do not retroactively establish that
all earlier drift was scheduling-related. Neither new run incurred an audio
presentation reanchor after the 14 publication-binding clears, so that specific
regression is verified by the same-generation reanchor unit test, not asserted
as exercised by these recordings. New tests also prove milestone deduplication,
epoch separation and the 64-entry hard bound. Queue/probe accounting checks now
cover 25 recordings and 15 pre-mux traces; timing failures remain preserved.

G1 remains incomplete. Next: separate first-report availability from mapped PCM
availability, investigate supported sender-report scheduling, and move binding
stats collection off the presentation loop with owned cancellation and stale-SID
checks. Physical reference-fed speakerphone AEC and platform packaging still gate
broader integration. No deployment or production recording policy changed.

Validation for this checkpoint: 21 Rust tests pass; default and OBS Clippy pass
with warnings denied; formatting and diff checks pass. Owned lab services stopped
after both recordings; the installed production app remains untouched.


### Owned binding discovery and sender-report cadence — October 10

Stats-based binding discovery is now off the 10 ms presentation loop. One owned
Tokio JoinSet job holds at most two current publication clones, applies 100 ms
per-track / 250 ms overall deadlines, and returns bounded SID/kind/SSRC results.
Presentation only polls completed work. Binding changes abort the job; results
must match the current binding epoch, an independent invalidation generation, and
current publication SID. Shutdown aborts and joins pending jobs before room
retirement. No thread, native observer registration, or strong callback back-reference
was added. Ownership is presentation scope → JoinSet job → track clones → existing
SDK receiver; a completed SDK stats callback only owns its existing response
context, without a reference back to the job. Aborting the Rust future does not
prove cancellation of WebRTC's internal stats request; its eventual callback is
handled by the existing SDK. Broader lifecycle qualification remains gated.

New tests exercise a blocked future without blocking poll, cancellation with
observable owned-resource destruction, timeout and retry, task failure and retry,
old-epoch rejection, and invalidation of completed work even when timestamp epochs
are equal. A sender-report arrival test rejects outgoing reports, wrong SSRC and
old epochs, retaining only the earliest valid incoming observation.

One valid 45-second / three-publisher / three-rejoin audio-jitter recording
(`discovery-worker-rejoin-v2`) matched every marker with independent p95 **55.33 ms**.
Discovery performed ten jobs, ten completed, zero timeout/failure/cancellation,
peak one and zero active after shutdown. This recording therefore validates the
normal asynchronous stats path, not cancellation under delayed native SDK stats;
those Rust ownership/race paths are exercised by unit tests. The recording
preceded the additional independent invalidation-generation guard, which has its
own regression test; the final executable includes that guard. No build or decode
analysis overlapped the valid recording. All six native decoded source registrations
retired (six created/six destroyed/zero alive), and the OBS pipeline probe retired.
The experimental video bound remained 400 ms, but maximum actual lead was only
246.35 ms; this run does not test holding frames beyond the default 250 ms bound.

| Epoch | Audio/video binding | First incoming video SR | First incoming audio SR | First scheduled audio |
| --- | --- | --- | --- | --- |
| Initial | 517.0–517.1 ms | 3,936.2 ms | 3,936.2 ms | 3,987.3 ms |
| Rejoin 1 | 16.4–16.5 ms | 767.5 ms | 3,768.1 ms | 3,797.8 ms |
| Rejoin 2 | 21.9–22.0 ms | 2,535.2 ms | 2,535.2 ms | 2,632.2 ms |
| Rejoin 3 | 512.0–512.1 ms | 4,300.0 ms | 4,300.0 ms | 4,394.2 ms |

All report times are after the first observed bound PCM pull in their epoch.
This run does not support the hypothesis that an audio report arrived before the
PCM mapper's cutoff and was discarded. The ~3,001 ms audio/video SR gap at rejoin 1
is instead consistent with the pinned SFU's subscriber report schedule.
[LiveKit v1.13.9 participant source](https://github.com/livekit/livekit/blob/v1.13.9/pkg/rtc/participant.go#L2635-L2695)
creates downstream reports and sleeps three seconds between batches.
The local pinned `RTPStatsSender.GetRtcpSenderReport` source also requires publisher
SR data before creating a downstream report. Thus publisher report availability
plus the downstream schedule can contribute to startup; the measurements do not
separately attribute how much wait occurred at each hop. No supported cadence
configuration or modified-SFU build has yet been qualified. Do not describe this
as a solved subsecond startup path or silently replace sender timing with arrival.

The first attempted recording was invalidated by ENOSPC: the relay crashed on an
optional snapshot write, followed by recording pipe failure. Its MP4 has no native
report and is excluded. Relay snapshot writes now catch and report persistence
errors instead of terminating forwarding. A deterministic temporary-directory fault
produced EISDIR while the HTTP stats endpoint remained alive; no media-performance
claim is made from that fault test. The restarted valid recording reports zero
snapshot errors and an observed audio-jitter profile. Invalid evidence is preserved.

The first build also produced a truncated executable after `rust-objcopy` ENOSPC
despite Cargo reporting success. A whole-profile stripping override triggered
unnecessary dependency rebuilds; that build was interrupted and only its newly
created target-cache files (134.4 MiB) were removed. The final-crate-only override
`cargo rustc ... -- -C strip=none` produced a valid ~58 MiB Mach-O using the existing
link-time native DWARF stripping. The rebuildable npm download cache (~222 MiB) was
also cleared; installed dependencies, source and user media/data were preserved.

Validation: 27 Rust tests; default/OBS Clippy with warnings denied; syntax check and
injected relay snapshot failure; 26 recording-accounting checks; 16 pre-mux traces;
independent decoder comparisons; final build, formatting and diff checks. All owned
lab services stopped. G1 and physical speakerphone AEC remain incomplete. Next:
prototype earlier downstream SR delivery on a pinned isolated SFU while preserving
publisher timing, and distinguish publisher-first-report wait from SFU emission
wait. Provider deployment/integration remains gated.

### Isolated downstream sender-report cadence comparison — October 10

Built an isolated LiveKit v1.13.9 server from immutable commit
`6fbe7f7e648aab4b2f734d6044a416bc2cbc482c` with checksum-verified Go 1.26.0.
The tracked `native/build-sfu-lab.py`, patch and provenance manifest reproduce
the experiment under ignored runtime directories. The default subscriber SR
interval remains three seconds; a lab-only environment switch selects 250 ms.
This increases cadence 12 times and preserves the publisher-SR prerequisite and
RTP/NTP mapping. Publisher reports are traced before the existing reference update.
No deployed provider, production application or upstream installation was changed.

Two sequential 45-second synthetic recordings used that same server executable,
three guests, three guest-1 rejoins, the audio-jitter relay, and the same native
first-report bootstrap, extended video buffer and diagnostic finalized-MP4 opt-ins.
Both had zero relay snapshot-write errors. This is a local comparison rather
than an identical captured-input replay or a Cloud performance qualification.

| Epoch | Normal cadence: first scheduled audio | 250 ms cadence: first scheduled audio |
| --- | --- | --- |
| Initial | 4,051.5 ms | 2,488.4 ms |
| Rejoin 1 | 4,906.9 ms | 2,575.3 ms |
| Rejoin 2 | 3,785.4 ms | 2,462.3 ms |
| Rejoin 3 | 2,497.2 ms | 2,505.2 ms |

Times are measured from the corresponding native binding epoch, not from a
user's join click. The normal run has one intermediate video-only epoch with no
scheduled audio; the table uses the four epochs that actually scheduled audio.
Startup-dropped 10 ms audio blocks decreased from 1,315 to 842 (summed over the
run), but the faster arm still takes approximately 2.5 seconds to schedule audio.
Both runs had 14 binding-clear resets. Discovery stayed bounded to one active job:
normal 12 spawned/completed, fast 11 spawned/completed, zero timeouts, failures,
stale results or active jobs at shutdown. Each run retired all six decoded native
sources (six created/six destroyed/zero alive) and its OBS pipeline probe.

The new bounded native milestone metadata preserves first-report SSRC, RTP and
sender NTP after later reports arrive. `native/analyze-sfu-startup.py` correlates
these with the SFU publisher trace by downstream SSRC and unambiguous track ID.
In the SFU's own wall-clock domain, the first publisher audio report arrived
2,024–2,052 ms after the first publisher video report in the normal arm, and
2,035–2,045 ms later in the faster arm. This exposes a publisher-report availability
gap that lowering the downstream interval does not remove. Sender NTP advancement
between the first publisher reference and first received downstream report was
31–235 ms for audio in the faster arm, versus 148–2,557 ms in the normal arm.
NTP advancement is not an exact isolated SFU hold or network latency measurement;
no SFU wall time is subtracted from native monotonic time.

Both recordings pass the independent local marker gate with no unmatched markers:
normal 61.33 ms p95 (12 pairs), faster 53.33 ms p95 (13 pairs). AVFoundation reports
61.33/54.67 ms respectively. The reduced startup delay does not establish end-to-end
conversation latency, speakerphone AEC, or G1 completion.

The server initially failed compilation repeatedly due to ENOSPC. Additional
authorized cleanup removed rebuildable dependency download archives, compressed
inactive SFU logs, and cleared an inactive 920 MiB Clang module cache. Sources,
native SDK archive, sets, user recordings, profiles and installed apps were retained.
Compilation and decoder analysis did not overlap either valid recording. The final
SFU is a valid arm64 executable reporting 1.13.9; its hash is in the manifest. The
native proof executable was rebuilt with the final-crate strip override and checked
as a valid Mach-O. All owned lab listeners were stopped afterward.

Validation: cadence helper test (not the full upstream test suite), full server
build, 27 OBS-feature Rust tests including first-report retention across polls and
epochs, OBS-feature Clippy with warnings denied, formatting/syntax/provenance
checks, 28 recording-accounting reports and 18 pre-mux traces. Failed historical
timing evidence remains preserved. G1 and physical speakerphone AEC remain open.
Next: investigate a supported early publisher timing mechanism and prove startup
without inventing an arrival-time clock; the faster SFU cadence alone is insufficient.

### Early publisher report request — failed startup experiment, October 10

Investigated the standard RTCP-SR-REQ mechanism, defined in
[RFC 6051 section 3.2](https://www.rfc-editor.org/rfc/rfc6051.html#section-3.2).
The inspected upstream WebRTC receiver parses RapidResyncRequest and invokes
OnRequestSendReport for a sending module. This source capability does not establish
support in every browser release or a configurable LiveKit Cloud feature.
[WebRTC receiver source](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/rtp_rtcp/source/rtcp_receiver.cc).
Browser RTCRtcpParameters exposes CNAME/reduced-size configuration rather than
a sender-report interval control. [WebRTC specification](https://www.w3.org/TR/webrtc/#dom-rtcrtcpparameters).

An additional pinned-source patch adds a disabled-by-default request policy to
the existing audio buffer packet path. It uses the existing buffer lock, owns no
thread, queue or timer, targets that buffer's audio SSRC, and retires on a received
publisher report, expiry or budget exhaustion. The diagnostic budget is three
attempts at 250 ms spacing within one second. The policy test covers disabled,
report arrival, exhaustion, deadline and timestamp regression; the full server
built successfully. Its source and binary hashes are in
`evidence/sfu-early-report-provenance.json`. This retry spacing is not accepted for
deployment: RFC 6051 permits repetition once per RTCP reporting interval. Only
one request per audio track was actually observed in this experiment. A follow-up
must use one request or respect the publisher's reporting interval.

After a three-guest control attempt failed ENOSPC during muxing, two valid local
30-second recordings used one guest and one disconnect/rejoin, the same newly
built server executable, 250 ms downstream cadence and the same native timing
opt-ins. Only the enabled arm set LIVEKIT_LAB_EARLY_AUDIO_SR. The failed recording
has no native completion report and is excluded; its separate invalid-run record
preserves log/recording hashes. Reduced concurrency is not a three-guest acceptance
result. Compilation and decoding did not overlap valid recordings.

| Observation | Request disabled | Request enabled |
| --- | --- | --- |
| Initial first scheduled audio | 2,370.2 ms | None before guest disconnect |
| Rejoined first scheduled audio | 2,531.8 ms | 6,103.4 ms |
| Startup-dropped 10 ms audio blocks, summed | 435 | 1,244 |
| Independent recorded marker p95 | 54.67 ms, 10 pairs | 26.00 ms, 7 pairs |

The early request failed startup acceptance. Passing marker pairs later in the
recording do not account for the missing initial audio or excuse a six-second
rejoin. The comparison explicitly counts the epoch with bound PCM and no scheduled
audio, and retains startup_qualified=false. Both runs retired two decoded sources
and their OBS probes, with zero live native sources and discovery jobs at shutdown.
Discovery spawned/completed five jobs in the control and six with requests, with
no timeouts, failures or stale results. Local marker pairs had zero unmatched
markers; no arrival-time fallback was added.

The SFU log places each guest audio request approximately 90–92 ms before its
audio downtrack addition. The inspected pinned ReceiverBase.AddDownTrack stores
the subscriber but does not seed cached publisher sender-report data; setupBuffer
broadcasts new SR data only to downtracks present when that callback fires.
[Pinned receiver source](https://github.com/livekit/livekit/blob/6fbe7f7e648aab4b2f734d6044a416bc2cbc482c/pkg/sfu/receiver_base.go).
This source finding and event order are consistent with losing an early report
before subscriber initialization. The buffer's actual SR receipt was not separately
instrumented, so exact causal attribution remains an inference. Next: instrument
buffer receipt and seed subscriber timing safely, covering concurrent report
updates, stale publications and close races. Do not promote this request policy.

Disk pressure also prevented small source writes after testing. Rebuildable Go
compiler/module caches, Bun/Chrome caches and Rust dependency artifacts were
cleared after their use; source, lab executables, the native WebRTC SDK archive,
user media and installed apps were preserved. Subsequent Rust/SFU rebuilds will
recreate those caches. The verified native executable remains available. All owned
lab listeners stopped, and source/patch/provenance/syntax/diff checks passed.
The recording verifiers cover 30 completed reports and 20 pre-mux traces while
retaining historical failures. No deployment or production migration occurred.

Physical testing is not ready yet: the existing APM speech/noise fixture supplies
synthetic reference PCM, not actual speaker playback. Before requesting user time,
prepare one declared native capture/playback owner, feed the final device-bound
PCM into APM, save enabled/disabled capture and processing evidence, and expose a
controlled double-talk test. Startup work and real device-reference wiring remain
open; G1 and physical speakerphone AEC remain incomplete.


### 2026-10-10: One delayed request improves local startup; physical AEC remains open

Built a separate pinned SFU executable with one-shot audio SR requests after
500 ms and buffer-level receipt tracing. Both one-guest comparison arms use this
same binary (SHA-256 `09d100f23cd3377edb8acb90496d63ed95a590b8524d6b33061bf9108fb31c09`),
250 ms downstream RTCP cadence, the audio-jitter relay, 30-second finalized MP4,
first-report bootstrap and the extended video queue. The old immediate-request
flag is unset. No upstream timestamp-offset validity guard was changed and no
cached report was seeded. This fixed delay is a diagnostic candidate, not a
subscriber-aware deployment policy.

| Run | First scheduled audio after binding / rejoins | Startup dropped 10 ms blocks | Independent recorded A/V absolute p95 |
| --- | --- | --- | --- |
| One guest, request off | 2.553 / 2.581 seconds | 459 | 65.33 ms, 10 marker pairs |
| One guest, delayed request | 1.376 / 1.893 seconds | 223 | 52.67 ms, 12 pairs |
| Three guests, delayed request, three guest-1 rejoins | 1.498 / 0.592 / 0.610 / 0.582 seconds | 169 | 60.67 ms, 17 pairs |

All three recordings have zero unmatched markers and pass the local 80 ms p95
gate. The three-guest run still contains one 120 ms marker offset; a p95 pass is
not a maximum-offset guarantee. These intervals begin at the receiver binding
epoch, not at user admission, and the separate runs are not identical-input
replays. The candidate initially waits for video timing after audio timing is
ready; startup/recovery and end-to-end capture latency remain unqualified.

Buffer traces now show each candidate guest audio request occurring 411–443 ms
after downtrack registration, with one subscriber present at first accepted SR
receipt. Its report callback reaches the subscriber handler within 0.014–0.015 ms
on the SFU clock. Control first receipt occurs about 2.34 seconds after downtrack
registration. These are callback observations, not wire-arrival latency. Evidence:
`labs/guest-rtc/evidence/delayed-request-subscription-order.json`,
`sfu-delayed-request-startup-comparison.json`, and
`sfu-delayed-churn-startup-comparison.json`. This supports the delayed candidate;
it does not retroactively prove the uninstrumented immediate-request failure.

The one-guest runs each create and destroy two decoded sources; three-guest
churn creates and destroys six. All finish with zero live sources, active
discovery jobs, or outstanding presentation queue entries. Policy helper tests,
full SFU build, patch/provenance checks, and Python syntax checks pass. Full
upstream server tests were not run. The recording verifiers now cover 33 completed
reports and 23 pre-mux traces. A verifier assumption was corrected: enabling
first-report bootstrap does not force a run to use it when a strict two-report
map is already fresh. Archived fixtures must still exercise both bootstrap paths;
all queue, timing and retirement gates remain in place.

The owned-process runner preserves existing evidence and shuts down its SFU,
web and relay processes. It can reproduce one-guest control/candidate runs and
three-guest churn via `native/run-sfu-startup.py`. No production configuration or
installed Producer app changed. G1 remains incomplete. Next: address binding-time
video-report availability without accepting stale publication reports, then wire
one actual capture/playback owner and final speaker-bound PCM into APM before
asking for physical speakerphone testing.

## First physical speakerphone capture — 2026-10-10

An isolated native macOS lab now owns actual microphone capture, speaker
playback and the final mixer reference feeding WebRTC APM. It does not publish
the microphone or integrate the production LiveKit guest path. The app bundles
its test clip in `~/Applications` and writes private recordings to Application
Support, avoiding the Documents permission prompt that blocked first launch.

The first hardware attempts overflowed the original eight-block rings before
the owner processed any audio. Both taps are now measured delivering 4,800-frame
(100 ms) batches despite requesting 480 frames. Fixed 32-block rings accommodate
those bursts; overflow still invalidates the run. Native self-tests cover a
ten-block burst, bounded overflow, concurrent producer/consumer accounting and
20 partial-initialization teardown cycles. Rust Clippy and strict native compiler
checks pass.

The next physical run completed in 60.030 seconds with 5,990 ten-millisecond
blocks on each timeline, zero overflow, zero format/timeline faults, zero clipped
samples and no active callbacks or retained native owners at shutdown. Maximum
block interval deviation from 10 ms was 0.0072 ms. Processing both APM-on and
APM-off took 517 microseconds at p95. The file/lifecycle verifier passed.

Across 84 eligible far-only windows, provisional echo attenuation was 31.26 dB
median and 12.27 dB p10, exceeding the initial 20/10 dB thresholds for this run.
Speaker volume was instructed at 50%, not independently measured. The user
reported forgetting to talk; therefore double-talk preservation and near-speech
intelligibility were **not tested**. A reduction in the instructed double-talk
window is not evidence of speech suppression when no deliberate speech occurred.

Evidence: `labs/guest-rtc/evidence/speakerphone-first-completed-run.json`; raw
voice/audio files remain private outside the repository. Repeat the same setup
with deliberate speech during seconds 30–60, review preserved speech, then test
75% speaker volume and repeated lifecycle/device changes. Physical AEC acceptance
and G1 remain incomplete; no production deployment or installed Producer change.

## Second physical run with speech — 2026-10-10

The second completed run collected 6,000 blocks per timeline in 60.040 seconds,
with no queue overflow, native format/timeline errors, invalid delays or retained
owners/callbacks. File/accounting validation passed. Both APM paths took 521
microseconds at p95. There were 431 clipped samples in the native taps; recorded
PCM locates them in the microphone, including a brief loud burst around second
32. This requires headroom review rather than attributing distortion to AEC.

Near-only seconds 51–59 measured -20.69 dBFS raw versus -20.89 dBFS processed
(0.20 dB lower). During instructed double talk, seconds 31–49 measured -17.77
versus -19.33 dBFS. That mixed-signal level difference cannot isolate retained
near speech from removed echo or prove intelligibility. A private 17-second
processed voice excerpt (seconds 34–44 and 52–58, separated by silence) was
prepared and opened for human listening; review is pending. No audio is committed.

The full far-only window reported median 30.76 dB but p10 only 1.07 dB, so its
predeclared lower-tail target did not pass. Input levels strongly indicate speech
during baseline and the early instructed far-only interval. Seconds 18–29 have
lower input and show 32.20 dB aggregate attenuation; this is a post hoc diagnostic
observation, not a replacement acceptance window. A compliant repeat is needed.
Evidence: `labs/guest-rtc/evidence/speakerphone-second-completed-run.json`.
Physical AEC, louder-speaker testing and the integrated G1 path remain unqualified.

Human feedback on the processed excerpt: “sounds pretty good,” with slight
distortion. The excerpt's double-talk and near-only portions contain no clipped
PCM samples in either raw or processed files, so clipping elsewhere cannot
explain that feedback. A 19-second original/processed comparison was prepared
and opened for attribution. Near-only signal timing also changes through APM:
a single-window lag search found a strongest positive correlation at 8.75 ms;
this is diagnostic, not an end-to-end latency result or speech-quality score.
Do not tune suppression or claim intelligibility acceptance until the listening
comparison distinguishes capture coloration from AEC processing artifacts.

## Offline voice-coloration comparison — 2026-10-10

The user identified slight distortion only in the cleaned audio. Inspection of
the pinned WebRTC headers found that `echo_canceller.enforce_high_pass_filtering`
defaults true. The SDK wrapper passed explicit high-pass=false but never
overrode AEC enforcement. Earlier high_pass=false reports described the request,
not effective processing. Historical evidence now carries this correction;
new physical and synthetic fixture reports distinguish the request from AEC
enforcement. Original recordings/reports are preserved.

An additive SDK setter/getter exposes enforcement for setup-time experiments;
ordinary constructors retain existing behavior. No new native owner, callback
or thread is introduced. Repeated APM initialization, processing, configuration
observation and drop tests cover the new option over 20 cycles. The existing
shared native receiver suite passes 28 tests; replay tests pass 2 and replay
Clippy passes with warnings denied.

A device-free replay uses each recorded speaker/microphone block in its original
CSV processing order and its original delay value. On both recordings, the
baseline reproduces all original processed PCM exactly (zero RMS error). The
candidate disables only AEC high-pass enforcement before processing, keeping
AEC enabled and NS/AGC/explicit high-pass disabled. Across 83 eligible aligned
comparison windows in the clean echo-only recording, baseline attenuation was
31.08 dB median/12.27 dB p10; candidate 29.83/12.10 dB. These same-window replay
metrics differ slightly from the online report's window boundaries. Both meet
the initial 20/10 dB thresholds on that recording.

On the speech recording, near-only gain changes from -0.199 dB with baseline
to -0.009 dB with the candidate. Signal level does not establish perceived
quality. The contaminated instructed far-only window remains unqualified in
both profiles (p10 1.07/0.94 dB). A private current/candidate voice comparison
was opened for human listening; candidate quality and a new physical run remain
pending. Evidence: `labs/guest-rtc/evidence/speakerphone-high-pass-replay-comparison.json`.
No candidate change has been applied to production or promoted to physical
acceptance. G1 remains incomplete.

The user reported the high-pass-disabled candidate sounded slightly better
than the current cleaned voice. The isolated physical lab now selects this
profile once before any audio processing, keeps AEC enabled, and records
`aec_profile=no_forced_high_pass` plus the observed enforcement flag. Its
status identifies voice refinement and uses larger phase prompts. Native
20-cycle queue/partial-initialization checks, two Rust tests, Clippy and strict
ad hoc signature validation passed after packaging. It was reopened for a
compliant 50% speaker-volume run; no new physical result or qualification yet.

## Refined physical run and volume evidence — 2026-10-10

The first actual no-forced-high-pass run completed in 60.043 seconds, with
5,990 blocks per timeline, zero overflow, zero native format/timeline faults,
zero invalid delay blocks, and clean owner/callback retirement. File/accounting
verification passed. Both APM paths took 403 microseconds at p95. The report
confirms AEC high-pass enforcement false. Across 82 eligible far-only windows,
echo attenuation measured 28.57 dB median and 22.47 dB p10, passing the initial
20/10 dB signal thresholds for this recording.

The instructed baseline/echo-only levels are consistent with quiet participation.
Near-only signal level is essentially unchanged (-17.9150 dBFS raw/processed),
and instructed double-talk level changes -0.92 dB. There were 35 raw microphone
clipped samples during double talk, with no clipping in the inspected quiet
and near-only intervals. These signal levels support preservation but cannot
establish intelligibility by themselves.

The protocol requested 50% speaker volume. A post-run read returned 6%; the
user explicitly said they lowered it afterward. That reading cannot establish
volume during the test. Existing recording evidence is preserved with this
context. New lab builds record CoreAudio default-output volume scalar snapshots
at start/end, with unsupported controls null and no claim of continuously
verified volume or calibrated acoustic SPL. A read-only native probe returned
6.25%, consistent with the rounded OS setting. It creates no audio owner or
callback and does not change volume/routing. Native 20-cycle checks, strict
compiler checks and physical-bin Clippy pass after rebuilding/packaging.

Evidence: `labs/guest-rtc/evidence/speakerphone-refined-physical-run.json`. The
updated native lab is open for a louder 75% repeat, with deliberate speech only
during seconds 30–60. Full physical AEC acceptance and integrated G1 remain open.

## Louder physical stress run — 2026-10-10

The no-forced-high-pass run started at a recorded default-output scalar volume
of 75.0% and ended at 93.75%. Change timing is not sampled. Preserve this as a
variable-volume stress result rather than claiming a controlled constant-75%
acceptance run or calibrated acoustic SPL.

It completed in 60.046 seconds with 6,000 blocks per timeline, zero overflow,
zero format/timeline faults, zero invalid delays and clean native owner/callback
retirement. The file/accounting verifier passed. Both APM paths took 520
microseconds at p95. Across 84 eligible far-only windows, provisional echo
attenuation was 36.89 dB median/26.07 dB p10, exceeding the initial signal
thresholds for this recording.

Near-only signal level measured -20.5004 dBFS raw versus -20.5012 dBFS
processed. Instructed double-talk level was -16.37 versus -19.70 dBFS; this
mixed-signal change cannot isolate voice attenuation from removed speaker echo.
There were 384 raw microphone clipped samples, predominantly during a brief
burst around second 37. The inspected near-only interval has no clipping. A
12-second cleaned excerpt (seconds 39–44 and 52–58) contains zero clipped
processed samples and was opened for human quality review, which is pending.

Evidence: `labs/guest-rtc/evidence/speakerphone-louder-physical-run.json`. The
actual capture/reference/APM owner has now produced encouraging repeated
physical results, but voice intelligibility, controlled volume coverage, device
changes and the full integrated LiveKit guest path remain separate open gates.
No production deployment or installed Producer changes occurred.

The user listened to the louder-run excerpt and reported “sounds great.” This
passes the subjective quality check for that excerpt. Together with measured
echo reduction and repeated clean capture teardown, it supports retaining the
no-forced-high-pass profile in the isolated prototype. It does not qualify a
controlled constant-volume matrix, remote guests, the complete production mix
reference, WAN recovery, device changes or the five-hour envelope. Next G1 work
is to connect the actual capture/playback/APM owner to the isolated LiveKit
guest path, retaining bounded timestamped queues, mix-minus, private-cue routing
and lifecycle evidence before expanding integration.

## Capture publication handoff investigation — 2026-10-10

Extracted the selected no-forced-high-pass AEC profile into a shared
`MicrophoneProcessor`, used by the physical speakerphone session and a new
generated-input LiveKit publication diagnostic. This preserves the physical
lab's processing order/settings and does not publish its microphone. The
diagnostic uses generated 48 kHz mono PCM in ten-block/100 ms batches and
generated silent reference PCM; it cannot establish physical AEC performance.
SDK AEC/NS/AGC remain disabled to avoid double processing.

The timestamped handoff owns at most 32 blocks, anchors once per generation,
checks consecutive 10 ms capture steps with 2 ms tolerance, and enforces at
least 8 ms publication spacing. Overflow, discontinuity, clock regression,
late arrival or a missed provisional 20 ms publication deadline retires the
generation and clears its queue. Cancellation/error also clears pending PCM.
These are diagnostic bounds, not a frozen production scheduler or private-cue
implementation. Actual destination authorization and SDK/encoder queue fencing
remain open.

Four sequential one-guest/one-rejoin loopback runs failed the new publisher
deadline. The shared-runtime version emitted 94 blocks; an isolated publisher
thread emitted 144. Interactive QoS then emitted 1,801 blocks before failure;
a repeat without a simultaneous build emitted 50 before failure. The two
instrumented interactive runs observed owner tick gaps of 28.131 and 27.008 ms,
maximum direct audio SDK call durations of 0.807 and 0.399 ms, and maximum APM
batch durations of 4.291 and 0.969 ms. This points toward scheduling pauses in
these runs, rather than a long direct SDK audio call. It does not identify the
OS/root cause or qualify the source under pressure. Earlier fault metrics
omitted the offending lateness; current code records it before retiring.

All failed generations accounted for accepted = emitted + retired pending;
pending was zero afterward. Both decoded sources were destroyed in every run.
Where the dedicated publisher owner was present, its thread was explicitly
joined. Initial runs overlapped some local compilation; the idle repeat did not.
Interactive priority failed to resolve the issue and its override was removed
from retained code. No additional successful batching run is claimed.

There is also a structural latency failure: the deterministic 100 ms batching
test produces a 100 ms p95 adapter queue age, above the plan's initial 30 ms
audio adapter target. Current code measures this with a fixed 350-bin histogram
and reports the target separately from deadline faults. Increasing the queue or
deadline would not resolve the batching latency. The capture/playback owner
must deliver smaller timestamped blocks before this becomes a candidate for
the integrated physical call test. In addition, the SDK direct source still
has no external capture timestamp parameter; preserving timestamps in the
Rust handoff alone does not prove their mapping into RTP or camera alignment.

The original generated source remains the default. A 30-second control with
the new named publisher thread passed browser/native return media and guest
rejoin. It joined in 0.165 ms and destroyed both decoded sources. This is an
existing synthetic-path regression check, not physical publication acceptance.
The owned runner now records binary hashes and failed as well as completed
conditions, and accepts a unique evidence suffix without overwriting trials.

Tests cover paced batches and the explicit queue-age target failure, stalls,
overflow, timestamp/clock discontinuity, cleared destination generations, and
40 AEC-owner cancellation/error teardown cycles. The shared receiver suite has
33 passing tests. A deterministic 10 ms input comparison meets the queue-age
target with 10 ms p95/peak two pending blocks; hardware I/O still must establish
that cadence. The physical-bin tests also pass. Evidence is summarized in
`labs/guest-rtc/evidence/capture-publication-batching-investigation.json`, with
references/hashes for all five runs. Original reports/logs/recordings are kept.

Next: prototype low-latency native I/O capture and final monitor-reference
callbacks, with bounded callback copies and explicit unregister/owner teardown.
The local Apple SDK documents `AVAudioSinkNode` as an input-chain I/O-thread
receiver with hardware-matching format and no format conversion; it cannot be
used as a mixer-output sink. A separate final-output/reference callback and
its actual PCM/timestamp semantics must be proven. Then establish source
capture-clock propagation or an explicitly measured alternate synchronization
contract, and repeat physical AEC/double-talk with real loopback RTC routing.
G1 remains incomplete. No installed Producer or production deployment changed.


### Native I/O callback candidate — October 10, physical qualification pending

Added an opt-in `--io-callbacks` speakerphone lab path: hardware-matching
AVAudioSinkNode input and an output AudioUnit post-render notification. Both
callbacks copy only bounded PCM into existing fixed-capacity rings. The owner
stops the engine, removes the notification while the unit is still owned,
detaches nodes and waits for callbacks before releasing state. Default tap
capture and the selected no-forced-high-pass AEC profile remain available.
Capture-to-APM age is recorded in a bounded 6,100-entry signed microsecond
sample collection; it includes scheduling/reference wait and is not acoustic
latency or SDK/RTP synchronization proof.

The first physical attempt failed during setup: the output scope bus 0 has
48 kHz stereo Float32 **interleaved** PCM (flags 0x9, eight bytes/frame), while
the input scope has noninterleaved PCM (flags 0x29, four bytes/frame). A
read-only `--format-snapshot` probe confirmed those actual formats without
starting capture. The candidate now accepts native-endian packed stereo
Float32 in either layout and downmixes the supplied buffers. It still rejects
other rates/formats and malformed callback buffers. Setup errors now finalize
empty files and save an explicit failed report instead of losing the reason.

Twenty native synthetic lifecycle cycles passed, including actual notification
registration/removal on a non-hardware mixer AudioUnit, mixed interleaved and
noninterleaved 512-frame callbacks, identical expected downmixed samples,
continuous 10 ms block timestamps, injected errors, partial initialization
cleanup and zero surviving owners/states/notifications. Strict Objective-C++
warning checks and the native lab build passed. The development app was
repackaged, ad-hoc signature verified, and visually confirmed ready. Physical
callback PCM availability, timing, echo attenuation and speech preservation
remain unproven until the next user-operated test is analyzed. Nothing in
this candidate is a production deployment, Apple notarization or G1 completion.


### Native I/O physical run and voice review — October 10

The user-operated second attempt completed 60.043 seconds at reported 56.25%
output volume start/end. Each stream supplied 6,000 10 ms blocks from maximum
512-frame native callbacks. Zero format/timeline errors, overflow, invalid
APM delays or clipping; all blocks were consumed and native callback owners
and render registrations were retired. The file/timestamp/accounting verifier
passed. Capture-host-timestamp to APM processing age was 13.185 ms minimum,
24.104 ms p95 and 30.402 ms maximum. This meets the provisional p95 30 ms
adapter target for this run; it is not SDK publication or acoustic latency.
Both APMs took 323 microseconds p95 together. Provisional far-only attenuation
was 28.322 dB median / 17.634 dB p10. The user confirmed speaking during
30–50 seconds and that the original/cleaned comparison preserved clear voice.
Near-only 52–58-second levels were -26.413/-26.320 dBFS raw/cleaned. Private
voice recordings and comparisons remain in Application Support; only numeric
reports, a report hash and the human review statement are retained in git.

The immediately preceding attempt failed after 68.674 ms with two native
errors; it produced only one block per stream and still retired all callbacks
and registrations without overflow. Its generic error counters cannot prove
the cause. It is retained beside the completed report in
`labs/guest-rtc/evidence/native-io-physical-run.json`; this pair does not qualify
startup reliability. Add first-fault codes per I/O stream (layout/timestamp,
buffer, continuity, nonfinite samples, post-render, configuration change),
without removing rejection checks or retrying invisibly. Further native starts
must establish whether the failure recurs and report its precise category.
After stable starts, connect this hardware callback path to the bounded
publication handoff and measure actual SDK/receiver synchronization and owned
monitor-reference routing. G1 remains incomplete; production unchanged.
