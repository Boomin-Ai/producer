This is an isolated G1 diagnostic experiment, not a deployment fork.

`python3 native/build-sfu-lab.py` downloads checksum-pinned macOS arm64 Go
1.26.0 and LiveKit v1.13.9 source at the immutable commit recorded in
`evidence/sfu-build-provenance.json`. It applies `native/sfu-cadence.patch`,
checks the changed files, runs the cadence helper test, and builds only under
ignored `runtime/`. `--prepare-only` verifies preparation without compilation.
Keep at least 1 GiB free; compilation may require more. The helper test does
not replace the full server build or media tests.

The default subscriber sender-report interval stays at three seconds.
`LIVEKIT_LAB_FAST_RTCP=1` selects 250 ms; this increases report cadence by
12 times for every subscriber on this test server. It does not bypass the
publisher-report prerequisite or change RTP/NTP mapping. No production
default is proposed by this experiment.

Use the same built executable for both comparison arms, with
`LIVEKIT_LAB_RTCP_TRACE=1`, `--dev --bind 127.0.0.1
--rtc.enable_loopback_candidate --rtc.tcp_port 0`. Only the faster arm sets
`LIVEKIT_LAB_FAST_RTCP=1`. The public upstream dev credentials are for these
loopback fixtures; no Cloud API key or production room credentials are used.

Both recorded arms use three synthetic guests, three guest-1 rejoins,
45-second recording, the audio-jitter relay, and identical native opt-ins:
first-report bootstrap, extended video buffer, scheduled audio-master handoff,
packet/pipeline probes, and diagnostic finalized MP4. Do not run compilation
or decoder analysis during recording. Stop only the owned lab listeners.

After both runs, `python3 native/analyze-sfu-startup.py` correlates the first
received report with publisher trace records by downstream SSRC and checks
that a single publisher track owns that SSRC. Receiver epoch intervals use
one monotonic clock. Sender NTP advancement uses one sender clock; it must
not be described as an exact SFU hold or network propagation latency. SFU
wall time is not subtracted from the native receiver's monotonic time.
The native milestone history remains bounded at 64 entries and preserves
the first report's SSRC, RTP timestamp and sender NTP even after later polls.

Run native recording analysis, independent FFmpeg audio decoding, and queue,
packet, discovery and source-retirement verifiers before reporting outcomes.
Keep failed timing evidence. Neither arm proves physical speakerphone AEC,
internet behavior, LiveKit Cloud behavior, cross-platform packaging, or G1.

The later early-report experiment uses `--early-report` to additionally apply
`sfu-early-report.patch`, verified by `sfu-early-report-provenance.json`, and
build `runtime/livekit-server-early-report-lab`. Both comparison arms use this
executable with faster downstream cadence; only the enabled arm sets
`LIVEKIT_LAB_EARLY_AUDIO_SR=1`. This policy owns no thread, queue or timer:
the existing audio buffer lock protects at most three attempts during one
second, spaced by 250 ms, and a received report permanently stops requests.
The actual recorded experiment emitted only one request per audio track.
The retry timing is a diagnostic stress choice, not an accepted RFC 6051
deployment policy; the RFC permits a repeat once per RTCP reporting interval.
Any supported follow-up must use one request or obey that interval.

This experiment failed startup acceptance: the initial selected guest never
scheduled audio before its rejoin, and rejoined audio took 6.1 seconds. Preserve
the result even though its later recorded marker pairs pass the local sync gate.
The SFU requested the first report about 90 ms before each audio downtrack was
added. The inspected AddDownTrack path does not seed its cached publisher SR.
That source finding and event order motivate testing subscriber initialization;
buffer receipt was not separately instrumented, so they do not prove every hop.
The control was a 30-second one-guest republish run. A preceding three-guest
control failed ENOSPC, has no native completion report, and is excluded.
