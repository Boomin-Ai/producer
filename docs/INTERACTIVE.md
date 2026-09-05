# INTERACTIVE — Producer as the open interactive live platform

Status: DESIGN, 2026-09-04. Docs only; nothing here is built. Companion docs:
`docs/LIVE-REVIEW.md` (the room as it stands), `server/README.md` (the open
server line), Boomin `docs/ROOM_ACCESS.md` (room roles + guest kinds, in flight
on `api feat/room-access-design`, migs 0153/0154), `docs/HANDOFF.md`
(segmentation is the next Mac build-out).

Research (§9) is cited by URL; every number in the design that came from a
cited source says so.

---

## 1. Thesis

Every live platform today is a **one-way pipe with a chat box glued on**.
Twitch's interactivity is an overlay iframe over a video someone else
composited; YouTube's is a poll in the chat column; the "guest" tools
(StreamYard, Riverside, VDO.Ninja) put people in tiles and stop there. The
audience is never *on the set*, guests never *hold* anything, and none of it is
yours to run.

Producer is three runtimes and one schema:

| Runtime | Who | What it is | Where it lives |
|---|---|---|---|
| **Host studio** | the person making the show | Producer (Tauri + Rust + libobs on Metal/D3D11). Composites the set, owns the program, is the *authority* on what is on air. | `src/`, `src-tauri/` |
| **Guest runtime** | people on the set | the guest web page (`server/guest`) or another Producer (Producer-to-Producer). They see the **program**, not a mirror; they share a screen as a second track; they get a **panel** built from a control catalog; and, because the host has their **person mask**, they are cutouts on a shared set who can *hold* set objects. | `server/guest/`, `src/views/Live.tsx` (P2P guest) |
| **Audience runtime** | everyone else | a phone as a controller. Room code, no account, no install. Vote, choose, type anonymously, react, raise a hand. Never touches media. | `server/guest/` (new `/a/:code` page), later `@boomin/components/audience` |

The thing that makes it one platform rather than three products is the
**interaction** (§2): a typed object with a lifecycle, an input policy, a
visibility policy and a **render binding** — and the same JSON document drives
the host's panel, the guest's panel, the audience's phone, and the pixels on the
set. Twitch Extensions get half of this (a JWT role + PubSub + an overlay
iframe); MixPlay got the other half (scenes, groups, controls, cooldowns,
participants) and Microsoft shut it down in 2020. Nobody ships both, open, with
a native compositor that knows where the people are.

**Open, self-hostable, network optional.** Everything about *making a show* —
rooms, guests, interactions, the audience runtime, the mask — runs on
`producer-server` (one `wrangler deploy`, AGPL). What needs a second party's
identity or money — verified brand guests, knocking, paid appearances, paid
votes, cross-brand audiences — is the Boomin Network. Same routes, different
base URL. That is the line `server/README.md` already draws; this document
does not move it.

**Not a "streaming tool".** A show with a set, people on it, and an audience
that steers it is a social medium, not a broadcast. The audience path is
designed like a game server, not a chat: authoritative room state, reveal
timers, one vote per identity, moderation before pixels.

---

## 2. Interaction model

### 2.1 Participants

A room has **participants**. A participant is (identity kind, role, capabilities).

Identity kinds come from ROOM_ACCESS (Boomin `live_room_guests.kind`, mig 0154)
plus one new kind this design adds:

| Kind | What proves them | Media? | Typical role |
|---|---|---|---|
| `producer` | the host's own Producer, endpoint token | yes (composites) | host |
| `member` | brand member with a room-scope grant (viewer/editor/admin ⇒ observer/mod/manager) | optional | mod / manager |
| `connection` | a verified network brand (Boomin only) | yes | guest |
| `visitor` | invite code / room link, no account | yes | guest |
| `audience` (**new**) | a per-device capability token minted at the room code door, no account | **never** | audience |

Roles are what the room *lets you do*; kinds are what proves you. A `visitor`
is normally a guest but can be promoted to mod for the show; a `member` may be
a mod without ever appearing.

### 2.2 Interactions

An **interaction** is a typed object the host (or a mod, or a flow) opens in a
room. Every interaction has the same envelope; only `spec` varies by `type`.

| Field | Meaning |
|---|---|
| `id`, `room_id`, `type` | identity + discriminator |
| `state` | lifecycle: `draft → open → collecting → revealed → closed` (`open` = visible, inputs not yet accepted; `collecting` = accepting inputs; `revealed` = results shown per visibility policy; `closed` = archived, immutable). `cancelled` is a terminal branch from any state. |
| `spec` | the type-specific body (options, prompt, max length, …) |
| `input` | **who may input, how often, and as whom** |
| `visibility` | **who sees what, when** |
| `timing` | open/collect/reveal timestamps + durations (server clock; alarms fire the transitions) |
| `render` | **render bindings**: how it shows on the set, in the host UI, on the guest page, on the phone |
| `tally` | server-computed results (counts, top texts, per-option scores); the only thing audiences ever read back |
| `by`, `created_at`, `updated_at`, `version` | audit + optimistic concurrency (`version` increments on every transition; clients ignore stale) |

#### Interaction types (v1)

| `type` | `spec` | Input | What the tally is |
|---|---|---|---|
| `vote` | `options[2..6]`, `multi:false` | pick one | count per option, total, winner |
| `choice` | like `vote` but *the host asks a guest* (or the audience) to pick and the pick drives the show (which segment next, which door) | pick one | winner + who picked (if not anonymous) |
| `text` | `prompt`, `max_len ≤ 140`, `mode: "anonymous" \| "named"` | free text | mod-approved list, optionally ranked by reactions |
| `reaction` | `set: ["🔥","😂","👏",…]`, `window_ms` | tap, repeatable | rolling counts per emoji (the only rate-limited-but-unbounded type) |
| `hand` | none | raise / lower | ordered queue |
| `cue` | `label`, `to: participant_id[]` | none (host → participant) | ack |
| `share_request` | `kind: "screen"` | accept / decline (guest) | state |
| `rating` | `scale: 1..5 \| 1..10` | pick one | mean, histogram |
| `wordcloud` | `prompt`, `max_words: 3` | short text | weighted terms (mod-filtered) |

Predictions with stakes, paid votes ("Bits-gated"), and cross-room interactions
are **not** v1 types; they are `vote`/`choice` with a Boomin-only `stake` block
(§4.6). The type set is closed in v1 on purpose: a small set, rendered well on a
set, beats a plugin system with nothing on it.

#### Input policy

```jsonc
"input": {
  "roles":      ["audience", "guest"],   // who may submit
  "identity":   "anonymous",             // "anonymous" | "pseudonymous" | "named"
  "per_identity": "once",                // "once" | "latest_wins" | "unbounded"
  "rate":       { "burst": 1, "per_sec": 0.2 },   // token bucket per identity (reaction: burst 5, 2/s)
  "moderation": "pre",                   // "none" | "pre" (mod queue before tally/pixels) | "post"
  "hold_ttl_ms": 120000,                 // pre: an unapproved input expires (Streamlabs "regular") — 0 = hold forever ("unlimited")
  "filter": "moderate"                   // "off" | "moderate" (slurs/hate rejected, profanity allowed) | "strict" — Jackbox's three levels; rejection happens AT ENTRY, the phone is told
}
```

`anonymous` = the tally never carries an identity, and the server stores only a
salted hash of the capability token for `per_identity` enforcement.
`pseudonymous` = the room-scoped display name (chosen at the door) travels with
the input. `named` = only roles that have a real identity (member/connection).

#### Visibility policy

```jsonc
"visibility": {
  "running_tally": ["host", "mod"],     // who sees live counts while collecting
  "reveal":        "on_close",          // "live" | "on_close" | "on_timer" | "manual"
  "reveal_to":     ["host","mod","guest","audience","set"],
  "inputs":        ["host","mod"]       // who may read raw inputs (texts) — never "audience"
}
```

The **set** is a visibility target. "Reveal on the set" is what puts the result
into the program; "reveal to audience" is what puts it on phones. They are
independent: a host may reveal to guests on their panels *before* the set (a
"you know, they don't" beat), or on the set *before* phones (the audience sees
it on the stream they are watching).

#### Render bindings

A render binding says *where and how* an interaction shows. One interaction has
up to four; each surface picks its own.

