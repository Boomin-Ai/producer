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
