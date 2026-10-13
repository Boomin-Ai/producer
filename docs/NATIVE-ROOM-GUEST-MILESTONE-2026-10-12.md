# Native room guest milestone — 2026-10-12

The isolated pilot now connects the normal room roster and controls to the native LiveKit owner. Saved guest source keys keep their layout while binding the full participant identity to the native OBS receiver. Production activation remains disabled.

## Verified

- Frontend identity/admission boundary: four checks, including colliding short source IDs. Existing room-session teardown check passes; frontend build and TypeScript checks pass.
- Native OBS graph conversion preserves position, size, visibility, volume and mute, exposes the full native identity, and unregisters the endpoint on removal. Real bundled image-source plugin used.
- Native app unit suite: 63 passing and five explicit native-device tests ignored; the graph conversion test was separately executed and passed.
- All 28 guest-runtime tests pass.
- Nine guest-session tests pass, including rejecting program publication by a monitor.
- Generated OBS landscape program travels through the actual native publisher and LiveKit Cloud to the existing guest page. The 60-second forced-stall run passed with 1280×720 video, rendered frame callbacks, synthetic audio, room controls and clean shutdown. See [numeric evidence](evidence/native-program-return-recovery-2026-10-12.json).
- A deadline fault stops capture and clears queued audio, removes only this connection's own audio/video publications, independently validates authority, then publishes a fresh pair. Read-only transport failure has one bounded retry. Mutations are not blindly replayed. Recovery is limited to three attempts in a rolling minute; other faults close the owner.
- Staging now supports authenticated normal-room session, identity, channel-list and access reads. Native mode detection derives the API origin from the normal Producer-contract endpoint URL. Existing write and room allowlists remain enforced. API pilot tests: 35 passing; type-check passes. Live checks return 200 for the three reads, 404 for another room and unsupported submission writes.

## Limits and next gates

Three publisher recoveries were needed in the passing minute, including the deliberately injected 120 ms stall. That demonstrates replacement but does not qualify uninterrupted production performance. Room controls took about 4–6 seconds. Longer runs and scheduling/control latency still need work.

The generated picture and tone do not measure audiovisual alignment. The user opened the normal native staging room successfully and its native RTC owner became active. The initial channel-list rejection was identified and fixed in staging. An end-to-end guest admission/placement test through that UI remains pending. Final speaker-reference host AEC, direct audio between guests, private cue destination switching, portrait program capture and screen/mod media are not integrated into this return path. The current stage audio bus excludes all remote voices.

The dev bundle uses `ai.boomin.producer.rtc-pilot`, its own SQLite data directory and a unique staging endpoint keychain entry. Its explicit debug-only bootstrap rejects the production identifier before opening a database. It is signed with the available Apple Development identity; it is not a notarized distribution release. Neither installed production Producer nor users' sets/media were changed.

Temporary-directory cleanup removed the previous build and private test fixture. Build artifacts now live in `~/Library/Caches/producer-rtc-build`; private staging authorization is stored with restricted permissions under `~/Library/Application Support/Producer RTC Pilot`. The staging-only JWT signing key was restored by rotation; production secrets were untouched.

2026-10-13: Expired same-account native host recovery passed disposable PostgreSQL guards and the actual native OBS → LiveKit Cloud → browser guest test. Recovery waited for verified retirement, preserved the run, advanced the host epoch, delivered return audio/video and ended cleanly. Evidence: `docs/evidence/native-expired-host-recovery-2026-10-13.json`. The staging worker is version `81552896-e2c4-4cd1-97fb-8130220903c7`; production remains unchanged. Publishing still required three deadline recoveries during the test and is not production-qualified.

2026-10-13 publishing follow-up: time-constrained macOS scheduling plus a shared 200 ms A/V publishing lead eliminated deadline recoveries in two full-minute tests. A deliberate 120 ms stall still caused exactly one recovery. The change adds 80 ms local buffering. One separate concurrent capture failure and an inconclusive Metal-init load test remain unqualified; see `docs/NATIVE-PUBLISHER-SCHEDULING-2026-10-13.md`. Native-room AEC and production release gates remain open.