| `surface` | Binding kinds | Notes |
|---|---|---|
| `set` | `overlay` (a browser-source layer: bar, cards, lower third, ticker), `set_object` (a scene item that is **mask-aware**: it sits *behind* guests, can be *held*, *pointed at*), `lighting` (a color/particle filter driven by tally), `lower_third` | `set_object` is §3 |
| `host` | `panel_card` (the interaction in the host's Room rail: open/close/reveal, mod queue) | Producer UI |
| `guest` | `panel_card`, `pick` (options as buttons), `cue_toast`, `queue` | guest page |
| `audience` | `controller` (full-phone: big buttons, text box, emoji bar), `status` (waiting/thanks/result) | phone |

A `set` binding is addressed like any scene item (`slot`, `x/y/w/h`, `z`, and
`anchor: {kind:"between", guests:[a,b]}` / `{kind:"held_by", guest:a}` for
mask-aware placement).

### 2.3 Flagship table (a) — interaction types × policies × render bindings

| Type | Default input | Default visibility | Set binding | Guest binding | Audience binding | Mod queue |
|---|---|---|---|---|---|---|
| vote | audience+guest, anonymous, once, 1/5s | tally host+mod; reveal on_close to all incl. set | `overlay:bar` or `set_object:cards` between guests | `pick` | `controller:choices` | no |
| choice | one named guest OR audience, once | reveal live | `set_object:cards` **held_by** guest; pick by dwell | `pick` | `controller:choices` | no |
| text | audience, anonymous, latest_wins, 1/10s, **pre** | inputs host+mod only; reveal manual | `overlay:ticker` / `lower_third` (one approved text at a time) | — | `controller:text` | **yes** |
| reaction | audience, anonymous, unbounded, 2/s burst 5 | live to set | `lighting` (particles/colour on the set) | `panel_card` (counts) | `controller:emoji` | no |
| hand | guest+audience, pseudonymous, latest_wins | host+mod | — | `queue` | `controller:hand` | no |
| cue | host → guest | guest only | — | `cue_toast` | — | no |
| share_request | host → guest / guest → host | both | — | `panel_card` | — | no |
| rating | audience, anonymous, once | on_timer to all | `overlay:meter` | `pick` | `controller:scale` | no |
| wordcloud | audience, anonymous, latest_wins, **pre** | on_close | `overlay:cloud` | — | `controller:text` | yes |

### 2.4 JSON schema (abridged; the full schema is `server/contract/interaction.schema.json` when built)

```jsonc
{
  "$id": "producer.interaction/v1",
  "type": "object",
  "required": ["id","room_id","type","state","spec","input","visibility","timing","render","version"],
  "properties": {
    "id":       { "type": "string", "pattern": "^ix_[A-Za-z0-9]{12,}$" },
    "room_id":  { "type": "string" },
    "type":     { "enum": ["vote","choice","text","reaction","hand","cue","share_request","rating","wordcloud"] },
    "state":    { "enum": ["draft","open","collecting","revealed","closed","cancelled"] },
    "version":  { "type": "integer", "minimum": 0 },
    "spec":     { "type": "object" },            // per-type; validated by type
    "input": {
      "type": "object",
      "properties": {
        "roles":        { "type": "array", "items": { "enum": ["host","mod","guest","audience"] } },
        "identity":     { "enum": ["anonymous","pseudonymous","named"] },
        "per_identity": { "enum": ["once","latest_wins","unbounded"] },
        "rate":         { "type": "object", "properties": { "burst": {"type":"integer"}, "per_sec": {"type":"number"} } },
        "moderation":   { "enum": ["none","pre","post"] }
      }
    },
    "visibility": {
      "type": "object",
      "properties": {
        "running_tally": { "type": "array", "items": { "enum": ["host","mod","guest","audience","set"] } },
        "reveal":        { "enum": ["live","on_close","on_timer","manual"] },
        "reveal_to":     { "type": "array", "items": { "enum": ["host","mod","guest","audience","set"] } },
        "inputs":        { "type": "array", "items": { "enum": ["host","mod"] } }
      }
    },
    "timing": {
      "type": "object",
      "properties": {
        "opened_at": {"type":"string","format":"date-time"},
        "collect_ms": {"type":"integer"},          // 0 = until closed by hand
        "reveal_at":  {"type":"string","format":"date-time"},
        "reveal_hold_ms": {"type":"integer"},      // dramatic pause before pixels
        "close_after_ms": {"type":"integer"},
        "stream_delay_ms": {"type":"integer"},     // room-level estimate of glass-to-glass delay; audience windows are EXTENDED by it (Jackbox "extended timers")
        "cooldown_until": {"type":"string","format":"date-time"}   // MixPlay-style: a control is disabled until a server timestamp, never a client-side countdown
      }
    },
    "render": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["surface","kind"],
        "properties": {
          "surface": { "enum": ["set","host","guest","audience"] },
          "kind":    { "type": "string" },        // overlay | set_object | lighting | lower_third | panel_card | pick | cue_toast | queue | controller | status
          "style":   { "type": "string" },        // bar | cards | ticker | meter | cloud | choices | text | emoji | hand | scale
          "anchor":  { "type": "object" },        // {kind:"slot",slot:"lower-third"} | {kind:"between",guests:[..]} | {kind:"held_by",guest:".."} | {kind:"xywh",...}
          "z":       { "type": "integer" },
          "occlude": { "type": "boolean" }        // set only: draw BEHIND person masks
        }
      }
    },
    "tally": { "type": "object" }
  }
}
```

#### Example — a two-choice vote rendered as a bar between two guests

```jsonc
{
  "id": "ix_8h3kd0s7a1qz", "room_id": "room_01", "type": "vote", "state": "collecting", "version": 3,
  "spec": { "prompt": "Who won that round?", "options": [ {"id":"a","label":"Maya"}, {"id":"b","label":"Dev"} ] },
  "input": { "roles": ["audience"], "identity": "anonymous", "per_identity": "once",
             "rate": {"burst":1,"per_sec":0.2}, "moderation": "none" },
  "visibility": { "running_tally": ["host","mod"], "reveal": "on_timer",
                  "reveal_to": ["set","guest","audience"], "inputs": [] },
  "timing": { "opened_at": "2026-09-05T01:00:00Z", "collect_ms": 30000, "reveal_hold_ms": 1500 },
  "render": [
    { "surface": "set", "kind": "set_object", "style": "bar",
      "anchor": { "kind": "between", "guests": ["g_maya","g_dev"] }, "z": 5, "occlude": true },
    { "surface": "host",     "kind": "panel_card" },
    { "surface": "guest",    "kind": "panel_card" },
    { "surface": "audience", "kind": "controller", "style": "choices" }
  ],
  "tally": { "total": 412, "options": { "a": 231, "b": 181 } }
}
```

#### Example — anonymous text with a mod queue, shown as a lower third

```jsonc
{
  "id": "ix_2k9sh1pq0ws4", "room_id": "room_01", "type": "text", "state": "collecting", "version": 7,
  "spec": { "prompt": "Confess something small.", "max_len": 120 },
  "input": { "roles": ["audience"], "identity": "anonymous", "per_identity": "latest_wins",
             "rate": {"burst":1,"per_sec":0.1}, "moderation": "pre" },
  "visibility": { "running_tally": ["host","mod"], "reveal": "manual",
                  "reveal_to": ["set"], "inputs": ["host","mod"] },
  "timing": { "opened_at": "2026-09-05T01:04:00Z", "collect_ms": 0 },
  "render": [
    { "surface": "set", "kind": "lower_third", "style": "ticker", "anchor": {"kind":"slot","slot":"lower-third"} },
    { "surface": "host", "kind": "panel_card" },
    { "surface": "audience", "kind": "controller", "style": "text" }
  ],
  "tally": { "pending": 14, "approved": 3, "shown_id": "in_77aa" }
}
```

#### Example — "hold this card": a choice a guest picks by pointing

```jsonc
{
  "id": "ix_c4rdp1ck0001", "room_id": "room_01", "type": "choice", "state": "collecting", "version": 2,
  "spec": { "prompt": "Pick a door", "options": [ {"id":"1","label":"Door 1"}, {"id":"2","label":"Door 2"}, {"id":"3","label":"Door 3"} ] },
  "input": { "roles": ["guest"], "identity": "named", "per_identity": "once", "moderation": "none",
             "only": ["g_maya"] },
  "visibility": { "running_tally": ["host"], "reveal": "live", "reveal_to": ["set","guest","audience"], "inputs": [] },
  "timing": { "collect_ms": 0 },
  "render": [
    { "surface": "set", "kind": "set_object", "style": "cards",
      "anchor": { "kind": "held_by", "guest": "g_maya" }, "occlude": true,
      "pick": { "mode": "dwell", "dwell_ms": 700, "hit": "hand_or_silhouette" } },
    { "surface": "guest", "kind": "pick" },               // fallback: tap on the panel
    { "surface": "audience", "kind": "status" }
  ]
}
```

### 2.5 One schema, four surfaces

The same document is read by four renderers; none of them talk to each other.

| Surface | Reads | Writes | Renderer |
|---|---|---|---|
| Host (Producer) | everything, incl. raw inputs | creates, transitions state, approves inputs | Room rail card (`src/views/Live.tsx` → new `src/live/interactions/`) |
| Set (libobs) | `render[surface=set]` + `tally` + `state` | nothing | an **interaction overlay page** (`/connect/room/:id/set?k=`) in a browser source, plus native `set_object` items (§3) |
| Guest page | `render[surface=guest]`, `tally` per visibility, cues to me | inputs I'm allowed | `server/guest/src/panel/` |
| Audience phone | `render[surface=audience]`, `state`, tally only after reveal | inputs I'm allowed | `server/guest/src/audience/` |

Every frame the DO sends carries `server_now` (ms). Clients compute
countdowns as `reveal_at - server_now + local_offset` (MixPlay's `getTime`
pattern), so a phone that was asleep for a minute still shows the right number.
Audience-facing windows are **extended by `stream_delay_ms`**: someone watching
on Twitch sees the question 2–10 s after the host asked it, so the phone's
collect window closes that much later than the set's (Jackbox added "extended
timers" for exactly this).

The server projects the document **per role** before sending it: an audience
socket never receives `visibility.inputs`, raw texts, or a running tally it is
not entitled to. Projection is a pure function `project(interaction, role)` in
`server/src/interactions/project.ts`, unit-tested against every type × role.

---

## 3. Fit with segmentation

Segmentation (`feat/segmentation`, Vision person mask → libobs filter on Metal;
Windows = MediaPipe/ONNX on DirectML later) gives the compositor, per guest
source, per frame, a **person mask** (alpha) and, cheaply derived from it, a
**silhouette bounding box** and **centroid**. That is what turns interactions
from overlays into set objects.

### 3.1 What the mask enables

| Capability | Mechanism | Latency budget | Honest status |
|---|---|---|---|
| **Cutout on a shared set** | `VNGeneratePersonSegmentationRequest` at `.fast` (streaming tier, ~256×144 mask, ~10 ms class) or `.balanced` (~960×540; 60 fps on M1 per developer reports), output `OneComponent16Half` so the mask binds straight to Metal as `r16Float` via `CVMetalTextureCache`, **one request instance reused across frames** (the request is stateful; that is where its temporal smoothing lives); bilinear + edge-aware upsample in the shared compositing filter. Up to 4 separate people per source via `VNGeneratePersonInstanceMaskRequest` (macOS 14) when two guests share one camera. | mask lag ≤ 1 frame is invisible | this is `feat/segmentation`; Windows = ONNX Runtime + DirectML (RVM/MODNet/MediaPipe selfie exports, inference scale ≈ 0.25 — obs-backgroundremoval measured a 5 → 26 ms cliff above 480×270), MediaPipe's own GPU delegate is CPU-only on Windows, and DirectML is now "sustained engineering" behind Windows ML — the provider interface must be swappable |
| **Occlusion: overlays behind people** | a `set_object` with `occlude:true` renders *below* guest sources in z; because guests are cutouts, the object shows through where there is no person. No extra work beyond z-order once cutouts exist. | 1 frame of mask lag = a 1-frame halo on fast motion; acceptable (every virtual-background product ships this) | free with cutouts |
| **Silhouette hit-test** | per frame, the mask is reduced (on GPU, 1/8 res) to a bbox + a coarse occupancy grid (e.g. 32×18) published to the app thread; a set object's rect is tested against the grid | hit-testing a *silhouette* at 30 fps with 1 frame lag is fine for **dwell** gestures (≥ 500 ms) and wrong for anything twitchy; we only ship dwell | new: `filters.rs` mask-stats readback |
| **Pointing / "hold this card"** | hand landmarks (Vision `VNDetectHumanHandPoseRequest`, 21 joints, `maximumHandCount:2`, on macOS; MediaPipe HandLandmarker ~12–17 ms on Windows) give a wrist/index point; a card is *held* when the hand point sits inside its rect for `dwell_ms` (300–800 ms, Kinect's hover-fill gauge); the card then follows the hand through a 1€ filter extrapolated 1–2 frames by velocity | hand pose costs more than the mask; run at half rate and interpolate; the dwell hides the lag. Kinect's HIG later preferred an explicit "push" over dwell because dwell tires — offer both once it works | week 3 stretch; the mask-only fallback is "stand next to it" |
| **Set lighting from tally** | a colour/particle filter on the *background* source with parameters bound to `tally` | none (it's a parameter) | trivial once the overlay page exists; native filter later |
| **Between-guests anchoring** | `anchor:{kind:"between"}` reads the two guests' bboxes each frame and centres the object in the gap; `held_by` reads one bbox/hand point | one frame | week 3 |

### 3.2 What the mask does not enable

- **Precise interaction with fast motion.** A 33 ms-late mask at a 1080p60
  program is a 2-frame miss on a swing. No "swat the ball" mechanics; dwell,
  lean, stand-in-zone only. This is the Kinect lesson (Kinect Adventures shipped
  dwell and body-zone mechanics for exactly this reason).
- **Depth.** A mask is 2D. "Behind" means z-order, never true occlusion by
  limbs crossing an object. A card *held* is drawn above the person with a
  small feathered inset so fingers appear to wrap it; that is a trick, not
  physics.
- **Guest-side masks.** The mask is computed on the *host* (where the
  compositor is). Guest pages never see it. A guest picking on their own panel
  is the universal fallback and must always work.
- **The system Portrait toggle is not ours.** `AVCaptureDevice.isPortraitEffectEnabled`
  is read-only (the user's Control Center switch); ARKit's `segmentationBuffer`
  is iOS-only. On macOS the only programmable mask is Vision's. On Windows,
  Studio Effects' `BACKGROUNDSEGMENTATION_MASK` metadata (NPU, Copilot+ boxes)
  is a free mask when present and a good second provider.

### 3.3 Where it lives

| Piece | Module |
|---|---|
| mask provider (per platform) + shared compositing filter | `src-tauri/src/live/segment/{mod,vision.rs,shim_seg.m,directml.rs}` (from `feat/segmentation`) |
| mask stats (bbox, centroid, 32×18 occupancy) → app thread | `src-tauri/src/live/segment/stats.rs`, surfaced in `LiveSnapshot.guests[].mask` |
| hand point (optional) | `src-tauri/src/live/segment/hands.rs` (Vision) / `hands_win.rs` |
| set objects (native scene items bound to interactions) | `src-tauri/src/live/setobj.rs` + `src/lib/setObjects.ts` |
| hit-test + dwell state machine (app thread, TS) | `src/live/interactions/hit.ts` |

---

## 4. Transport & state

### 4.1 Shape

```
audience phones ──WS (hibernating)──▶ RoomState DO ◀──WS── host Producer
                                          │  ▲
guest pages ──WS (signal only)────────────┘  │ publish (trusted, Worker-internal)
guest pages ◀──WebRTC media + DATA CHANNEL──▶ host Producer (browser source page per guest)
```

- **`RoomState` Durable Object per room = authoritative game state.** New class
  beside `RealtimeHub` (which stays signaling-only). Holds interactions, tallies,
  the mod queue, the participant table, rate-limit buckets, and the alarm for the
  next timed transition. SQLite-backed (free plan), so state survives eviction.
- **Audience WebSockets use the Hibernation API** (as `RealtimeHub` already
  does): a phone that is only listening costs nothing while idle; the DO wakes
  on a message. Per-socket state (role, identity hash, subscriptions) lives in
  `serializeAttachment` so it survives hibernation.
- **Alarms drive the lifecycle.** `collect_ms` → alarm → `revealed` (after
  `reveal_hold_ms`) → alarm → `closed`. One alarm per DO, so the DO keeps a
  `schedule` table of due transitions and re-arms for the earliest; alarms are
  at-least-once with retries and can slip by up to a minute during failover,
  which is why the *host* renders countdowns from `reveal_at` and treats the
  alarm as the state authority, not the clock (§4.2).
- **Guest ↔ host controls ride the WebRTC data channel** that already exists
  between the guest page and the guest's browser-source page in Producer. One
  ordered reliable channel `ctl` for panel actions/cues (they must not be lost),
  one unordered, `maxRetransmits:0` channel `pose` for anything continuous
  (future: guest-side hand point). Unreliable frames stay **under one MTU
  (~1 150 bytes)** — a lost fragment loses the whole SCTP message; reliable
  frames ≤ 16 KiB. RTT is the p2p RTT; no server hop. Safari/iOS has supported
  both since 11.
- **The audience path never touches media.** Phones speak JSON to the DO and
  nothing else. No ICE, no TURN, no camera permission prompt.
- **Host ↔ DO** is the host's existing room WebSocket (`liveroom:<id>` today),
  upgraded to carry interaction frames. The host is the *only* writer of
  interaction state transitions (mods write approvals/kicks).

### 4.2 Flagship table (c) — transport per path with latency budget

| Path | Transport | Budget (p50 / p95) | Why this transport |
|---|---|---|---|
| audience input → DO tally | WSS to DO, hibernating | 60 ms / 250 ms (edge RTT + DO) | thousands of writers, tiny messages, server must count |
| DO → audience (state/tally) | WSS fan-out, projected per role, **deltas** coalesced at ≤ 10 Hz, full snapshot on (re)connect | 100 ms / 400 ms | phones need eventual, not instant; Twitch caps extension PubSub at 5 KB / ~1 msg/s per channel and it is enough for every extension on Twitch |
| DO → host (state/tally/mod queue) | host room WSS | 60 ms / 200 ms | host must see the running tally |
| host → set overlay page | local browser source (`localhost`/Worker page) fed from the **host**, not the DO | < 1 frame (local WS/IPC) | pixels follow the host's clock, never the network |
| guest panel action → host | WebRTC data channel `ctl` (reliable, ordered) | RTT/2 (typ. 20–80 ms) | already p2p; no server, no media coupling |
| host cue → guest panel | same `ctl` channel | RTT/2 | same |
| guest screen share → host | WebRTC second video track on the existing PC (`getDisplayMedia`) | media path; unchanged | second track, not a second connection |
| program return → guest | WebRTC track host→guest (exists) | media path | mix-minus is already the rule |
| mask → set object | in-process (engine thread → app thread) | 1 frame | never leaves the host |
| reveal timer | DO alarm → host → set | alarm jitter is seconds-grade; **the host renders the countdown from `reveal_at`**, not from ticks | timers must look exact on air |

The rule that falls out: **anything that becomes pixels is driven from the host
over a local path; the network only carries state.** Audience sees the result on
the stream they are already watching; the phone's "result" screen is a courtesy.

### 4.3 Identity, anonymity, capability tokens

- The room code door (`/a/:code`) mints a **per-device capability token**: an
  HS256 JWT like `server/src/ticket.ts` (`aud: "audience"`, `sub: aud_<random>`,
  `room`, `exp` = show length, max 12 h), stored in `localStorage`, replayed on
  reconnect. No account, no email, no cookie consent needed (functional).
- **Anonymity model:** the DO keys `per_identity` enforcement on
  `sha256(token_sub + interaction_id + room_salt)`; the tally never stores the
  sub; texts are stored with the hash only until the show ends, then purged.
  Mods see texts, not identities — but can **shadow-mute** a hash (§4.5).
- A pseudonymous display name is optional, chosen at the door, filtered (§4.5),
  room-scoped, and shown only for `pseudonymous` inputs (hand-raise).
- Guests keep their existing invite-code identity; the data channel is
  authenticated by construction (it exists only after signaling with a ticket).
- Members/mods authenticate as today (session or endpoint token; Boomin room
  grants decide `mod` vs `manager`).

### 4.4 Rate limits and scale

| Limit | Value | Where |
|---|---|---|
| audience sockets per room | **hub and spoke from the first phone**: `RoomState` (hub) holds the tally and the mod queue and never holds audience sockets; `RoomRelay:<room>:<n>` DOs hold ≤ 1 000 hibernating sockets each and receive one RPC per delta. A DO is single-threaded and Cloudflare's guidance is ~1 000 req/s per object; outbound WS messages are free but not free of CPU. Inbound is billed 20:1, so a 10k audience voting once costs ~500 request units | DO |
| input rate per identity | per-interaction `input.rate` (defaults in table (a)); global 5 msgs/s burst 10 per socket; violators get a 10 s cooldown, then a 60 s one, then disconnect. Buckets live **in the DO** (exact, one place) — the Workers Rate Limiting binding is per-colo and approximate by design, fine for the door, wrong for one-vote-per-device | DO |
| message size | inputs ≤ 1 KB; texts ≤ 140 chars, NFC-normalised, control chars stripped | Worker + DO |
| fan-out cadence | audience tally deltas ≤ 4 Hz (10 Hz to the host); state transitions immediate; full snapshot on (re)connect; per-socket attachment ≤ 16 KB so keep only `{role, id_hash, name, muted}` there | DO |
| room-code entropy | 4 uppercase letters, no vowels (no accidental words), regenerated per show, resolvable only while the room is open → ~200k live space; brute force gated by Turnstile after 3 misses per IP | Worker |
| join burst | Turnstile (invisible) on the door when the room exceeds 500 joins/min | Worker |

### 4.5 Abuse controls

- **Pre-moderation is the default for text.** Nothing typed by an anonymous
  audience reaches pixels without a mod (or host) tap; the queue is FIFO with
  the profanity score as a badge, not a filter (mods decide). Reactions and votes
  are structurally safe (closed vocabularies).
- **Profanity/slur filter** at the DO on every text (a small word list with
  leetspeak normalisation in the open server; optional Workers AI Llama Guard or
  a hosted classifier on Boomin). Filtered texts are held, never dropped
  silently — "held" is a state the mod sees.
- **Shadow-mute**: a mod mutes a hash; that device keeps "submitting" and keeps
  seeing "thanks", nothing reaches the queue. Cheap and it beats the ban/rejoin
  loop.
- **Kick** = revoke the token's `jti` in the DO's denylist; the socket closes;
  re-entry needs the door again (and Turnstile if repeated).
- **Name filter** at the door (the same list + a "pretend to be host/mod"
  pattern check); names are ≤ 24 chars.
- **Slow mode** per interaction (`rate`) and per room (host toggle).
- **Nothing anonymous is ever a link.** URLs in texts are rejected, not
  linkified.
- **Hold, never silently delete; retract on the bus.** Filtered or held inputs
  stay visible to mods with a badge; an approved text later pulled by a mod
  emits a `retract` frame that the set overlay and phones honour (StreamElements
  `delete-message` → widgets retract already-rendered text). Held inputs expire
  per `hold_ttl_ms` so a show never stalls on a full queue.
- **Room lookup before the socket.** `GET /a/:code` returns
  `{open, full, locked, moderation, name_required, audience_count?}` first
  (Jackbox's ecast room probe); the phone only opens a WebSocket for a joinable
  room, and the door can be **hidden until cued** (code not shown on the set
  until the host reveals it).
- **Audience as one bloc** (`spec.bloc: true` on `vote`/`choice`): the whole
  audience counts as one voter alongside guests — Jackbox Poll Mine's streamer
  mode; useful for "guests vs the crowd" formats.
- Audit: every mod action and every reveal is an event row in the DO's SQLite
  (`events` table), exportable after the show.

### 4.6 Flagship table (d) — open server vs Boomin

| Concern | `producer-server` (open, AGPL, your account) | Boomin (hosted network) |
|---|---|---|
| rooms, guests, stage, signaling | ✅ (today) | ✅ (today) |
| **interactions + `RoomState` DO** | ✅ (this design; same DO code) | ✅ (same code, brand/org-scoped) |
| audience runtime (room code, phone) | ✅ | ✅ |
| mod roles | host + a shared mod link (single-user server: a mod is a *capability*, not an account) | member grants @ room scope (viewer/editor/admin ⇒ observer/mod/manager), mig 0153/0154 |
| identity kinds | producer, visitor, audience | + member, connection |
| pre-moderation, word list, shadow-mute, kick | ✅ | ✅ + hosted classifier |
| Turnstile on the door | your Turnstile keys (optional) | on |
| set overlay page + set objects | ✅ (rendered by Producer) | ✅ |
| guest panel + control catalog | ✅ | ✅ |
| **embeddable components** (`@boomin/components/audience`, `/guest`) | you can host `dist/*.js` yourself | delivered at runtime from boomin.ai |
| paid votes / stakes / paid appearances | ✗ (no money by design) | ✅ via wallet + deals — **paid extra votes and paid effects yes; wagering on outcomes no** (Twitch's Bits policy line 6.1/6.2, and the line that keeps this out of gambling law) |
| cross-brand audiences, network knocks, verified guests | ✗ | ✅ |
| audience > 10k with sharded fan-out | ✅ (same code; your account's limits) | ✅ |
| analytics across shows | local export only | ✅ |

---

## 5. Guest runtime

### 5.1 What a guest sees

1. **The program, not themselves.** Already the rule in `GuestRoomPage.tsx`
   ("see the SHOW"); the change is that the program tile is the *whole page*
   and the self-view is a draggable **corner tile** (default bottom-right, 160
   px, tap to hide, long-press to swap to "see the room" gallery when the
   program isn't up yet). iOS keeps audio-only return (existing WebKit memory
   rule) and shows the room gallery instead of program video.
2. **Mix-minus** stays: host mic + on-stage guests, never the program mix
   (existing `guestMesh.ts` rule; unchanged).
3. **Screen share as a second track.** `getDisplayMedia()` → `addTrack` on the
   existing PC with a `contentHint: "detail"`; the host's guest browser source
   receives it as a second `<video>` and exposes it to libobs as a **second
   source** (`ExtraSpec::GuestShare { url }` → a second render URL
   `/render/:id?k=…&track=share`), so the host frames the share independently
   of the person (the same reason each guest is its own browser source).
   Guests can only share when the host has enabled it (`share_request`) or the
   role capability allows it.
4. **A panel.** The right edge (desktop) / bottom sheet (phone) is a panel
   built from a **control catalog** and a per-role **panel spec** sent by the
   host. Controls: `mic`, `cam`, `share`, `hand`, `react`, `pick` (current
   choice), `vote`, `text`, `cue` (incoming), `chat` (guest-only backchannel),
   `name`, `leave`. The host can add/remove controls live; the guest never
   sees a control they cannot use.

### 5.2 Panel spec

```jsonc
{
  "panel": "producer.panel/v1",
  "role": "guest",
  "layout": "rail",                    // rail | sheet | grid
  "controls": [
    { "id": "mic",   "kind": "toggle", "label": "Mic" },
    { "id": "cam",   "kind": "toggle", "label": "Camera" },
    { "id": "share", "kind": "action", "label": "Share screen", "enabled": true },
    { "id": "hand",  "kind": "toggle", "label": "Raise hand" },
    { "id": "react", "kind": "emoji",  "set": ["🔥","😂","👏"] },
    { "id": "ix",    "kind": "interactions" },  // renders every open interaction bound to surface=guest
    { "id": "cues",  "kind": "cues" }
  ]
}
```

The host's default specs per role live in `src/live/panels/defaults.ts`; a room
may override in `room.config.panels[role]`. The audience controller is the same
spec language with `layout:"grid"` and only `ix`/`react`/`hand`.

### 5.3 Flagship table (b) — participant kinds × capabilities

| Capability | host (`producer`) | manager (`member` admin) | mod (`member` editor / promoted `visitor`) | guest (`visitor`/`connection`) | audience |
|---|---|---|---|---|---|
| appear (camera/mic) | ✅ | optional | optional | ✅ | ✗ |
| see program return | ✅ (is program) | ✅ | ✅ | ✅ | via the stream |
| screen share | ✅ | ✅ | if allowed | if allowed / on request | ✗ |
| open / close / reveal interactions | ✅ | ✅ | ✅ (if `mod_can_open`) | ✗ | ✗ |
| see running tally | ✅ | ✅ | ✅ | per `visibility` | per `visibility` |
| read raw anonymous inputs | ✅ | ✅ | ✅ | ✗ | ✗ |
| approve / hold / shadow-mute / kick | ✅ | ✅ | ✅ | ✗ | ✗ |
| vote / choose / react / text / hand | ✅ (rarely) | ✅ | ✅ | ✅ | ✅ |
| be *picked* to hold a set object | ✅ | if on set | if on set | ✅ | ✗ |
| receive cues | — | ✅ | ✅ | ✅ | ✗ |
| edit panel specs | ✅ | ✅ | ✗ | ✗ | ✗ |
| grant mod | ✅ | ✅ (Boomin: room-scope grants) | ✗ | ✗ | ✗ |

### 5.4 Reusable web components

Mirror `@boomin/components` exactly (shadow root, `mount*` returning a handle,
shadcn-named CSS variables from the host element, `contract: 1`, `dist/*.js`
self-hostable, a `<script src=…/components/v1.js>` global):

```js
import { mountAudience } from "@boomin/components/audience";
const h = await mountAudience(el, { room: "KXQZ", server: "https://producer.example", theme: "dark" });

import { mountGuest } from "@boomin/components/guest";
const g = await mountGuest(el, { invite: code, server, panel: "rail" });
```

Both are thin: the audience/guest React trees move from `server/guest/src/` into
`packages/components/src/{audience,guest}/` in the Boomin sdk repo and
`server/guest` becomes a page that mounts them. The open server serves the same
`dist` from `/components/v1.js`. A brand can then put the audience controller on
its own site with its own room code, and the guest door on a landing page.

---

## 6. Build plan (4 weeks)

Each week ships to `main` behind a room flag (`room.config.interactive`), so the
existing guest flow is never at risk.

### Week 1 — return feed, screen share, data channel, one vote as an overlay

| Piece | Lands in |
|---|---|
| program-first guest page: full-bleed program, corner self-tile, gallery fallback | `server/guest/src/GuestRoomPage.tsx` (split into `guest/Program.tsx`, `guest/SelfTile.tsx`) |
| screen share second track (guest) + second render URL (host) | `server/guest/src/GuestRoomPage.tsx`, `server/guest/src/GuestRenderPage.tsx` (`track=share`), `server/src/guests.ts` (`guestShareUrlFor`), `src-tauri/src/live/graph.rs` (`ExtraSpec::GuestShare`), `src/lib/ipc.ts` |
| data channels `ctl` + `pose` on the guest PC; typed frames | `server/guest/src/ctl.ts` (new), `GuestRenderPage.tsx` (host side, forwards to Producer via `window.__producer.postMessage` → CEF → `ipc`), `src-tauri/src/live/guestctl.rs` (new; CEF message bridge) |
| `RoomState` DO + `interactions` routes | `server/src/roomstate.ts` (new DO), `server/src/interactions/{schema.ts,project.ts,tally.ts,limits.ts}`, `server/src/live.ts` (routes `POST /rooms/:id/interactions`, `PATCH …/:ix` transitions), `server/wrangler.toml` (binding + `new_sqlite_classes`), `server/contract/openapi.yaml`, `server/contract/interaction.schema.json` |
| host UI: open a 2-option vote, see tally, reveal | `src/live/interactions/{store.ts,Card.tsx}` (new), `src/views/Live.tsx` (rail card) |
| set overlay page (bar) in a browser source, fed by the host | `server/guest/src/SetOverlayPage.tsx` (route `/connect/room/:id/set`), `src/lib/setOverlay.ts` (host → page bridge), `src-tauri/src/live/graph.rs` (`ExtraSpec::Overlay { url }`) |
| Boomin parity | `api/src/realtime/hub.ts` untouched; `api/src/services/live/roomstate.ts` (same DO), `api/src/routes/app/live-interactions.ts`, room-scope guards from `feat/room-access-design` |

### Week 2 — audience runtime + reveal timers

| Piece | Lands in |
|---|---|
| room code door + capability token (`aud:"audience"`) | `server/src/ticket.ts` (new audience aud), `server/src/audience.ts` (routes `/a/:code`), `server/guest/src/audience/{Door,Controller,Status}.tsx`, `router.ts` (`/a/:code`) |
| hibernating audience sockets, per-role projection, 10 Hz coalescing | `server/src/roomstate.ts` |
| anonymous text + mod queue (pre-moderation, hold, shadow-mute, kick) | `server/src/interactions/moderation.ts`, `src/live/interactions/ModQueue.tsx` |
| alarms: collect → reveal (hold) → close; host countdown from `reveal_at` | `server/src/roomstate.ts` (alarm heap), `src/live/interactions/Countdown.tsx` |
| profanity + name filter, Turnstile gate on the door | `server/src/interactions/wordlist.ts`, `server/src/audience.ts` |
| reactions → set lighting (overlay page particle layer) | `server/guest/src/SetOverlayPage.tsx` |
| Boomin: room-code resolution per brand, `audience` kind on the roster DTO | `api/src/routes/app/live-audience.ts`, mig `0155_audience_kind.sql` |

### Week 3 — mask-aware set objects

| Piece | Lands in |
|---|---|
| mask stats readback (bbox, centroid, 32×18 occupancy) per guest per frame | `src-tauri/src/live/segment/stats.rs`, `shim.m` (Metal reduce), `ffi.rs` + `shim_win.c` stub (extern-parity gate) |
| `LiveSnapshot.guests[].mask` to the app thread | `src-tauri/src/live/commands.rs`, `src/lib/ipc.ts` |
| native set objects: `between` and `held_by` anchors, occlude z-rule | `src-tauri/src/live/setobj.rs`, `src/lib/setObjects.ts`, `src/lib/stageMath.ts` |
| hit-test + dwell state machine; pick → interaction input as the guest | `src/live/interactions/hit.ts` |
| hand point (macOS Vision) at half rate, interpolated; Windows stub | `src-tauri/src/live/segment/hands.rs`, `shim.m`, `hands_win.rs` (TODO DirectML) |
| Stage Editor: place a set object, bind to an interaction | `src/views/StageEditor.tsx` |

### Week 4 — panel spec + components package

| Piece | Lands in |
|---|---|
| panel spec + control catalog; host edits per role; live push over `ctl` | `src/live/panels/{catalog.ts,defaults.ts,Editor.tsx}`, `server/guest/src/panel/{Panel.tsx,controls/*}` |
| `@boomin/components/audience` + `/guest` (shadow root, theme vars, handle) | Boomin sdk `packages/components/src/{audience,guest}.js`, `scripts/build.mjs`, README; `server/guest` mounts them |
| open server serves `/components/v1.js` | `server/src/index.ts` (static), `server/public/` |
| docs + self-hosting walkthrough for interactions | `server/SELF_HOSTING.md`, `docs/INTERACTIVE.md` (this file, updated to "built") |
| Windows: DirectML mask provider begins (parity rule) | `src-tauri/src/live/segment/directml.rs` |

Cut lines if a week runs long: hand point (W3) → dwell on silhouette only;
components package (W4) → `server/guest` pages only; wordcloud/rating types → W5.

---

## 7. Flagship tables (index)

- (a) interaction types × policies × render bindings — §2.3
- (b) participant kinds × capabilities — §5.3
- (c) transport per path with latency budget — §4.2
- (d) open vs Boomin-hosted — §4.6

---

## 8. Decisions for the founder

1. **Where do results become pixels — host-driven only, or may the DO also
   push to a hosted overlay?** This design says *host only* (§4.2): the set
   overlay page is fed by Producer, so what's on air follows the host's clock
   and works with zero server. The cost: no "Boomin-rendered overlay for a
   browser-studio show" until the RealtimeKit path gets the same bridge.
2. **Is the audience an identity kind on Boomin rooms (`live_room_guests.kind =
   'audience'`, no row per phone) or a separate concept?** This design adds the
   kind but **never writes a row per audience member** — audiences are DO-only
   state; only aggregates land in Postgres. Approving this keeps ROOM_ACCESS
   slice 2 small; rejecting it means an `audience_members` table and a
   retention policy.
3. **Room codes: 4 letters (Jackbox-style, per show, guessable-but-gated) or
   the existing long room links only?** Phones need something typeable; this
   design adds a short code that resolves only while the room is open, with
   Turnstile after misses. Alternative: QR-only from the set (no typeable
   code), which is safer and worse on a second screen.

---

## 9. Research

Three passes, 2026-09-04: platforms (Twitch/YouTube/Kick/Discord/Zoom/MixPlay),
guest tools + audience games + safety, transport + segmentation. Every claim
below has its URL; where a vendor help page could not be fetched directly the
finding is marked (index).

### 9.1 The ten findings that changed the design

| # | Finding | Source | What it changed |
|---|---|---|---|
| 1 | **MixPlay was the right model and it is dead.** Participants → Groups → Scenes → Controls; the game client moves cohorts between scenes; `getTime` for server-clock sync; **cooldown = a unix-ms timestamp on the control**; a per-method leaky-bucket `setBandwidthThrottle`; Sparks are charged only when the game client *captures* the transaction. Archived 2020. | https://dev.mixer.com/guides/mixplay/protocol/specification · https://github.com/mixer/interactive-node · https://mixer.github.io/interactive-java/com/mixer/interactive/GameClient.html | `server_now` in every frame; `cooldown_until` as a timestamp; render bindings per role are our "groups→scenes"; capture-on-success is how Boomin paid votes should charge |
| 2 | **Twitch Extensions cap PubSub at 5 KB and ~1 msg/s per channel — and that is enough for every extension on Twitch.** Roles live only in a signed JWT (`broadcaster|moderator|viewer|external`); opaque ids `U…` (stable, linked) vs `A…` (anonymous, per session); front-end context is explicitly unvalidated. | https://dev.twitch.tv/docs/extensions/reference/ · https://dev.twitch.tv/docs/extensions/building/ · https://github.com/twitchdev/issues/issues/612 | deltas + snapshot-on-connect at ≤ 4 Hz to phones; role in the capability token only; the identity ladder anonymous → pseudonymous → named |
| 3 | **Twitch's paid-currency policy line: Bits may fund votes, unlocks and gameplay; never gambling, loot, sweepstakes, or betting on outcomes** (6.1.x vs 6.2.x). Predictions themselves are lock-then-resolve with a **24 h auto-refund**. | https://dev.twitch.tv/docs/extensions/guidelines-and-policies/ · https://dev.twitch.tv/docs/api/predictions/ | the open/Boomin table's money row: paid extra votes yes, wagers no; any future `stake` block auto-refunds unresolved |
| 4 | **Jackbox solved the audience phone a decade ago:** 4-letter code with an offensive-combination blocklist (later 3-word codes), room lookup *before* the socket returns `{full, locked, moderationEnabled, passwordRequired, audienceEnabled}`, device `user-id` UUID in the socket URL for reconnect, a moderator page that pre-approves every text/drawing, three filter levels that **reject at entry**, "hide room code until cued", and **extended timers to offset stream delay**. Audience up to 10 000. | https://github.com/SergeyMC9730/jackboxapi-re · https://github.com/InvoxiPlayGames/johnbox · https://support.jackboxgames.com/hc/en-us/articles/15794773430295-How-does-Moderation-work · https://www.jackboxgames.com/blog/streaming-moderation-accessibility-features-jackbox-party-pack-eight · https://www.jackboxgames.com/blog/room-censored-codes | the door (`GET /a/:code` probe first), `stream_delay_ms`, `filter: off|moderate|strict`, hidden-until-cued codes, Poll Mine's "audience as one bloc" |
| 5 | **Durable Objects: outbound WebSocket messages are free, inbound billed 20:1, no per-object socket cap is published (32 768 circulates informally), ~1 000 req/s per object is the guidance, and there is no published 10k-viewer fan-out benchmark.** Attachment ≤ 16 KB; alarms are one-per-object, at-least-once, can slip up to a minute in failover. | https://developers.cloudflare.com/durable-objects/platform/pricing/ · https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ · https://developers.cloudflare.com/durable-objects/api/alarms/ · https://developers.cloudflare.com/durable-objects/best-practices/websockets/ | hub-and-spoke from day one (`RoomState` + `RoomRelay:<n>` ≤ 1 000 sockets), a schedule table behind the single alarm, host-rendered countdowns |
| 6 | **Cloudflare's SFU now has real DataChannels** (publisher→subscribers, `waitForAck`, single `canReply` subscriber, and since 2026-08-13 `ordered`/`maxRetransmits`/`maxPacketLifeTime` honoured end-to-end); egress $0.05/GB after 1 TB shared with TURN; TURN creds via `generate-ice-servers`, max TTL 48 h. WebTransport is Baseline since Safari 26.4 (Mar 2026) but **not available in Workers/DOs**. | https://developers.cloudflare.com/realtime/sfu/datachannels/ · https://developers.cloudflare.com/changelog/post/2026-08-13-datachannels-reliability-ordering/ · https://developers.cloudflare.com/realtime/turn/generate-credentials/ · https://github.com/cloudflare/workerd/issues/6451 | p2p data channel for guests today; the SFU data channel is the Boomin browser-studio (RealtimeKit) path later, not a WebTransport one |
| 7 | **Vision person segmentation has one published revision; `.fast` is the streaming tier (~256×144, ~10 ms class), `.balanced` ~960×540 runs 60 fps on M1 per developers; the request is stateful and must be reused per stream; `OneComponent16Half` is the Metal-friendly output; instance masks (macOS 14) cap at 4 people.** `isPortraitEffectEnabled` is read-only; ARKit masks are iOS-only. | https://developer.apple.com/tutorials/data/documentation/vision/vngeneratepersonsegmentationrequest.json · https://developer.apple.com/videos/play/wwdc2021/10040/ · https://www.kodeco.com/29650263-person-segmentation-in-the-vision-framework/page/2 · https://developer.apple.com/forums/tags/vision?page=2 · https://developer.apple.com/tutorials/data/documentation/vision/vngeneratepersoninstancemaskrequest.json | the provider contract (§3.1): fast tier for occlusion + bounds, one request per guest source, 16-bit mask texture, no dependence on system Portrait mode |
| 8 | **Windows is harder than the handoff assumes:** MediaPipe's GPU delegate is not supported on Windows; DirectML is in "sustained engineering" with new work in Windows ML (vendor EPs need 24H2); obs-backgroundremoval shows a 5 → 26 ms DirectML cliff above 480×270; Windows Studio Effects exposes a per-frame **segmentation mask** via `KSPROPERTY_CAMERACONTROL_EXTENDED_BACKGROUNDSEGMENTATION_MASK` on NPU boxes. | https://github.com/google/mediapipe/issues/5126 · https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html · https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/overview · https://github.com/locaal-ai/obs-backgroundremoval · https://learn.microsoft.com/nl-nl/windows-hardware/drivers/stream/ksproperty-cameracontrol-extended-backgroundsegmentation | swappable mask providers per platform with ORT+DirectML at scale 0.25 as the baseline and Studio Effects' mask as a free second provider |
| 9 | **Hit-testing from a mask is a dwell problem, not a latency problem.** Kinect used hover-fill dwell and later preferred an explicit push because dwell tires; MS patents describe firing on velocity/acceleration before the gesture completes; MediaPipe HandLandmarker is 12–17 ms; the recipe is 1€/Kalman smoothing + 1–2 frames of extrapolation + big targets + 300–800 ms dwell, sending compact hit events, never masks. | https://www.nngroup.com/articles/kinect-gestural-ui-first-impressions/ · https://www.motioncapturewithkinect.knight.domains/wp-content/uploads/2024/11/Human_Interface_Guidelines_v1.8.0-2.pdf · https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker · https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8578302 | §3.1's dwell-only v1, the silhouette-only fallback, no fast-motion mechanics |
| 10 | **Moderation norms converge on "hold, never delete; retract on the bus; TTL the hold."** Twitch AutoMod (0–4) holds for approval; YouTube "hold for review" None/Basic/Strict; Streamlabs Alert Moderation with expiring vs unlimited holds; StreamElements emits `delete-message` so widgets retract rendered text; Workers' Rate Limiting binding is per-colo and approximate by design; `obscenity` for entry-time filtering; OpenAI omni-moderation is free and ~20 ms; Llama Guard 3 on Workers AI; Turnstile tokens are 300 s single-use. | https://docs.streamelements.com/overlays/custom-widget-events · https://support.streamlabs.com/hc/en-us/articles/50635852871579-Quick-Guide-Setting-up-Streamlabs-Alerts · https://support.google.com/youtube/answer/9826490?hl=en · https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · https://www.npmjs.com/package/obscenity · https://developers.openai.com/api/docs/guides/moderation · https://developers.cloudflare.com/workers-ai/models/llama-guard-3-8b/ · https://developers.cloudflare.com/turnstile/concepts/widget/ | `hold_ttl_ms`, `retract` frames, DO-resident buckets, the open word list + optional hosted classifier split |

### 9.2 Platform mechanics (what exists, with the numbers)

**Twitch.** Extension views `viewer|dashboard|config`, anchors `component|panel|video_overlay`, mobile via `?platform=mobile` (https://dev.twitch.tv/docs/extensions/reference/). EBS verifies the viewer JWT and signs `role:"external"` JWTs; PubSub targets `broadcast|global|whisper-<id>`, 5 KB, 100 req/min per (client, broadcaster) (https://dev.twitch.tv/docs/extensions/building/, https://dev.twitch.tv/docs/api/reference). Config service: three 5 KB segments (developer/broadcaster/global). Bits products 1–10 000 Bits, immutable SKUs, per-product "broadcast" toggle for `onTransactionComplete`, receipts are JWTs (https://dev.twitch.tv/docs/extensions/monetization/). Rig retired Jan 2023 (https://discuss.dev.twitch.com/t/end-of-support-for-the-twitch-developer-rig/42995/). Predictions 2–10 outcomes, window 30–1800 s, `ACTIVE→LOCKED→RESOLVED|CANCELED`, 24 h auto-refund (https://dev.twitch.tv/docs/api/predictions/). Polls 2–5 choices, 15–1800 s, one free vote, optional channel-points votes 0–1 000 000 (https://dev.twitch.tv/docs/api/polls/). Channel Points rewards: ≤ 50 per channel, `max_per_stream`, `max_per_user_per_stream`, `global_cooldown_seconds`, redemption queue `UNFULFILLED→FULFILLED|CANCELED` (https://dev.twitch.tv/docs/api/reference/#create-custom-rewards). Hype Train (index): ≥ 2 unique contributors within 5 min to start, 5-min levels, ≥ 1 h cooldown, EventSub v2 with `top_contributions` (https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/, https://stream-rise.com/blog/hype-train-guide).

**YouTube Live.** `liveChatMessages.list` returns `pollingIntervalMillis` you must honour; `streamList` is the push alternative; message types include `superChatEvent`, `pollEvent` (single `activePollItem`), `userBannedEvent`, `sponsorOnlyModeStartedEvent` (https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list, https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList). Super Chat: amount sets colour, length and pin time; < $5 never enters the ticker; caps $500/day, $2 000/week (https://support.google.com/youtube/answer/9178363). Slow mode 1–300 s; members-only and subs-only exclusive (https://support.google.com/youtube/answer/9826490?hl=en).

**Kick.** Chat `POST /public/v1/chat` ≤ 500 graphemes / 2 048 bytes, `reply_to_message_id`; webhooks incl. `channel.reward.redemption.updated` (`pending|accepted|rejected`), `kicks.gifted` with `pinned_time_seconds`, `moderation.banned` with `expires_at` (https://docs.kick.com/apis/chat, https://docs.kick.com/events/event-types). ~100 KICKs ≈ $1.09; 95/5 split (https://kick.com/kicks-usage-policy, https://help.kick.com/en/articles/15159722-understanding-kick-s-revenue-split).

**Discord Activities.** iframe on `<client>.discordsays.com`; all egress through `/.proxy/` URL mappings, CSP-blocked otherwise; **WebRTC unsupported**; `instanceId` is the room key and the server can verify membership via `GET /applications/{app}/activity-instances/{id}`; events `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`, `SPEAKING_START/STOP`; SKUs durable/consumable/subscription with "trust but verify" entitlement re-checks (https://docs.discord.com/developers/activities/development-guides/networking, https://docs.discord.com/developers/activities/development-guides/multiplayer-experience, https://docs.discord.com/developers/monetization/implementing-iap-for-activities). Colyseus one-room-per-instance example (https://colyseus.io/blog/discord-embedded-sdk/).

**Zoom Layers.** Immersive/Presentation/Camera/Controller modes; `runRenderingContext({view, defaultCutout: person|…})`, `drawParticipant({cutout:"person", zIndex})`, `drawImage`, `drawWebView` (camera mode only); **only the host may enter immersive, one instance at a time**; controller ↔ rendered app via `postMessage` (https://developers.zoom.us/docs/zoom-apps/guides/layers-api/, https://developers.zoom.us/docs/zoom-apps/guides/layers-using-api/). Native Immersive View composites up to 25 (https://support.zoom.us/hc/en-us/articles/360060220511-Immersive-View). This is the closest shipped thing to "people as cutouts on an app-drawn set" — and it is closed, host-only, and cannot show a webview in immersive mode.

**Open-source / historical.** Twitch Plays Pokémon: anarchy vs 20 s democracy windows with asymmetric switch thresholds (https://twitchplayswiki.fandom.com/wiki/Democracy). Crowd Control: per-user + global cooldowns, demand-based price scaling with decay, 5-min queue auto-refund (https://developer.crowdcontrol.live/, https://crowdcontrol.live/blog/complete-guide-to-the-crowd-control-effect-manager-2026-update). Firebot (GPL-3) effect queues with native poll/prediction/redemption effects (https://github.com/crowbartools/Firebot); Streamer.bot action queues (https://docs.streamer.bot/); Kruiz Control browser-source trigger scripts (https://github.com/Kruiser8/Kruiz-Control).

### 9.3 Guest tools

StreamYard: backstage guests see and hear the program; Greenroom is a separate private call; free 6 / paid 10 on screen; guests share screen, slides, private chat, read comments; Local Recording = per-person video + 48 kHz WAV uploaded after; mix-minus on by default (https://support.streamyard.com/hc/en-us/articles/360043291612-Guest-instructions, https://support.streamyard.com/hc/en-us/articles/6342816437268-Using-the-Greenroom, https://support.streamyard.com/hc/en-us/articles/10725401176596-Local-Recording-of-your-Live-Stream). Riverside: green room with device picker, 100 participants / 9 on screen / 10 recorded tracks, **progressive background upload** of local recordings, host layout pushed with guest override, producers invisible on air (https://riverside.com/faq, https://support.riverside.com/hc/en-us/articles/22596801513373-Change-your-layout-in-the-studio-hosts-and-producers). Restream Studio: 5/9 guests, guests never appear until the host brings them in (https://support.restream.io/en/articles/9184240-what-you-can-do-as-a-guest-in-restream-studio). Ecamm Interview Mode: 10 guests on Apple silicon, greenroom sees show + comments (https://support.ecamm.com/en/articles/4494648-interview-mode-faq). Streamlabs Collab Cam: 1 free / 11 Ultra, guest audio is a separate source (https://streamlabs.com/content-hub/post/streamlabs-collab-cam-extends-support-for-up-to-11-guests).

VDO.Ninja is the reference for **URL-parameter roles and a control API**: `&push/&view/&room/&director/&scene/&solo`, `&scene=1` idles inactive streams at ~400 kbps for instant switch, `&broadcast` for a director-only return feed (with the hall-of-mirrors warning), `&mixminus`, `&remote` PTZ, slot-numbered targets 1–99, `wss://api.vdo.ninja` actions (mic/camera/volume/record/togglehand/togglescreenshare/sendChat/layout/soloVideo/room timers), MIDI, and an IFRAME API with `sendData` over the data channels and `getVideoFrame` (https://docs.vdo.ninja/advanced-settings/mixer-scene-parameters/scene, https://docs.vdo.ninja/advanced-settings/video-parameters/broadcast, https://docs.vdo.ninja/advanced-settings/api-and-midi-parameters/api/api-reference, https://docs.vdo.ninja/guides/iframe-api-documentation/iframe-api-basics). Our control catalog (§5.2) is a typed subset of that action list.

### 9.4 Overlay/widget architecture

StreamElements: widget = HTML/CSS/JS/Fields JSON/Data; fields template as `{{name}}`; one `onEventReceived` bus with `listener` discriminators (`tip-latest`, `message`, `delete-message`, `event:skip`, `alertService:toggleSound`, `kvstore:update`, `widget-button`) (https://docs.streamelements.com/overlays/widget-structure, https://docs.streamelements.com/overlays/custom-widget-events). Streamlabs: Alert Moderation (approve before show; expiring vs unlimited), Alert Parries (interrupt policy), Monitor-only mute (https://support.streamlabs.com/hc/en-us/articles/50635852871579-Quick-Guide-Setting-up-Streamlabs-Alerts). OBS browser source: transparency is page alpha (`body{background:rgba(0,0,0,0)}`), control levels 0–5 (`getControlLevel`, `obsSceneChanged`, `obsSourceVisibleChanged`, …), per-source CEF page composited in z-order, "shutdown when not visible" (https://obsproject.com/kb/browser-source, https://github.com/obsproject/obs-browser/blob/master/README.md). Our set overlay page (§4.2) follows the same contract and adds `retract`.

### 9.5 Audience games

Kahoot: points = floor((1 − (t/T)/2) × max), 10 s–4 min timers, universal bad-name list with auto-replacement, adjective+animal nickname generator (https://support.kahoot.com/hc/en-us/articles/115002303908-How-points-work, https://support.kahoot.com/hc/en-us/articles/115002201267-How-to-handle-inappropriate-nicknames). Among Us: discussion 15–300 s then a voting window, pick + confirm, "Anonymous Votes", reveal after timer or all-in (https://among-us.fandom.com/wiki/Voting). Slido: Q&A anonymous/named, upvotes, pre-approval moderation, English profanity filter always on for Q&A (https://community.slido.com/q-a-settings-222). Mentimeter: moderation link, profanity filter masks rather than rejects, post-hoc word-cloud deletion (https://help.mentimeter.com/en/articles/1840522-moderate-your-q-a-session-to-ensure-a-great-experience).

### 9.6 Transport

DataChannel options `ordered`, `maxPacketLifeTime|maxRetransmits` (mutually exclusive); SCTP packets ~1 280 bytes so unreliable messages must fit one MTU; default `max-message-size` 64 KB, ≤ 16 KiB chunks cross-browser; `bufferedAmountLowThreshold` for backpressure (https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel, https://hpbn.co/webrtc/, https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels, https://webrtc.link/en/articles/rtcdatachannel-usage-and-message-size-limits/). Safari ≥ 11 (https://caniuse.com/mdn-api_rtcdatachannel). Measured DC-vs-WS differences on clean links are ~10–15 ms; the win is on lossy links (https://www.videosdk.live/developer-hub/websocket/which-is-better-and-when-to-use-it-webrtc-or-websocket). Cloudflare SFU: sessions/tracks model, per-track cascading trees, 50 API calls/s per session, tracks GC after 30 s idle, `partytracks` + `cloudflare/meet` reference (https://developers.cloudflare.com/realtime/sfu/limits/, https://blog.cloudflare.com/cloudflare-calls-anycast-webrtc/, https://github.com/cloudflare/meet). RealtimeKit $0.002/min A/V participant (https://developers.cloudflare.com/realtime/realtimekit/pricing/). DO hibernation: 10 s idle → hibernate; outbound sockets/timers/alarms keep an object awake; deploys drop every socket; per-message limit 32 MiB; SQLite DOs 10 GB (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/, https://developers.cloudflare.com/durable-objects/platform/limits/). Placement is near first `get()` and permanent; `locationHint` best-effort (https://developers.cloudflare.com/durable-objects/reference/data-location/). partyserver / Agents SDK are thin wrappers whose `broadcast()` is a loop over sockets (https://github.com/cloudflare/partykit/blob/main/packages/partyserver/README.md, https://developers.cloudflare.com/agents/concepts/agent-class/).

### 9.7 Segmentation

Vision: `.accurate|.balanced|.fast`, `OneComponent8|16Half|32Float`, ≤ 4 people ≥ 50% frame height for best results (https://developer.apple.com/videos/play/wwdc2021/10040/); `.accurate` ~60 ms fixed regardless of input size on iPhone 13 — the model runs at a fixed internal resolution (https://developer.apple.com/forums/thread/714775); hand pose 21 joints (https://developer.apple.com/tutorials/data/documentation/vision/vndetecthumanhandposerequest.json); `CVMetalTextureCache` zero-copy with the strong-ref-until-completion rule (https://developer.apple.com/forums/thread/694939, https://developer.apple.com/videos/play/wwdc2022/110565/). Alternatives: RobustVideoMatting CoreML at fixed 1280×720/1920×1080 FP16 with a Deep Guided Filter upsample (https://github.com/PeterL1n/RobustVideoMatting/tree/coreml), MODNet 6.5 M params (https://arxiv.org/pdf/2011.11961); coremltools models silently falling off the ANE (https://github.com/apple/coremltools/issues/2004). MediaPipe SelfieSegmenter 256×256 / landscape 144×256, ~1–2 ms raw on Pixel 6 GPU, 33–218 ms task-level on CPU (https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter). NVIDIA Maxine AI Green Screen: RTX-only, 8-bit alpha at input res, temporal state (https://docs.nvidia.com/maxine/vfx/1.2.0.0/Filters/AIGreenScreen.html). Windows Studio Effects composite camera + mask metadata (https://learn.microsoft.com/en-us/windows/apps/develop/windows-integration/studio-effects, https://github.com/microsoft/Windows-Camera/tree/master/Samples/WindowsStudio).

### 9.8 Safety

Workers Rate Limiting binding: per-key, per-colo, 10 or 60 s periods, "not an accurate accounting system" (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/); DO token bucket for exact global limits (https://shivekkhurana.com/blog/global-rate-limiter-durable-objects/). Perspective API ~1–1.5 s and biased — offline only (https://www.lassomoderation.com/blog/perspective-api-toxicity/). Twitch AutoMod holds at every level (https://twitch-help.fandom.com/wiki/How_to_Use_AutoMod). Shadow-banning: right for anonymous/bot traffic, wrong for accounts (https://getstream.io/glossary/shadow-ban/, https://blog.disqus.com/introducing-shadow-banning-and-timeouts). Turnstile Managed/Non-interactive/Invisible; token 300 s single-use (https://developers.cloudflare.com/turnstile/concepts/widget/). Fingerprinting is probabilistic behind NAT; a signed device token behind invisible Turnstile is the Jackbox/Kahoot pattern (https://docs.castle.io/docs/device-fingerprinting).
