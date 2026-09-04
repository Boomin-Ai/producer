# Self-hosting Producer

Producer speaks one contract to two kinds of endpoint. Which one a workspace
is decides exactly one thing in the app: whether the Boomin Network exists.

**The walkthrough lives in [`server/SELF_HOSTING.md`](../server/SELF_HOSTING.md)** —
deploy the open `producer-server` (a Cloudflare Worker: D1 + R2 + cron) to your
own account, set a `PRIMARY_TOKEN`, then pick **Use my own server** on the
sign-in screen and paste the worker URL + that token.

## The split

| | Open (your server) | Boomin Network |
|---|---|---|
| Cross-posting, scheduling, media | ✔ | ✔ |
| Multistream to your RTMP destinations | ✔ (local engine, no server needed) | ✔ |
| **Rooms and guests** — register rooms, share the join link, waiting room, admit / revoke, stage set, guest render sources in the show | ✔ | ✔ |
| Room sync across machines (rooms are server rows) | ✔ | ✔ |
| Network rail: connections, invitations, exact-handle lookup | — | ✔ |
| Room visibility (private / connections / public), "Live on the network" | — | ✔ |
| Appearance deals: Book, escrow, "Enter the show" | — | ✔ (the room must live on Boomin) |

In short: **everything about making a show, guests included, is open.** The
Boomin Network is the layer on top — verified, paid appearances on other
brands' shows — and it requires the room to be registered on Boomin, because
the deal, the escrow and the admit-settles-it rule are all server-side there.

## How the app decides

Every endpoint row is derived into `endpoint_kind: "boomin" | "selfhost"`
(`src-tauri/src/ipc.rs`, read in the UI through `endpointKind()` in
`src/lib/workspace.ts`). A brand scope (`brand_slug`) means Boomin; none means
your server. Guesting IPC (`room_register`, `room_guests`, `room_join_link`,
admit / revoke / stage) is endpoint-agnostic: the open server serves the same
`/v1/app/live/...` paths, authenticated with your primary token, and the join
link it returns is used **verbatim** — Producer never rewrites the host.

Network calls (`/v1/app/network/*`, deals, visibility) are only ever made when
the active workspace is a Boomin one. On a self-hosted workspace the Network
rail shows a single, dismissable invitation instead — dismiss it once and it
stays gone (Settings → *Show Network invitation again* brings it back). A
Boomin workspace can sit beside your server in the workspace switcher; your
shows stay where you put them.

## Guest media in the engine

The render pages Producer embeds for admitted guests come from your server's
origin. The CEF media grant is currently engine-wide
(`src-tauri/src/live/engine.rs`); the per-origin allow-list, when it lands,
must be derived from the endpoint — see the notes there and in
`live/graph.rs` (`ExtraSpec::Guest`).
