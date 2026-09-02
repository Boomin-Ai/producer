# Mounts — producer-to-producer presence on the Brand Network

*Written 2026-09-02, after a full read of the network's actual code
(api: mig 0136/0147, `services/network.ts`, `services/network-deals.ts`,
`services/live/guests.ts`). This supersedes every earlier sketch.*

A **mount** is one producer's presence inside another producer's live room.
v1 ships the smallest honest slice: see a visible open stage, knock, and be
admitted as a guest. Everything else in this memo is where that primitive
goes, grounded in what the platform already holds.

## The primitives we build on (verbatim doctrine)

The network is an economic graph with a consent spine — four tables, each
carrying a law:

- **`network_memberships`** — brand-grain directory presence. `capabilities`
  is *advertising metadata only* and MUST NOT authorize an action: it is
  authored by the brand it describes.
- **`network_connections`** — THE single shared consent fact between two
  brands, one canonical-ordered row. `activeConnectionBetween` is the only
  authorization primitive the network exposes: "may these two transact?" —
  yes/no, never a capability.
- **`network_invitations`** — the handshake, brand-addressed; a
  counter-invite IS acceptance.
- **`network_deals`** — flat-fee USD escrow (proposed → accepted → funded →
  delivered → released/disputed). Fees server-owned and snapshotted at
  accept; custody in the `reserved` wallet bucket; funded deals have no
  timeout. *The deal is the product object; the program beneath it is
  infrastructure.*

And one platform law that shapes everything here: **an entity is a HUMAN,
never a company**. There is no `entities.brand_id`; brands meet each other
only on the network. Rooms follow by analogy: **a room is a venue, never a
person** — visibility hangs off the room, consent off the connection, and
the humans inside are entities passing through.

## v1 — shipped by this change set

- **Room visibility** (`live_rooms.visibility`, mig 0147):
  `private | connections | public`, default private, set per room from the
  Producer home (the share chip on each room card). The room is the unit of
  consent — no brand-level flag can expose a stage that wasn't opted in.
- **Live-now** (`GET /network/rooms/live`): open stages visible to a brand —
  connections' rooms plus members' public rooms. "Open" is derived from
  `live_broadcasts` (evidence of a real session), never a heartbeat.
  `live` = on air, `idle` = studio open. Renders as the LIVE ON THE NETWORK
  strip on the Producer home.
- **The knock** (`POST /network/rooms/:id/enter`): visitor-initiated mirror
  of `inviteGuest`'s brand path. Gates in order — visibility, visitor
  membership, connection (for `connections` rooms), open broadcast — with
  unauthorized indistinguishable from missing (404, never 403). The visitor
  lands in the host's **waiting room** with a *verified* brand identity
  (name/avatar from the brands row); auto-admit deliberately does not apply.
  Re-entering resumes the same slot (the host's framing survives) with a
  rotated code. `joined_via = 'network'`, exempt from room-link rotation.
- **Discovery = exact handle only** (`GET /network/lookup`): Producer is
  never handed the directory list. The rail's Find tab resolves a handle you
  were given — that ceiling is deliberate.
- **The other half of the door**: a guest link in any form ends at the web
  guest page, which now waits visibly for the admit — and that page is also
  where a non-Producer guest learns Producer exists. One link serves both
  audiences: join the show now, get the app to host your own.

## Where it goes (designed, not built)

- **Watch-mounts**: a publish-denied guest seat on the program-return leg —
  "see my connection's show" without occupying a stage slot. Producer is
  already the MCU on the host's machine, so small audiences ride the same
  P2P fabric; an SFU tier arrives only when public watch outgrows it
  (~1.4¢/viewer-hr at 640×360 — see the SFU note in the session log).
- **Rings**: calls are invitation-objects, not capability reads. A "calls
  welcome" chip on a membership is *advertising*; the actual ring is an
  explicit, ephemeral, brand-addressed ask, same shape as
  `network_invitations`. Never gate a call on `capabilities`.
- **Appearances as deals**: a guest appearance can BE a deal deliverable —
  booked and escrowed through `network_deals`, with the enter-mount as the
  delivery event (`markDelivered` when the slot completes). Paid public
  entry falls out of the same machinery: a room's enter can require a funded
  deal first. Zero new financial machinery; the deal UI lives in Boomin's
  Commerce section, not in Producer.
- **Recognition**: recurring guests, transcripts, voiceprints attach to
  `entities` (humans) — the person-grain seam (`playedByEntityId` already
  models "this character is played by that real person"). The money and the
  consent stay strictly brand-to-brand.

## Rules that must survive every iteration

1. Authorization = active connection + the acting brand's own grants.
   Never `capabilities`, never a membership flag.
2. Unauthorized and nonexistent are the same 404 across every network-facing
   room surface.
3. "Open" and "live" are derived from broadcast rows. No client heartbeat
   ever creates presence.
4. The knock always waits. No path — auto-admit, connection, deal — seats a
   visiting brand on a stage without the host's explicit admit.
5. Producer never receives a list of the network. Exact handle, or nothing.
