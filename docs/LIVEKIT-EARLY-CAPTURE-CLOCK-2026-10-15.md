# Earlier native guest timing experiment — October 15

Status: isolated debug candidate. Not enabled in production or release builds.

The shipping receiver waits for usable sender reports to label decoded audio and
video on one sender timeline. The latest baseline spent 4,146 ms between first
decoded video and first native ingest. This experiment negotiates the existing
absolute-capture-time extension in both native and browser transceivers, using
WebRTC APIs rather than SDP rewriting.

The native experiment uses normalized packet capture metadata for the exact PCM
RTP position and video frame, subtracting the capture-clock offset. Audio mapping
is bounded to 200 ms, resets on source generation/SSRC changes and binding clears,
and quarantines a timestamp discontinuity until a consistent packet arrives.
There is no arrival-time substitute and no mixing of ACT and sender-report
origins within an experimental session. Existing permission checks, backstage
program-audio exclusion, queue limits and output epoch fencing remain in force.

Enablement requires a debug build with PRODUCER_RTC_CAPTURE_CLOCK_PROOF=1 and
LIVEKIT_LAB_CAPTURE_EXTENSION=1, plus the isolated browser negotiation probe.
The native capture-clock module and scheduling override are absent in release
builds. No C++ observer/owner/thread or production browser code was added.

Validation: 38 runtime tests pass, including bounded interpolation, generation
retirement and discontinuity quarantine. Numeric cloud trial evidence is recorded
separately. Startup delivery is not proof of lip sync, marker coverage, physical
microphone/camera performance or cross-browser support.

Before release: recorded correlated input markers through the actual native
receiver; disconnect/rejoin and missing-metadata behavior; a defined safe fallback
for browsers without this extension; supported browser negotiation integration;
and a measured cold-start distribution. Sender-report synchronization must remain
available for unsupported publishers without mixing its clock domain into an
already running capture-clock timeline.

Observed startup results (two sequential Cloud trials): decoded-to-ingest was
827 ms and 1,240 ms, versus the preceding baseline's 4,146 ms. Admit-to-native
GPU thumbnail was 8,143 ms and 7,905 ms, versus 11,466 ms in that baseline.
First video scheduling preceded sender-report readiness by 2,360 ms and 2,260 ms.
Both native fixtures and browser stage/removal checks passed. These are small,
uncontrolled samples; initial decoding still took 7,110 ms and 6,461 ms from
Admit start, so this does not establish a 1–3 second cold-start experience.
