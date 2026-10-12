# Native guest subscription checkpoint

The staging native host now owns a LiveKit connection and subscribes only to tracks authorized by an independently authenticated room authority snapshot. Snapshots expire within 3.5 seconds, bind the current host connection and run, and match each guest identity, authorization generation, and permitted media source. Duplicate or stale publications fail closed.

The owner serializes lease renewal and authority reads. A room revision conflict permits one independently validated refresh and retry; it never reclaims another host. Shutdown retires the media sink before closing the SDK room. Dropping a pending owner signals cleanup rather than cancelling SDK initialization.

The actual browser guest and LiveKit Cloud staging test passed admission, stage placement, camera-only microphone withdrawal, microphone restoration, removal, and owner shutdown. Removal cleared all owned tracks in 846 ms. Five attached tracks across authorization generations were retired; the sink closed once and the run ended. See `evidence/native-guest-subscriptions-2026-10-12.json` for numeric results and source hashes.

The browser permission parser now accepts narrowed camera-only, microphone-only, and receive-only grants. It publishes only permitted tracks and checks subscription authority separately. This fixes camera-only recovery after host mute.

The original subscription checkpoint retained SDK tracks in a proof sink. The receive checkpoint below extends it to timed decoded media and the actual OBS ingestion boundary. Production remains unchanged.

## Native receive and recovery checkpoint — October 12

The native runtime now drains timestamped PCM, observes owned video tracks, binds each receiver's SSRC from SDK stats, and qualifies sender-report mappings before scheduling media. Queues are bounded; stale permissions, ambiguous bindings and retired SSRCs stop delivery. Shutdown unregisters video observers and joins stats/delivery workers. A temporary missing stats result does not permanently quarantine a still-owned SSRC, but it disables delivery until independently rebound.

The app's receiver opens only existing native guest source endpoints. Its endpoint epochs fence older deliveries, and OBS copies frames/audio synchronously. Opt-in native start/stop IPC retains credentials in Rust and restricts this build to the isolated staging endpoint. Room restoration and application exit close the guest owner before rebuilding or shutting down the engine. Ordinary room UI still selects the legacy guest path: these IPC seams are not a completed user flow.

The latest actual browser guest + LiveKit Cloud + native OBS copy proof passed admission, stage placement, camera-only mute, pair restoration, removal and shutdown. It submitted 66 video frames and 451 audio blocks. Camera recovery after mute took 4,795 ms; camera/microphone recovery after unmute took 4,653 ms; removal cleared owned tracks in 1,056 ms. Final observer/worker counts were zero, the sink closed once, and the hosted run ended. Numeric evidence and source/binary hashes are in `evidence/native-obs-receive-recovery-2026-10-12.json`.

Earlier repeated proofs exposed a terminal HTTP 404 on old-identity retirement. Staging now preserves numeric HTTP status through durable SQL settlement and retries 404 within the existing failure budget. A 404 never counts as successful revocation: the same immutable identity must subsequently receive successful explicit-cutoff removal and verified absence. The latest successful live run used first-attempt cleanup, so its result does not separately demonstrate a live 404 retry. Focused provider tests cover the failed-then-successful sequence.

Read-only authority refreshes now have a 2.5-second request deadline and at most two transient retries. The separate 3.5-second media permission expiry remains unchanged; retries never refresh old permits. Rejections and invalid authority remain fatal. The test harness now publishes numeric reports atomically and collects bounded, development-only browser phases; interrupted report reads previously could abort the test and close Chrome before recovery finished.

Validation: 28 runtime Rust tests, 45 focused API tests, seven browser authority tests, frontend type checks and the pilot native app compile check passed. The app check retained nine existing warnings. This is an ingestion-boundary proof, not a rendered-room or end-to-end audiovisual synchronization proof. Remaining work includes ordinary room source/control integration, host return publication, speaker-reference/AEC integration, recovery UX and release/signing qualification. Mute/unmute still interrupts camera delivery for several seconds. An ambiguous startup request can leave an expired hosted run requiring the existing fenced reclaim flow; ordinary-room startup recovery is not yet wired.
