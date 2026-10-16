This is an isolated macOS hardware AEC lab, not the integrated LiveKit guest path.

Build with `LIVEKIT_LAB_LINK_EXTERNAL_ARCHIVE=1 cargo rustc --locked --jobs 1
--features physical-aec --bin producer-speakerphone-lab -- -C strip=none`, then
run `python3 native/package-speakerphone-lab.py`. The packager runs 20 native
queue/partial-initialization cycles and adds a distinct development microphone
permission identity. Its ad hoc signature is not an Apple-notarized release.
The ordinary OBS lab executable and installed Producer app are separate.

The app is installed in `~/Applications/Producer Speakerphone Lab.app`.
Launch it without arguments; its speech clip is bundled in Resources and runs
are saved under `~/Library/Application Support/Producer Guest RTC Lab`.
Neither location requires Documents-folder access. Explicit 48 kHz mono PCM16
speech WAV and output-directory arguments remain available for diagnostics.
No microphone is opened until Start and macOS permission. Exit other
Producer rooms, stop other audio, use built-in speakers/microphone, and begin at
50% system volume. A 60-second run has 5 seconds quiet baseline, 25 seconds
far-only, 20 seconds double talk, and 10 seconds near-only. Stop/close cancels
capture. Microphone audio stays local and is never sent to the speaker or LiveKit.

One AVAudioEngine owns input capture, the stereo source, final mixer tap and
output. The immutable source PCM is attenuated to 20% sample amplitude. The
reference is the actual final stereo mixer output, downmixed to mono; this first
lab requires a 48 kHz microphone and 48 kHz stereo output with system voice
processing disabled. It rejects unsupported formats instead of silently
resampling or substituting an earlier reference. Other applications' audio and
hardware-volume calibration are outside this engine's reference scope.

Each tap copies PCM into a 32-block SPSC ring, each block 10 ms. The 320 ms
capacity accommodates AVAudioEngine tap batches and startup; it is a safety
bound, not an intentional processing delay. The owner drains queued blocks
promptly. Maximum observed tap frame counts are reported. Callbacks
allocate no PCM buffers, run no APM, and perform no filesystem writes. A named
Rust owner drains render before capture and supplies the WebRTC APM reverse
stream. One additional microphone block can wait for render for at most 80 ms.
APM delay is estimated from device host timestamps, not synthetic echo delay or
claimed acoustic calibration. Invalid format/timeline, device configuration
changes, missing reference, timestamp regression and ring overflow stop the run;
no zero/arrival-time reference is substituted.

APM-on and APM-off process the same captured blocks with NS and AGC
disabled. Explicit high-pass filtering is requested off, but upstream AEC
enforces its high-pass filter by default. The current physical refinement
profile explicitly disables that enforcement once before starting capture,
while retaining AEC. New reports distinguish the explicit
request and AEC enforcement; historical `high_pass:false` fields were requests,
not effective processing status. Offline replay compares the default with
enforcement disabled before processing, while keeping AEC enabled in both. Local private files contain speaker-reference, raw microphone,
processed-on/off WAVs, device-time CSV and a report. Native queues retire after
engine stop, taps removal, observer removal and source detachment. Callbacks
capture shared state without a back-reference to the engine/owner, so the
ownership graph is acyclic. Observable weak-state expiry and active callback/
owner counts are recorded. The native self-test covers concurrent SPSC
accounting and injected failure after engine creation/source attachment; actual
hardware graph success/stop still requires a physical run.

Far-only power reduction is provisional: its 200 ms windows omit adaptation
and low raw level. User phase compliance, ambient noise, time alignment,
speaker volume and near-speech intelligibility need review before acceptance.
No run automatically sets `physical_aec_qualified` or `g1_complete` true. Repeat
at 50% and 75%, review double talk/near-only recordings, verify teardown and
compare with the speakerphone contract. LiveKit microphone publication, host
mix-minus, private-cue switching, device change recovery and other platforms
remain integration work.

First hardware attempt (`evidence/speakerphone-startup-overflow.json`) stopped
after 0.131 seconds: both eight-block rings had eight queued blocks and two
overflows, with zero consumed blocks and zero native format/timeline errors.
The microphone and speaker callbacks therefore delivered at least ten blocks
before the first pump. No AEC result was collected. The revised 32-block bound
is covered by a ten-block single-burst self-test and reports maximum tap frame
counts so the next physical run can distinguish callback batching from slower
consumer scheduling. Overflow remains a hard failure; no dropped audio is
accepted as a successful run.

