# Hosted LiveKit launch — 2026-10-14

Install the Apple Silicon download from https://producer.dev/download/macos and open **any Boomin-hosted room**, including AIC, Producer Demo, or a newly created room. Home synchronizes this server room automatically. No shell flags are required. All hosted rooms advertise LiveKit capability. Opening a room with this native-capable build adopts LiveKit. Rooms still opened by older clients retain legacy transport until native adoption; no SDK is assumed to exist in an old installer.

The production API has RTC migrations 0170–0183, scoped LiveKit credentials, fenced host/guest control and a retirement Durable Object. The hosted guest bundle is deployed to boomin.ai and served through producer.dev. Release v0.4.69-livekit.2 includes the production-enabled Apple Silicon runtime; its app and DMG are Developer ID signed, notarized and stapled. The public installer hash matches the verified CI artifact.

The automatic production proof connected a native OBS host to LiveKit Cloud, admitted a synthetic browser guest, recorded program audio/video at 1280×720, applied stage control, revoked the guest and completed host teardown. The room is empty after the proof; all five retirement operations succeeded. API typecheck, 1,123 API tests, infrastructure coverage, web build/reconnect checks and native production routing checks passed. This is not a physical device, native UI, AEC or full mix-minus qualification.

Known limitations: a host SDK reconnect still requires leaving and reopening the room. The recorded return video leads audio by roughly 0.2–0.3 seconds after startup (production absolute p95 313 ms). Integrated native speakerphone AEC and the complete guest mix-minus path remain unqualified. Windows, Intel macOS and Linux do not gain the native guest refactor in this release. Stable auto-update remains unchanged; install this candidate explicitly.

Evidence: [production smoke](evidence/hosted-livekit-production-smoke-2026-10-14.json), [publication](evidence/hosted-livekit-production-launch-2026-10-14.json).

The one-room rollout restriction was removed in API commit c72ffccb28e573ead2f546263fad591c20587100 (Worker e4bd9b49-28d8-47eb-8c73-d77bc647fdc7). All 1,130 API tests and CI pass. Existing room capabilities and an end-to-end new-room production run were verified. [Broad rollout evidence](evidence/hosted-livekit-all-rooms-2026-10-14.json).

## Guest conversation audio rollout

On October 14, the hosted API and browser runtime gained direct microphone-only subscriptions between independently authorized on-stage guests. Each guest excludes its own identity. Backstage cameras remain host-only; backstage guests do not enter the stage conversation. Host/media return audio remains on the separate program bus, which excludes remote guest voices. Hide and revoke remove peer playback and narrow publisher subscription permissions. Older cached guest pages retain the original response schema unless they explicitly request the stage-audio roster.

Production API main `570510061c0dcaf2fe9908acf60589f353aa8765`, Worker version `48333192-315c-45a0-8f60-6f985a6b60c0`; web main `3072d0b7dbe7fd222cad218713dcfa7a812cd29e`, deployment run `38581465794`. All 1,135 API tests, 18 browser policy/lifecycle/startup tests and the production browser build passed. A generated-tone two-browser LiveKit Cloud proof verified backstage silence, mutual stage audio, hide, restage, revoke, and cleanup of its temporary production room. See `docs/evidence/hosted-livekit-conversation-production-2026-10-14.json`. This proof does not qualify physical speakerphone AEC, private cue, or automatic native recovery.
