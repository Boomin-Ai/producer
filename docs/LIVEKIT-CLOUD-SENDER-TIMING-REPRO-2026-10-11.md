# LiveKit Cloud native guest timing: reproducible readiness gap

Status: the original sender-report readiness gap below remains reproducible.
An opt-in ACT candidate now passes the short Cloud timing test and the latest
full-reconnect readiness check; recovery recording coverage remains unqualified.
See [the current release status](./LIVEKIT-PRODUCTION-READINESS-2026-10-11.md).
This is a prepared diagnostic report,
not a submitted support ticket or public issue. No production room was changed.

## Observed behavior

Our Rust native receiver feeds selected guest audio/video into OBS using a bounded
audio-master timeline. It waits for validated current-publication RTP/NTP sender
maps. It does not use network arrival as sender capture time or reuse a retired
publication's map. The application prototype requires first scheduled audio and
video within 1.5 seconds of the earliest recovery reset; this is our acceptance
budget, not an asserted LiveKit Cloud service guarantee.

On Cloud trial `generated-recovery-1791757273637421000`, three generated browser
guests connected for 60 seconds. Only guest-1 was recorded. One native receiver
full reconnect was injected at about 12 seconds. Initial scheduling took
2.903/2.923 seconds for audio/video. After reconnect it took 9.968/9.992 seconds,
including preceding binding resets. The recording had 23 synchronized pairs,
43.333 ms absolute p95, and five missing numbered markers (9–13). Acceptance
failed and remains failed.

Within the final new binding, decoded audio arrived after 109.569 ms. The first
observed incoming video sender report arrived after 3.023 seconds; the first
incoming audio sender report for the bound downtrack SSRC arrived after
9.024 seconds. Audio clock readiness followed at 9.134 seconds. These are native
clock intervals, separate from browser clock origins. The fresh audio SSRC came
from the current inbound RTP stats; delayed observations are not labeled packet
loss without an exact receive trace.

The clock collector copied typed numeric reports from the existing bounded native
RTCP log. Its maximum collection took 129 µs, with no collector errors. Thus this
run's delay is not accounted for by full-JSON collection work. The temporary
Cloud room was deleted successfully. Credentials remained on the fixture server;
numeric evidence was scanned before retention.

## Reproduce

Use the isolated worktree's `labs/guest-rtc` directory on Apple Silicon macOS,
with the pinned installed Producer OBS/FFmpeg frameworks. Authenticate your own
existing test project using the LiveKit CLI. Keep keys out of command history,
reports and browser/native environment. With at least 2 GiB disk space:

```sh
LIVEKIT_LAB_LINK_EXTERNAL_ARCHIVE=1 cargo build --features obs-proof,physical-aec --bin producer-guest-rtc-lab
python3 native/run-cloud-generated-recovery.py --project YOUR_TEST_PROJECT --guests 3 --seconds 60 --reconnect full --require-obs-gates
```

The fixture owns a uniquely named temporary room and deletes only that room. It
publishes generated markers, not camera/microphone media. It requests room stream
synchronization and disables RED/DTX in the generated publisher configuration.
The native SDK is LiveKit Rust 0.9.4 with the checked-in timing-observation bridge;
the pinned WebRTC archive is unchanged. Current Cloud server revision/configuration
is unknown. A deliberately modified local SFU is a separate experimental target,
not a patch available in this Cloud project.

`native-typed-clock-cloud-trial.json` pins the exact binary and numeric evidence.
The corresponding local three-guest/two-reconnect run is pinned separately in
`native-typed-clock-local-trial.json`: 44 pairs, 60 ms p95, no missing markers,
initial readiness under 546 ms and recoveries under 666 ms. This comparison is
diagnostic, not a controlled network/provider latency guarantee.

## Questions for a provider or upstream review

- Is there a supported Cloud/native-client mechanism to request fresh audio and
  video downtrack sender reports promptly after subscription or full reconnect?
- Is the observed audio-report delay expected under stream synchronization and
  downtrack SSRC rewriting, or does this trace identify a configuration or version
  issue? What additional upstream report trace is needed to distinguish them?
- Is there a supported per-frame native audio timestamp tied to the same validated
  presentation timeline as video that avoids dependence on periodic report arrival?
- Which service/client timing guarantees can this application safely rely on?

LiveKit documents full reconnect as a disruptive rejoin with new publications;
it does not promise our 1.5-second recovery budget. See the official
[connection lifecycle](https://docs.livekit.io/intro/basics/connect/).
Any preparation phase or revised budget must be reviewed explicitly. It must
keep private media gated, invalidate clocks on authority/publication changes,
and preserve the failed cold-start/recovery evidence. No acceptance threshold
has been relaxed to treat the Cloud trial as passed.