Offline filter comparison: build `speakerphone_replay` with the same locked
external-archive linkage, then run `target/debug/speakerphone_replay
<completed-session-directory> <new-private-output-directory>`. It opens no
devices. It feeds the recorded ten-millisecond speaker/microphone blocks in
CSV order, with the recorded delays, into independent baseline and candidate
APMs. The candidate disables only AEC high-pass enforcement before processing.
The default constructor remains unchanged. Output WAVs and per-window statistics
stay in the private output directory. On both recorded runs the baseline
reproduced the physical processed output with zero PCM RMS error. The user reported the candidate sounded slightly better in the listening
comparison. It is selected for the next physical lab run; acceptance remains
pending compliant speech/echo testing and louder-speaker testing.

Current lab reports default output-device scalar volume snapshots immediately
before engine creation and after engine shutdown. Unsupported controls are
reported as null, never replaced with a guessed percentage. Snapshot reads do
not change devices or volume, and do not run inside audio callbacks. They do
not verify changes during capture or calibrate acoustic SPL. A headless
`--volume-snapshot` probe returned 6.25% on the current Mac (AppleScript's
rounded output volume was 6). The user had lowered volume after the preceding
run, so that later value cannot be assigned to the completed run.

Native I/O callback timing candidate (2026-10-10): launch the packaged app with
`open -na "$HOME/Applications/Producer Speakerphone Lab.app" --args --io-callbacks`.
The readiness text must say “Native I/O callback timing test.” The default mode
still uses engine taps. The candidate uses an `AVAudioSinkNode` connected to the
input's hardware-matching 48 kHz Float32 noninterleaved format, and an AudioUnit
post-render notification on output bus 0 for final device-bound stereo PCM.
Both copy into the existing fixed SPSC rings and reblock into contiguous 480
sample chunks. They never process APM, allocate PCM, publish or write files.
Unexpected formats, absent host-time flags, discontinuous partial chunks,
render errors and overflow stop the trial. System voice processing stays off.

The output notification's context borrows the owner's state; the owner holds
state through engine stop, notification removal and callback retirement.
Input/source/observer blocks capture state with no back-reference. Teardown
removes the configuration observer before stopping, removes the render
notification while its AudioUnit is still owned, and detaches input/source
nodes before releasing the engine. Native 20-cycle tests exercise both modes'
partial construction, real notification add/remove on a non-hardware mixer
unit, synthetic 512-frame microphone/stereo-reference reblocking, actual PCM
values/host continuity, post-render errors, empty registries and weak expiry.
Those tests open no microphone and play no sound. Actual engine I/O callback
buffer layout, cadence and timestamp semantics remain a physical test gate.

Reports label the selected mode, maximum callback frame counts (the legacy
`maximum_tap_frames` key), remaining notification count, and bounded minimum/
p95/maximum capture age at APM processing in the device host-time domain. That
age includes owner scheduling/reference wait and may be signed; it is not
calibrated acoustic delay or end-to-end RTC latency. Up to 6,100 observations
cover a 60-second trial. Repeat the standard deliberate-speech protocol at
50%, compare with the prior tap runs, and verify the new capture/reference
before changing the LiveKit publication diagnostic or claiming G1 acceptance.


## Native microphone to loopback LiveKit candidate

The transport binary built with `physical-aec` now has an explicit physical
publication path. It is disabled unless `LIVEKIT_LAB_PHYSICAL_CAPTURE=1`.
It requires an explicit `LIVEKIT_LAB_PHYSICAL_SPEECH` path to a 48 kHz mono
PCM16 reference WAV (at most 120 seconds) and existing microphone permission.
The transport still rejects every signaling URL outside its three exact
loopback fixture URLs. Missing permissions/reference or conflicting synthetic
batch flags reject before room connection. This path does **publish microphone
audio to the local SFU** when deliberately enabled; the ordinary speakerphone
UI still records locally and never publishes microphone audio.

