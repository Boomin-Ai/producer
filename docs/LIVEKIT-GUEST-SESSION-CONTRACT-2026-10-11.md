# Native guest session boundary — October 11, 2026

**Preparation only; ordinary guest links still use legacy transport.** No route
is wired to the new signer, no database migration was applied, no pilot is
activated, and no native release/signing/notarization was performed.

## Implemented boundary

The API work lives in the isolated `feat/livekit-guest-session` worktree of
`Boomin-Ai/api`, based on `07991fe`. It builds a version-1 ephemeral manifest
from server-side authorization facts and signs a short-lived, scoped LiveKit
JWT with Web Crypto. Signing credentials stay server-side; clients receive only the
join token. Join credentials are not part of a set or persisted invite URL.

The manifest carries logical brand/room/run/participant IDs, role, public stage
or participant-specific private scope, producer lease epoch, control revision,
authorization generation, provider room, provider identity, configured Cloud
endpoint, issue/expiry time, publish-source permissions and subscription intent.
Its maximum lifetime is 120 seconds and never exceeds the host lease or guest
admission deadline. JWT second precision rounds expiry down, never up.

Only a current producer lease holder may mint the program publisher policy.
Accepted guests need an active admission and either stage membership or their
selected private room. An offstage guest cannot publish preview in the stage
room. Monitors cannot publish or enter private cue rooms. Data publication,
room admin and client metadata modification are disabled. Private producer
publication permits microphone talkback only, not the public program or screen.
These policy checks are not substitutes for a coordinated durable resolver.

`crates/guest-session` is the production Rust consumer. It checks a manifest
against independently held authenticated authority, rejects foreign/stale
room/run/participant/role/scope/lease/revision/generation/permissions, verifies
canonical provider room and identity, bounds response/token size and lifetime,
and restricts endpoints to the configured exact Cloud WSS origin. Tokens have
redacted Debug and no Serialize implementation. Parse errors omit input data.
JWT signature enforcement remains LiveKit's responsibility.

Provider identities include lease and authorization generation. The saved
canvas binding retains Producer's existing `guest-<participant UUID>` ID;
monitors and the program publisher never produce guest source IDs. This proves
the logical binding rule, not an attached native source retaining its effects
through a running-room reconnect. Stage/private track handoffs still need
generation fencing, queue cleanup and applied output authorization.

The app's inactive `guest-rtc-pilot` feature exposes this crate; the native lab
reuses its Cloud endpoint validation. The same synthetic JSON fixture is pinned
in both repositories. Neither the app nor the lab's transport loop currently
obtains normal-room credentials from this issuer. A small native checker
validates live server-issued manifests without accepting secrets on argv.

## Validation and exact scope

- Nine Rust boundary tests and Clippy with warnings denied pass.
- Fifty relevant API tests pass, including the new policy/signing tests and
  existing admission/room access tests. API type checking passes.
- PostgreSQL/PGlite executes the actual production grant-update SQL: two stale
  callers' independent toggles preserve all keys and unrelated metadata;
  malformed override maps recover; revoked/ended/declined/deleted rows reject
  updates. PGlite serializes one connection, so this is not proof of concurrent
  Neon transactions or the RTC outbox protocol.
- The separate permission fix merges one key against the current database map,
  replacing the previous merge against an earlier route snapshot. It does not
  establish a room control revision, admission/stage atomicity or provider
  reconciliation.

Cloud evidence `guest-session-cloud-1791780177345685000.json` joins three Chrome
SDK connections using the actual API signer's tokens. The shared native checker
accepts all three against the expected test authority. Cloud's returned
permissions confirm producer/guest camera+microphone sources, receive-only
monitor, disabled data and metadata updates. Monitor room administration gets
HTTP 401. After disconnect and an explicit Cloud revocation cutoff, the original
monitor token fails with an SDK authorization error and HTTP 401/403, rather
than an undifferentiated network failure. All owned rooms are deleted. The
checkpoint `labs/guest-rtc/evidence/guest-session-boundary-checkpoint.json` pins
current source hashes and retained results.

This uses generated IDs and trusted test authority, not the production database,
existing invite routes or a native media session owner. No media was published,
physical device opened or sound played. It does not test a malicious publication,
SDK-refreshed token replay, same-second issuance races, private handoff or a
complete conference. Explicit cutoff behavior follows the primary
[LiveKit participant documentation](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/).

Two earlier smoke failures are retained. The join succeeded, but the smoke
read permission response fields as camelCase while Cloud returned snake_case;
the corrected reader supports both. They are fixture assertion failures, not
proof that the issuer's grants failed on Cloud. The first lacked detailed
permission receipts; the second records the HTTP 200 lookup and misread fields.

## Next integration work

1. Persist run-pinned transport and separate producer ownership/lease. Resolve
   accepted admission, grants, stage/cue scope and current revision through one
   coordinated authorization path. Mod permissions must not imply producer
   publication ownership.
2. Reserve/finalize issuance with the authorization revision; discard tokens
   when a racing revoke/grant/host change wins. Durably enqueue and reconcile
   provider retirements so a token already returned cannot remain authorized.
   Cover admission/grant/stage/issuance/reclaim races and original/refreshed token
   replay. A post-signing CAS alone cannot revoke returned tokens.
3. Wire capability/cohort selection into normal host and guest routes, leaving
   older hosts and existing runs pinned to their assigned transport. Return
   secrets only in noncacheable authenticated responses.
4. Attach the SDK session owner and track generations to persistent guest source
   IDs; connect H+M program return, direct other-guest audio and the actual final
   speaker reference. Retire old generations before private/public handoff.
5. Resolve the existing G1 startup/recovery coverage failures, qualify the full
   conference, then do the normal device/soak/canary and signed release gates.

The status is progress toward G2/G3 preparation, not completion of G1/G2 or the
50% product milestone. [Production readiness](./LIVEKIT-PRODUCTION-READINESS-2026-10-11.md)
continues to record the unresolved native timing and rollout gates.
