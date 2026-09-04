# Self-hosting Producer

Deploy your own Producer backend to your own Cloudflare account. When
you're done: the desktop app posts and schedules through **your**
server, media lives in **your** storage, your schedule fires 24/7 with
your laptop closed, and nothing ever touches Boomin. Cost at personal
scale: **$0** (Cloudflare's free tier covers all of it).

Time: ~20 minutes for the server, plus ~10 minutes per platform app.

## 1. Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org) ≥ 20 (for `npm`/`npx`)
- This repo: `git clone https://github.com/Boomin-Ai/producer && cd producer/server && npm install` (the server lives in the `server/` directory of the Producer repo; the old `producer-server` repo is archived)

## 2. Create the database and bucket

```sh
npx wrangler login
npx wrangler d1 create producer
npx wrangler r2 bucket create producer-media
```

Copy the `database_id` that `d1 create` prints into `wrangler.toml`
(replace `REPLACE_WITH_YOUR_D1_ID`).

## 3. Set your secrets

```sh
npx wrangler secret put PRIMARY_TOKEN          # invent a long random string — this is your endpoint token
npx wrangler secret put TOKEN_ENCRYPTION_KEY   # 32+ random chars; encrypts platform tokens at rest
npx wrangler secret put SIGNALING_SECRET       # 32+ random chars; signs guest signaling tickets (see "Guests")
```

Optional but recommended if you'll use agents, the CLI, or CI:

```sh
npx wrangler secret put AUTOMATION_TOKEN       # publish/read/upload only — safe to paste into tools
```

Generate strong values with e.g. `openssl rand -hex 32`.

## 4. Deploy

```sh
npx wrangler deploy
npm run db:migrate        # applies schema.sql to your remote D1
```

Wrangler prints your worker URL — something like
`https://producer-server.yourname.workers.dev`. Open
`https://<your-url>/v1/health` and you should see
`{"ok":true,"implementation":"producer-server",...}`.

## 5. Connect the desktop app

In Producer: **Add workspace → Use your own server**, paste your worker
URL and your `PRIMARY_TOKEN`. The app validates the token against
`/v1/session` and stores it in your OS keychain. (This first
authenticated call also teaches the server its own public URL, which
the scheduler needs — do it before your first scheduled post.)

## 6. Create your platform apps (bring your own keys)

You publish to your own accounts through your own Meta developer apps.
Development Mode is enough — no app review. All apps are created at
[developers.facebook.com](https://developers.facebook.com/apps).

For each platform you want, set the app id in `wrangler.toml` under
`[vars]`, the secret via `wrangler secret put`, and redeploy
(`npx wrangler deploy`).

### Instagram (Business/Creator accounts)

1. Create an app → add the **Instagram** product → choose "Instagram
   API with Instagram Login".
2. Add your Instagram account under **Instagram Testers** (App roles),
   and accept the invite from the IG app (Settings → Apps and websites).
3. In the product's Business Login settings, add the redirect URI:
   `https://<your-worker-url>/oauth/callback/instagram`
4. `INSTAGRAM_APP_ID` in wrangler.toml; `npx wrangler secret put INSTAGRAM_APP_SECRET`.

### Facebook Pages

1. Create an app → add **Facebook Login** (or Facebook Login for
   Business).
2. Valid OAuth Redirect URIs:
   `https://<your-worker-url>/oauth/callback/facebook`
3. `FACEBOOK_APP_ID` + `FACEBOOK_APP_SECRET` as above. Publishing
   targets a Page you manage.

### Threads

1. Create an app → add the **Threads API** use case.
2. Add yourself as a Threads Tester and accept in the Threads app.
3. Redirect URI: `https://<your-worker-url>/oauth/callback/threads`
4. `THREADS_APP_ID` + `THREADS_APP_SECRET` as above.

Then in Producer, connecting a channel opens your browser at your own
server's consent flow — sign in, approve, done. Channel authorization is
always a human browser action; automation tokens can never mint channels.

## 7. Guests (host ↔ guest video, no Boomin)

Two self-hosted Producers — or a Producer and anyone with a browser — can
do a host/guest show entirely on your worker. Producer talks to the same
`/v1/app/live/…` and `/v1/connect/guest…` routes it uses on Boomin, so
nothing in the app changes; only the base URL does.

**What the worker does:** keeps the room roster and the stage list, and
*introduces* the two peers over a WebSocket (a Durable Object per guest
session and per room). An SDP offer, an answer and a trickle of ICE
candidates cross it once, then audio and video flow **directly between
the host's machine and the guest's browser**. No media ever touches
Cloudflare or this worker, so a guest costs nothing per minute.

**Durable Objects on the free plan.** The signaling object is
SQLite-backed, which is the flavour the Workers Free plan includes:
Cloudflare's pricing page states that on the Free plan "only Durable
Objects with SQLite storage backend are available" (100k requests/day,
13,000 GB-s/day, 5 GB storage) —
<https://developers.cloudflare.com/durable-objects/platform/pricing/>
(verified 2026-09-04). `wrangler.toml` declares the class under
`new_sqlite_classes`, so `wrangler deploy` works on a free account.

**Setup:** `SIGNALING_SECRET` (step 3) is all it needs. It signs the
120-second tickets that open a signaling socket and derives each guest's
render key. Rotating it changes every guest render URL, so Producer
recreates its guest browser sources on the next roster poll.

**How a show works:**

1. In Producer, open the room's Guests panel → *Share link*. The worker
   mints a room join code (`…/connect/guest/room/gr_…`). Only its hash is
   stored, so the link is shown once; rotating it (`rotate: true`) invalidates
   the old one and revokes anyone still *waiting* on it — admitted guests
   stay on air unless you also pass `remove_admitted`.
2. A guest opens the link, types a name, and lands in **waiting**. Nothing
   they send can reach the show until you admit them (or you turned on
   `auto_admit` for a trusted panel).
3. Admitting hands Producer a stable render URL for that guest
   (`…/connect/guest/render/<id>?k=gk_…`) which becomes a browser source.
   Kicking someone is a server-side flip — the source keeps its framing and
   the guest's next reconnect is refused.
4. **Capacity** (`guest_capacity`, default 8) counts *admitted* guests only:
   waiting guests hold no connection, so a public link can't be used to
   exhaust the room. `stage_capacity` (default 4) bounds who is on stage at
   once. Both are columns on `live_rooms` — change them with
   `wrangler d1 execute producer --remote --command "UPDATE live_rooms SET guest_capacity = 12"`.

**TURN.** By default peers use free public STUN only, which succeeds on
most home networks. Symmetric NATs, corporate firewalls and some mobile
carriers (roughly 10-20% of connections) need a TURN relay, and a relay
does carry media, so it is the one part of this that costs money. When a
guest can see the room but never connects, set `ICE_SERVERS` in
`wrangler.toml` `[vars]` to a JSON array of `RTCIceServer` objects — for
example Cloudflare Calls TURN, coturn on a small VPS, or a metered
provider — and redeploy. No code changes; a malformed value falls back to
the STUN default and logs an error.

**What stays on Boomin.** Everything about *making* a show is here: rooms,
links, the waiting room, admit/kick, the stage, the signaling. What is not
here is anything that needs a second party's identity or money: a
*verified* brand guest (the host invites a named brand and the network
vouches for who arrives), knocking on another brand's open stage, and
**paid appearances** — appearance deals with escrow, stage-minimum clocks
and payouts. Those require the room to live on Boomin, because a deal
needs both sides on the same ledger. A self-hosted room answers
`network_unavailable` if a client sends `guest_brand_id`.

**Guest pages.** The join and render pages are static files served from
`public/guest/` at `/connect/guest/*`. If `public/guest/index.html` is the
placeholder ("guest bundle not built"), build the guest bundle into that
directory and redeploy.

## 8. Verify the laptop-closed promise

Schedule a test post a few minutes out, quit Producer entirely, and
watch the post land. The worker's every-minute cron is the scheduler —
your machine is not involved.

## What runs where (the honest data-flow statement)

- **Your worker (Cloudflare):** the queue, the schedule, encrypted
  platform tokens (AES-GCM under your `TOKEN_ENCRYPTION_KEY`), and your
  media in a **private** R2 bucket — exposed only through unguessable
  one-object capability URLs while a platform fetches it. Orphaned
  uploads are garbage-collected after an hour.
- **Meta:** receives your posts, from your own developer apps.
- **Guests' browsers ↔ the host's machine:** guest audio/video, directly
  over WebRTC. The worker only introduces the two peers (kilobytes, once)
  and keeps the roster; with `ICE_SERVERS` set, your TURN relay may carry
  media for guests behind strict NATs.
- **Boomin:** nothing. No calls, no telemetry, no account. If Boomin
  disappears tomorrow, this keeps working — guests included.

## Limits of the free tier (you will not hit these posting daily)

Workers: 100k requests/day, cron included · D1: 500 MB/database,
5 GB/account · R2: 10 GB-month stored, zero egress fees · Durable Objects
(SQLite-backed): 100k requests/day, 13,000 GB-s/day. A year of queue
history is megabytes; a guest show is a few hundred signaling requests
plus a ~3 s roster poll while the room is open.

## Updating

```sh
git pull && npm install && npx wrangler deploy && npm run db:migrate
```

The schema is idempotent; migrations never destroy data.