The native engine/owner is shared with the measured speakerphone lab, including
250 ms startup quarantine and strict callback continuity. Its output reference
is still only the lab clip. The publisher thread processes native reference and
microphone blocks with the selected manual AEC profile, holds at most one mic
block for an 80 ms reference deadline, then feeds original capture timestamps
and cleaned PCM through the bounded publication handoff. SDK AEC/NS/AGC remain
disabled; SDK source queue is zero. Generated black video is a placeholder;
this is not camera/RTP synchronization proof or a full guest monitor reference.

On cancellation/error, the native device stops/removes callbacks, the handoff
retires pending voice, and the existing publisher owner joins the thread.
A submission that has left the handoff but has not confirmed SDK completion
is separately reported. No claim is made that the SDK can flush encoded voice.
The evidence records native lifecycle, handoff accounting, SDK submission time,
owner tick gaps and a bounded capture-to-SDK age histogram. The generated SFU
runner explicitly removes both physical environment flags, even when inherited
from a parent. It cannot be used to test this physical path accidentally.

The first deliberate physical-SFU run and guest/camera synchronization remain
pending; do not use this candidate for production or infer a full speakerphone
routing acceptance from the earlier standalone AEC tests.


The deliberate 20-second test runner is:

```sh
python3 native/run-physical-publication.py --publish-microphone
```

It owns/stops its loopback SFU and web server, launches the explicit physical
browser harness, saves unique success/failure conditions and observes inbound
RTP packet counts with exactly silent browser speaker output. No browser voice
recording is created. Without the argument it rejects before starting services.
Run only when the operator is prepared for local microphone publication.
The headless guest publishes generated media only. This test cannot establish
speakerphone behavior for real guest return playback or physical camera sync.


Physical publication now uses a disposable native absolute-wait owner thread
with an atomic stop flag. Due audio is submitted before processing a new mic
block; only one mic block is processed per turn. Each fresh generation maps
its capture host clock to an initial capture+25 ms deadline. The clock stays
fixed until that generation is explicitly retired. The SDK source still has
no external capture-timestamp argument, so this is not RTP/camera sync proof.

A publication deadline miss retires all pending audio and records that failed
generation. The AEC owner resets and stale input is discarded until a fresh
capture block can start the next generation. The 20 ms lateness limit and
queue/pacing bounds are unchanged. At most 32 retired generations are retained;
other faults and unknown SDK completion still stop publication. The browser
report distinguishes completed-with-recovery from a fault-free source. Recovery
can leave a brief audio gap and requires voice review; it cannot qualify a
private cue or prove the SDK's encoded queue is flushed.

For a longer deliberate diagnostic, use `--seconds 60` (allowed range 5–300).
Browser numeric stats are sampled once per second; voice is never recorded by
the receiver. The standalone speakerphone UI continues to use its local-only
recording path and is separate from this opt-in transport runner.

### Selected remote guest monitor prototype (2026-10-10)

The isolated RTC runner now supports:

```sh
python3 native/run-physical-publication.py --publish-microphone --play-guest --wait-for-start --seconds 60
```

This opens a visible browser with a Start speaker test button. Before that click,
only a generated remote speech fixture is published; native microphone capture
and speaker output have not started. The browser never opens its microphone,
plays the returning host microphone, or records received voice. The speech WAV
route is available only when this explicit monitor experiment is enabled.

Use built-in speakers/microphone, disconnect headphones and close other rooms.
Start near 50% volume. Stay quiet for the first 20 seconds, then speak over the
remote speech. This trial records numeric diagnostics only, not microphone PCM.
Human voice review needs a separate listening/recording trial.

Only `guest-1` remote audio enters the monitor. The source callback plays mono
PCM into both hardware speaker channels at 0.20 gain. The existing post-render
reference captures that final output and feeds the selected APM profile. The
local microphone is never inserted into the monitor queue. The old bundled
clip reference experiment remains the default without `--play-guest`.

RTC callbacks use a try-lock bounded inbox (eight 10 ms blocks, 30 ms maximum
age, reject overflow). One native owner transfers fresh blocks into a lock-free
SPSC hardware queue (eight blocks; owner targets at most three queued blocks).
Hardware callbacks allocate nothing and perform no SDK/APM/file calls. An
underflow produces silence. Native PCM older than 80 ms from decoded delivery
is retired, including a partially played block. These delivery timestamps are
not original remote capture timestamps and do not qualify AV synchronization.

