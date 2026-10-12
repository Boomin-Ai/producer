# Native room endpoint — October 12, 2026

`guest-rtc-pilot` now registers the existing native async AV ingest type in the
ordinary OBS engine. The opt-in `RtcGuest` scene specification requires its
stable source ID to equal `guest-<participant UUID>`. It uses the ordinary guest
transform, mixer, metering and visibility paths. A new source starts hidden and
muted, reaches the audience bus only after normal stage controls unmute it, and
is excluded from the stage-return bus by the existing remote-audio policy.

`rtc_ingest::Endpoint` retains an OBS reference under one delivery/retirement
gate. The graph holds its owner and the registry holds weak references. A
publication replacement clears pixels and invalidates old delivery handles;
source removal retires the endpoint before releasing the graph's reference.
Concurrent writers cannot cross that retirement. A late old retire cannot
unregister a replacement at the same stable ID. Invalid/duplicate timestamps
and malformed media are rejected; no arrival timestamp is invented here.

[The standalone real-engine proof](./evidence/rtc-native-endpoint-2026-10-12.json)
passed 20 create/replace/retire cycles, concurrent delivery during retirement,
owner expiration and partial initialization checks. It uses generated frames
and opens no camera, microphone, network or playback device. Reproduce with
`python3 scripts/test-rtc-ingest-native.py`; the installed engine framework is
used only for linking and execution. The Tauri application also passed
`cargo check --locked --features guest-rtc-pilot` with the installed engine.

This is an endpoint, **not a connected native room**. The regular room still
needs the SDK owner, independent guest/run/generation bindings, synchronized
bounded delivery, authenticated host lease/control lifecycle, program capture,
processed mix-minus return, and actual speaker-reference/AEC wiring. None of
those owners is created by a scene ID or by this registry. Existing native dev
and production binaries have not been replaced by this change.

The separate real public guest page now passes a hosted generated-media call
against the native SDK lab, including removal while the host stays connected.
That proof is in Boomin web's `docs/LIVEKIT-GUEST-HOSTED-MEDIA.md`; it does not
establish normal-room AV/AEC, pass the outstanding G1 timing gates, or qualify
production rollout. No physical test is requested yet.
