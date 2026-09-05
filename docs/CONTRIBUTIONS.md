# CONTRIBUTIONS — the open-server view

Status: POINTER, 2026-09-04. The full design lives in the Boomin api repo as
[`api/docs/CONTRIBUTIONS.md`](https://github.com/Boomin-Ai/api/blob/plan/contributions/docs/CONTRIBUTIONS.md)
(*Rooms, Participants, Contributions*; lands on `main` with
[api #388](https://github.com/Boomin-Ai/api/pull/388), its draft migrations are
[api #389](https://github.com/Boomin-Ai/api/pull/389)). This page is the part
of it that the open server and the desktop app own, in the open server's own
nouns.
Companions: `docs/INTERACTIVE.md` (interactions, audience runtime, transport),
`docs/LIVE-REVIEW.md` (the room as it stands), `server/README.md` (the open line).

## Four nouns, no others

The open schema says **participant, grant, contribution, interaction**. It never
says brand, deal, or wallet. If a table here ever needs one of those words to
make sense, the line has been crossed.

| Noun | What it is | Where it lives today | What it gains |
|---|---|---|---|
| **Room** | A protected space with a run history. One deployment = one host. | `rooms` (D1) | nothing new |
| **Participant** | An identity *in a room* for the life of a run. The relationship, not the person. Polymorphic by `kind`. | `live_room_guests` (D1) — the roster | `kind` (`visitor` \| `producer` \| `audience`; `member` and `connection` exist only on Boomin and are refused here) and `grants` |
| **Grant** | A capability a participant holds: media, input, control. A *role* (guest, contestant, audience, mod) is a named bundle the host picks. | nothing for guests; the `primary` token is the host | carried on the participant row, sealed into the capability token when it is minted. Revoke the row and the token is dead at its next exchange. |
| **Contribution** | *Who* supplied *what*, *from when to when*, *where on the set*. Presence on stage, a screen, a logo, a vote, a typed line. One shape. | the stage clock on the guest row (`stage_since`, `stage_seconds`) | an interval ledger (`contributions`) with a `kind` and a render `binding`; the stage clock is its first row kind, the guest-row columns become a cache |
| **Interaction** | A typed prompt with a lifecycle: `open → collecting → revealed → closed`. Inputs are contributions. | nothing | one object with a typed payload, authoritative in the room's Durable Object, outcomes persisted |

### Grants (the bundles a host picks from)

| Family | Grant | Guest | Contestant | Audience | Mod |
|---|---|---|---|---|---|
| media | `media.camera`, `media.mic` | yes | no | no | host's choice |
| media | `media.screen` | **no — the higher grant** | no | no | host's choice |
| media | `media.return_feed` | yes | yes | no (they watch the stream) | yes |
| input | `input.vote`, `input.text`, `input.hand` | yes | yes | vote + text (via the mod queue); no hand | yes |
| control | `room.admit`, `room.stage`, `room.mute`, `room.remove`, `room.interactions` | no | no | no | yes |
| control | `room.end`, `room.settings` | no | no | no | **no — host only** |

The self-host server has no accounts, so a *mod* is a capability the host hands
out (a shared mod link), never a login. Boomin maps the same bundles onto its
member grants; the desktop app renders one DTO for both.

### Contributions (the ledger the open server keeps for its own reasons)

```sql
-- same shape on the open server (D1) and on Boomin
contributions
  id, room_id, run_id, participant_id
  kind        presence | media.screen | overlay | input | credit
  binding     json    -- slot id, lane, corner, interaction id
  started_at, ended_at (null while open)
  source      host_stage | participant | interaction | host_credit
  metadata    json
  UNIQUE (participant_id, kind, started_at)   -- retries never fork an interval
```

Rules the clock keeps: the host's stage list is authoritative and
server-owned; the server stamps time, a client never asserts a duration;
intervals are append-only (close by appending an end); an open interval
self-expires against the host heartbeat. A contribution needs no deal — the
roster, the run report, the recording's chapters and later the auto-clips are
why this ledger exists here at all. **No money routes, ever.**

### What the contract gained (Phase 1, built)

Every route the contract-first PR stubbed is now implemented on
`producer-server` (`x-status: implemented` in `server/contract/openapi.yaml`;
`server/src/stubs.ts` keeps the gate for any future documented-unimplemented
route, and `test/stubs.test.ts` pins that none of these answers 501 any more).

**Participants (#46).** `live_room_guests` carries `kind` (`visitor` |
`producer` | `audience`; backfilled `visitor`), `producer_ref`, `grants`
(JSON; `NULL` = the default guest bundle) and `seat` (`guest` | `control`).
Join and invite accept `producer_ref` (→ `kind: producer`); `member` /
`connection` are refused with `422 network_unavailable`. `POST
guests/{id}/grants {grant, enabled}` flips one grant. The bundle is sealed
into every 120-second ticket (`claims.grants`) and re-read from the row at
each mint **and** at each signaling CONNECT; the signaling DO refuses a screen
peer from a guest without `media.screen`. A row with no media grant gets no
`render_url`. Existing deployments: `wrangler d1 migrations apply producer`
(`server/migrations/`).

**Mods (#47).** A mod on a single-user server is a *capability*, not a login:
`POST rooms/{id}/mod-link` mints a control seat (`kind: producer`, `seat:
control`, grants `room.admit, room.stage, room.order, room.remove,
room.interactions, room.scene`, no media, never on the roster — `GET
rooms/{id}/mods` lists seats) and returns `{origin}/connect/mod/{code}` once.
Producer opens it (Home → account menu → *Open a mod link…*) and gets a
control seat: the roster (admit / remove / stage / order through
`/v1/connect/mod/{code}/*`, each gated by its grant, stage read back from the
server) and the scene list with the active scene lit. Scene cuts are
**frames** on the room's Durable Object channel, never config:

```
host → DO      { type: "scene.publish", scenes: [{id,name}], active_scene_id }
DO → controls  { type: "scene.state", scenes, active_scene_id, version, server_now }
mod → DO       { type: "scene.cut", scene_id, transition? }          needs room.scene
DO → host      { type: "scene.cut", scene_id, transition?, from, server_now }
DO → mod       { type: "scene.cut.ok", scene_id, server_now }
             | { type: "error", code: "forbidden", status: 403, grant: "room.scene" }
             | { type: "error", code: "unknown_scene", status: 422, scene_id }
```

The host's Producer applies a cut exactly as its own keypress (same
transition, same stinger rules), persists `active_scene`, and republishes.
`GET rooms/{id}/access` answers the host stub for the primary token.

**Contributions (#50).** The `contributions` table (shape above; interval
stamps are milliseconds so a guest who leaves and returns inside a second
never collides on the UNIQUE). The stage publish opens/closes `presence` at
the same instant as the stage clock (`stage_seconds` = summed closed
presence); the guest page reports `media.screen` (`POST
/v1/connect/guest/{code}/share {active}`); a host source with a binding
(Producer: the © button on a visual source sets `{sponsor}`) publishes
`overlay` show/hide (`POST rooms/{id}/overlays`); an interaction's inputs
land as **one aggregate `input` row per participant kind**, never a row per
phone. Open intervals self-close when the host heartbeat lapses (minute tick,
`ended_at` = last seen + the presence window). Runs bracket a show: `POST
rooms/{id}/runs {action: start|stop}` — Producer starts one at go-live, stops
it at End and opens the **Run report** sheet from `GET
rooms/{id}/contributions?run_id=`.

**Interactions (#51).** One `interactions` row per interaction (envelope at
open, `result` at reveal/close) and a `RoomState` Durable Object per room
that is authoritative while it is live: the tally (aggregates + a capped set
of salted identity hashes so `once` holds), the reveal alarm, the phones'
hibernating sockets. `revealed` is only ever set by the server — at once for
a reveal with no hold, by the alarm at `reveal_at` otherwise; a client naming
`revealed` is a 400. Every frame carries `server_now`; a phone's cooldown is
a server timestamp, never a local countdown. Projection is per role
(`server/src/interactions/project.ts`): the audience never receives a running
tally or raw inputs. The audience door is `/a/CODE` (4 consonants, minted by
`POST rooms/{id}/audience-link`, resolvable only while the host is present):
`POST /v1/connect/audience/{code}/token` mints a per-device capability (`aud:
audience`, 12 h, `sub` = a hash of device + room so a reload keeps its
identity); inputs are `POST …/audience/interactions/{ix}/inputs` (bearer =
that token) and `POST …/guest/{code}/interactions/{ix}/inputs` (`input.vote`).
Frames:

```
room channel (host control socket subscribes interaction:host; guest room socket interaction:guest)
  { channels: ["interaction:host"],  action: "interaction", payload: Interaction }   running tally
  { channels: ["interaction:guest"], action: "interaction", payload: Interaction }
audience socket (GET /v1/connect/audience-signal?token=, read-only)
  { type: "snapshot", interactions: Interaction[], server_now }     on connect
  { type: "interaction", interaction: Interaction, server_now }     state at once, tally ≤ 4 Hz
  { type: "pong", server_now }
```

**The set never reads the server.** The vote bar on the set is a browser
source (`ExtraSpec::Overlay`) pointed at a loopback bridge inside Producer
(`src-tauri/src/live/bridge.rs`, `127.0.0.1:47119/overlay` polling
`/state.json` at 4 Hz) that the host's Producer feeds from the frames it
receives — what is on air follows the host's clock and works with zero
server (docs/INTERACTIVE.md decision 1).

## Phase 1 on this side

Milestone: [Rooms, Participants, Contributions — Phase 1](https://github.com/Boomin-Ai/producer/milestone/1)
(the api half is [api milestone 1](https://github.com/Boomin-Ai/api/milestone/1), issues #381–#387).

| # | Item | Issue | State |
|---|---|---|---|
| 1 | Participant kind + grants on the open server; roster kind badge | [#46](https://github.com/Boomin-Ai/producer/issues/46) | grants on the wire in [#53](https://github.com/Boomin-Ai/producer/pull/53); D1 `kind` + `grants`, tickets, DO enforcement **built** (open-server Phase 1 PR) |
| 2 | Roster role header, mod controls, Moderators sheet, `room_access` IPC | [#47](https://github.com/Boomin-Ai/producer/issues/47) | mod controls in [#53](https://github.com/Boomin-Ai/producer/pull/53); open-server mod link + control seat + scene cuts **built**; Boomin half in [api #380](https://github.com/Boomin-Ai/api/pull/380) |
| 3 | Green room + native Producer-to-Producer entry | [#48](https://github.com/Boomin-Ai/producer/issues/48) | **built** in [#43](https://github.com/Boomin-Ai/producer/pull/43) (open, needs the two-machine test) |
| 4 | Screen share as a grant + corner self tile on the guest page | [#49](https://github.com/Boomin-Ai/producer/issues/49) | on the wire in [#53](https://github.com/Boomin-Ai/producer/pull/53) |
| 5 | Contribution ledger on the open server + run report | [#50](https://github.com/Boomin-Ai/producer/issues/50) | **built** (open-server Phase 1 PR) |
| 7 | One interaction end to end — two-choice vote (DO, alarm reveal, set overlay) | [#51](https://github.com/Boomin-Ai/producer/issues/51) | **built** (open-server Phase 1 PR); needs the two-machine test |
| 8 | Segmentation off / soft / cut — Cutout filter | [#52](https://github.com/Boomin-Ai/producer/issues/52) | **built** in [#44](https://github.com/Boomin-Ai/producer/pull/44) (open) |

Item 6 (metered deals) and item 9 (four small columns) are Boomin-only —
money and persistent identity — and have no issue here by design.