Track replacement/unsubscription and reconnect invalidate the inbox generation;
the native callback also rejects old queued or partial generation PCM. This is
an application monitor bound, not an encoded SDK/private-cue privacy fence.
On reconnect, admission is suspended and queued PCM is retired. After the SDK
reports reconnection, a fresh sink/observer binds the current retained guest
track; a replaced subscription also receives a fresh generation. This prototype
does not mix multiple guests, room program audio, or private cues.

The final device lifecycle report includes native monitor pending blocks and
partial samples retired after callbacks stop. Inbox statistics are a shutdown
snapshot; the SDK observer may still report rejected old-generation callbacks
until the room removes its sink. Full room speakerphone AEC, voice preservation
through SDK recovery, and load/reconnect acceptance remain unqualified.

Monitor admission is now gated until native device creation/start succeeds.
Pre-device callback frames are rejected and counted separately, never queued.
After startup, only the current selected track generation can feed playback.
Stopping closes admission before native callback teardown. This avoids hiding
startup backlog in steady-state overflow counters; a follow-up physical trial
must measure the revised path.


### Reconnect fixtures

Add `--reconnect signal` or `--reconnect full` with `--play-guest` and at least
20 seconds. At five seconds the native host invokes the installed SDK's
`SignalReconnect` (close signaling and resume) or `FullReconnect` (new RTC
session) diagnostic scenario. These exercise SDK events against the actual
loopback SFU. They do not simulate WAN packet loss, server outages or an ICE
blackhole, and do not establish five-hour reliability.

Monitor admission closes on `Reconnecting`, including subscriptions arriving
before `Reconnected`. On resume the old selected sink is removed before a new
observer is installed with a new generation, even if the track SID is retained.
In-flight old observer callbacks retain their old generation and are rejected.
Once-per-second bounded progress snapshots prove actual native PCM consumption
continues after reconnection; the fixture fails if events or post-reconnect
playback growth are missing. PCM is never recorded. Snapshot times are relative
to the native device owner and room event times to room setup, so they are not
an exact reconnect-to-first-sample latency measurement.

A reconnect deliberately silences guest monitoring until the SDK reports
completion. It is not a zero-gap signaling-resume guarantee. Rebinding resets
application queues, not undocumented encoded/decoded SDK buffers; private-cue
privacy fences and upstream capture timestamps remain separate gates.

`--guest-rejoin` instead disconnects the generated browser guest after five
seconds, waits one second, then reconnects it with new publications. It is
mutually exclusive with `--reconnect` and also requires at least 20 seconds and
`--play-guest`. The fixture verifies changed guest audio publication SIDs and
subsequent native PCM consumption, not merely browser reconnection status.
The selected guest identity stays `guest-1`; this is not a roster/admission test.

### Private decoded voice listening review

```sh
python3 native/run-physical-publication.py --publish-microphone --play-guest --wait-for-start --voice-review --seconds 40
```

This opt-in records the browser's decoded native-host return as mono 48 kHz
PCM16 WAV, after native APM and LiveKit/Opus transport. It never opens the browser
microphone. The capture worklet outputs zero PCM; both the HTML return player
and analyser output remain muted. There is no second lossy encoding pass.

Wait for the visible Start 40-second voice test button. Use built-in speakers
and mic near 50%, close other rooms/audio and disconnect headphones. Stay quiet
for 0–10 seconds, talk over the remote guest clip during 10–30 seconds, then
keep talking during 30–40 seconds while the harness mutes only the generated
guest clip. On-screen instructions show elapsed time. Phases follow the harness
wall clock, not synchronized source/decoded capture clocks; exact acoustic
alignment/attenuation is not claimed.

Voice WAV/review manifest are saved exclusively under a unique mode-0700
`~/Library/Application Support/Producer Guest RTC Lab/voice-review-<run>`
directory, with mode-0600 files. Repository evidence contains numeric metadata
only. The runner rejects arbitrary output directories, symlink leaf directories,
non-private leaf permissions, missing explicit Start, recording longer than 60
seconds, and combined reconnect/rejoin capture. WAV serialization verifies PCM
format, sample/chunk limits and accounting; browser capture has its own 65-second
hard cap. Default physical and generated experiments still do not record voice.

The result compares speaking over guest audio with speaking alone. It is not a
raw microphone A/B comparison, a microphone calibration, or an A/V sync test.
Listening approval and actual speech during the instructed phases are required
before making a subjective voice-quality claim. Recording through reconnect is
a separate later trial.
