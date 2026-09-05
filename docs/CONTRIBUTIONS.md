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

### What the contract gains (documented, not yet implemented)

`server/contract/openapi.yaml` carries these as **stubs returning 501
`not_implemented`** with the issue that tracks each:

- participants with `kind` + `grants` on the roster (`RosterGuest.kind`, `RosterGuest.grants`); `POST rooms/{id}/guests {producer_ref?}`; `POST guests/{id}/grants` — [#46](https://github.com/Boomin-Ai/producer/issues/46)
- `GET rooms/{id}/contributions` — the run's interval ledger — [#50](https://github.com/Boomin-Ai/producer/issues/50)
- `POST rooms/{id}/interactions` · `PATCH …/interactions/{ix}` (`open` / `reveal` / `close` transitions) · `POST …/interactions/{ix}/inputs` — [#51](https://github.com/Boomin-Ai/producer/issues/51)
- `POST /v1/connect/audience/{code}/token` — the per-device audience capability token (no account, no email) — [#51](https://github.com/Boomin-Ai/producer/issues/51)

The stubs live in `server/src/stubs.ts`, gated exactly like their families
(`test/stubs.test.ts`): the host family 401s without a bearer and 403s for an
automation token; the guest/audience family takes no bearer at all.

## Phase 1 on this side

Milestone: [Rooms, Participants, Contributions — Phase 1](https://github.com/Boomin-Ai/producer/milestone/1)
(the api half is [api milestone 1](https://github.com/Boomin-Ai/api/milestone/1), issues #381–#387).

| # | Item | Issue | State |
|---|---|---|---|
| 1 | Participant kind + grants on the open server; roster kind badge | [#46](https://github.com/Boomin-Ai/producer/issues/46) | grants on the wire **built** in [#53](https://github.com/Boomin-Ai/producer/pull/53) (open); D1 `kind` + server-side grants remain |
| 2 | Roster role header, mod controls, Moderators sheet, `room_access` IPC | [#47](https://github.com/Boomin-Ai/producer/issues/47) | mod controls in [#53](https://github.com/Boomin-Ai/producer/pull/53); api half in [api #380](https://github.com/Boomin-Ai/api/pull/380) |
| 3 | Green room + native Producer-to-Producer entry | [#48](https://github.com/Boomin-Ai/producer/issues/48) | **built** in [#43](https://github.com/Boomin-Ai/producer/pull/43) (open, needs the two-machine test) |
| 4 | Screen share as a grant + corner self tile on the guest page | [#49](https://github.com/Boomin-Ai/producer/issues/49) | on the wire in [#53](https://github.com/Boomin-Ai/producer/pull/53) |
| 5 | Contribution ledger on the open server + run report | [#50](https://github.com/Boomin-Ai/producer/issues/50) | contract stub |
| 7 | One interaction end to end — two-choice vote (DO, alarm reveal, set overlay) | [#51](https://github.com/Boomin-Ai/producer/issues/51) | contract stubs |
| 8 | Segmentation off / soft / cut — Cutout filter | [#52](https://github.com/Boomin-Ai/producer/issues/52) | **built** in [#44](https://github.com/Boomin-Ai/producer/pull/44) (open) |

Item 6 (metered deals) and item 9 (four small columns) are Boomin-only —
money and persistent identity — and have no issue here by design.
