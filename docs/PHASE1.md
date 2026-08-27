# Phase 1 — Producer v0.1: one client, two backends

Status: DRAFT v3 for review. Supersedes the two-mode/local-engine draft.

The desktop app is a **client of a Producer endpoint**. There are two
backends implementing the same API contract:

- **Connected (default):** the endpoint is `api.boomin.ai`. Free Boomin
  account, publishing in ~2 minutes, content routes through Boomin.
- **Independent (self-hosted):** the endpoint is the user's own
  **`producer-server`** — a new open-source (AGPL) repo they deploy to
  their own Cloudflare account. Their server, their storage, their
  platform keys. Nothing ever touches Boomin, and they never pay Boomin
  a dollar. Ghost / n8n / Mastodon model.

**Why self-hosting is the independent answer (not per-channel local
tricks):** cross-posting's value is *all channels, one schedule, laptop
closed*. A server the user owns delivers that wholesale — and dissolves
every hard problem the local-engine draft was fighting:

| Problem (old draft) | Self-hosted server |
| --- | --- |
| Scheduled posts need the laptop open | Worker cron triggers run 24/7 free |
| IG/Threads media needs a public URL | their R2 bucket *is* the public URL |
| OAuth loopback uncertainty (spike S1) | server has a real HTTPS redirect URL |
| Media handoff / MediaSource bridges | deleted — not needed |
| Local queue + catch-up-on-launch logic | deleted — queue lives server-side |
| BYO secrets juggled in a desktop keychain | secrets live on their worker |

**Launch platform matrix:**

| Platform | Connected (`api.boomin.ai`) | Independent (self-hosted) |
| --- | --- | --- |
| Instagram | **v0.1** (hosted integration live today) | **v0.1** — BYO Meta app |
| Threads | later (needs Boomin app review) | **v0.1** — BYO Meta app |
| Facebook Pages | later (needs Boomin app review) | **v0.1** — BYO Meta app |

Independent mode now covers the **full trio at launch** — the server
model made independent-Instagram possible instead of deferred.

---

## 1. Product definition

**Connected user:** a creator who wants posting in minutes and accepts
that content routes through Boomin (disclosed plainly).

**Independent user:** a technical creator or brand who can run
`wrangler deploy` and wants total self-sufficiency. For them, **the
self-hosting guide is the onboarding** — it is a first-class product
artifact, not an afterthought.

**Success criteria for v0.1 (all must hold):**

1. **Connected:** fresh install → signed in (email OTP) → first
   Instagram post in **under 5 minutes**.
2. **Independent:** following the guide, a technical user goes from
   nothing → deployed server → all three Meta-trio channels connected
   (their own Meta app) → a scheduled post that fires **with their
   computer off**, in **under an hour**, paying $0.
3. **One contract:** the desktop app has no mode-specific publish logic —
   it points at an endpoint and authenticates. Switching modes is a
   Settings change, and both can run side by side.
4. **Disclosure:** the active endpoint is always visible; connected mode
   states plainly what routes through Boomin; independent mode states
   that nothing does.
5. Publishing is per-channel atomic with plain-language errors and
   retry-only-the-failure; no double-posts (idempotent submits, server-
   side checkpointing).
6. The app updates itself from GitHub Releases (signed manifest).
7. Secrets hygiene: desktop keychain holds only session tokens;
   platform secrets live server-side (Boomin's vault or the user's
   worker secrets); nothing sensitive in logs or the webview.

**Non-goals for v0.1:** YouTube/X/TikTok senders, multistreaming, media
generation, analytics, comment management, carousels/Stories, team
features, the network opt-in surface (Phase 2), mobile, `producerd`-style
home-machine daemons (the server *is* the daemon).

---

## 2. Architecture

### 2.1 The pieces

```
┌── producer (this repo, AGPL) ────────────────────────────────┐
│  Tauri 2 desktop app                                         │
│   ├─ UI: composer, queue, history, settings, onboarding      │
│   ├─ vault: OS keychain (endpoint session tokens only)       │
│   └─ client: typed client for the Producer API contract      │
└──────────────────────────────────────────────────────────────┘
                 │ same API contract │
        ┌────────┴────────┐  ┌───────┴──────────────────────────┐
        │ api.boomin.ai   │  │ producer-server (new repo, AGPL) │
        │ (closed, lean   │  │ Cloudflare Worker + Hono         │
        │  contract       │  │  ├─ auth: single-user bearer     │
        │  endpoints —    │  │  ├─ channels: BYO Meta OAuth     │
        │  decision D1)   │  │  ├─ media: R2 (public serving)   │
        │                 │  │  ├─ queue: state machine + cron  │
        │                 │  │  ├─ senders: TS modules ★        │
        │                 │  │  └─ store: D1 (SQLite)           │
        └─────────────────┘  └──────────────────────────────────┘
```

★ = the community extension point. Senders are TypeScript modules in an
open repo — a far larger contributor pool than Rust trait impls, and
AGPL on server code is exactly what AGPL is for (no one can SaaS a fork
without opening their changes).

### 2.2 The API contract

One OpenAPI spec, versioned in the `producer-server` repo, implemented by
both backends: auth/session, channels (list/connect/disconnect), media
(**`upload_id` OR `url`** — see below), posts (create/update/list),
schedule, publish-now, job status, history.

**Media-by-URL — the free-forever connected tier.** Meta's publish APIs
fetch media from a URL; the backend never needs the bytes. So the
contract accepts either an uploaded media id (stored by the backend) or
a plain public URL (the user's own R2/S3 bucket, Dropbox raw link,
their CDN — anywhere fetchable). A connected user on BYO storage costs
Boomin only metadata (captions, schedules — kilobytes): **they can stay
connected, scheduled, laptop-closed, and never owe Boomin a dollar.**
Boomin-managed storage is the paid *convenience* (quota + meter + purge
per D2), never a toll on publishing. The desktop app uploads directly
from disk to the user's bucket (their credentials, held locally in the
keychain) and submits the URL. One caveat, surfaced in the UI: a
URL-sourced scheduled post requires the object to remain reachable until
it fires — early deletion produces a clear, retryable error. **Decision D1 (api repo workstream):** the hosted
side implements this contract as new lean `/v1/app/producer/*` endpoints
rather than exposing the web app's unit/collection model. The contract is
the product's spine — desktop, hosted, and self-host all meet there.

### 2.3 producer-server (the new repo)

- **Stack:** Cloudflare Worker, Hono, **D1** (not Neon — one vendor, one
  account, one `wrangler deploy`, free tier covers a single user
  forever; "bring your own Postgres" is a documented variant, not the
  default), R2 for media with public serving enabled, cron triggers for
  the scheduler, worker secrets for platform keys.
- **Tenancy:** single-user by design. Auth is one bearer token generated
  at deploy time and pasted into the desktop app. No orgs, no brands,
  no billing — this is what keeps the repo lean and auditable.
- **Queue:** the proven state machine (draft → scheduled → queued →
  publishing → published/failed) with exponential backoff, error
  classes (`Retryable`/`TokenExpired`/`RateLimited(until)`/`Permanent`),
  and the idempotency rule: platform-side IDs (upload sessions, IG
  containers) persist before the call that consumes them. Cron tick
  advances due jobs; multi-step IG container flows checkpoint in D1.
- **Senders v0.1:** Instagram (feed image + reel via container flow —
  media URLs served from the user's R2), Facebook Pages (direct upload;
  native `scheduled_publish_time` used opportunistically), Threads
  (text + media — media URL problem solved by R2).
- **OAuth:** the worker's own HTTPS URL (`*.workers.dev` or custom
  domain) is the redirect URI for the user's BYO Meta app — no loopback
  gymnastics. Connect flows can be driven from the desktop app (it opens
  the browser at `https://<their-server>/connect/instagram`).
- **Media retention (D2, self-host edition):** the user's bucket, the
  user's rules — default keep (it's their storage), one-click purge of
  published media, optional auto-delete after publish.

### 2.4 The desktop app (radically simplified)

No local publish engine, no local scheduler, no media bridges. It is:
shell + onboarding chooser + composer/queue/history rendered from the
API + settings + updater + keychain for session tokens. All state of
record lives at the endpoint. Endpoints are per-channel-set, so a user
can run Connected and Independent side by side.

### 2.5 The zero-dollar independent stack (the honest math)

Cloudflare free tier: Workers 100k requests/day, cron triggers included,
D1 5GB + generous daily reads/writes, R2 10GB storage with **zero egress
fees**, `workers.dev` HTTPS domain included. A single creator posting
daily consumes a rounding error of every one of those. Their costs:
**$0 to Boomin ever (by design), $0 to Cloudflare at personal scale**,
plus their own Meta app (free) and technical effort. If they outgrow
10GB of stored media, purge or pay Cloudflare cents — never Boomin.

---

## 3. Feature spec

### 3.1 Onboarding chooser (first run)

> **Connect with Boomin** — free account, posting in ~2 minutes. Your
> posts route through Boomin's servers.
>
> **Use your own server** — deploy the open-source producer-server to
> your own Cloudflare account (guide: ~1 hour, $0), then paste your
> endpoint + token here. Nothing touches Boomin, ever.

Re-enterable from Settings; nothing is locked in.

### 3.2 The self-hosting guide (first-class deliverable)

Lives in the `producer-server` repo (`SELF_HOSTING.md`), maintained with
the same care as the app: create Cloudflare account → `wrangler deploy`
(D1 + R2 + cron provisioned by config) → generate the app token → create
your Meta app (screenshots + deep links; the old wizard content lives
here now) → set secrets → paste endpoint into Producer → connect
channels → test post → verify a scheduled post fires with the app
closed. Includes the free-tier cost table and an upgrade path note.

### 3.3 Composer

One draft → N channels (mixed endpoints). Text + one image or one
video/reel. Per-channel accordion (caption override, IG reel
share-to-feed, Threads reply-control, FB Page pick). Live server-side
preflight surfaced in the composer (caption limits, media constraints,
rate-limit budget — IG 100 posts/24h). Post now / Schedule / Draft.

### 3.4 Queue & history

Upcoming + in-flight with per-channel state chips (cancel / retry /
reschedule); history with links to live posts and plain-language errors.
All scheduling is server-side on both endpoints — **"fires with your
computer off" is true everywhere**, which retires the old per-channel
scheduling caveat table entirely.

### 3.5 Settings

Endpoints (Boomin sign-in; custom endpoint + token, connection health) ·
Channels (per-endpoint, reconnect, scopes) · Publishing defaults ·
**Privacy — "what talks to what"** (per-endpoint disclosure, always one
click away) · Behavior (notifications) · Updates · Advanced (log viewer).

### 3.6 Updater & releases

`tauri-plugin-updater` + minisign-signed manifest on GitHub Releases
(private key: CI secret + offline backup). `tauri-action` workflow:
tag → win/mac/linux builds → sign-if-secrets-present (Apple/Windows
steps no-op until certs are funded) → draft release with changelog.

---

## 4. Security & privacy posture

- Disclosure is a feature: per-endpoint data-flow statements; the active
  endpoint always visible in the shell.
- Desktop keychain: session tokens only. Platform secrets never exist
  client-side in either mode.
- producer-server: bearer auth on every route, OAuth `state` single-use,
  tokens encrypted at rest in D1 (AES-GCM, key in worker secrets),
  log scrubbing, R2 public access scoped to a media prefix only.
- Real CSP in the webview (drop scaffold's `csp: null`); Tauri
  capabilities minimized.
- **No telemetry in v0.1** in the app or producer-server. What Boomin
  observes in connected mode is the API traffic itself, disclosed.
- `SECURITY.md` with disclosure contact in both repos at flip-public.

## 5. Testing strategy

- producer-server: queue state-machine unit tests (every edge, backoff,
  idempotent resume), sender integration tests against a mock Graph
  server (golden fixtures incl. the multi-step IG container flow),
  cron-tick tests, contract tests generated from the OpenAPI spec.
- Desktop: client contract tests against a local producer-server
  instance (`wrangler dev`) — the self-host stack doubles as the test
  harness; component tests for composer preflight rendering.
- Manual pre-release checklist on all three OSes (WebView2 / WKWebView /
  WebKitGTK) against real dev-mode Meta apps.
- CI: existing 3-OS build matrix + engine/server tests + a release
  workflow dry-run on a `v0.0.x-rc` tag.

## 6. Build order

| M | Deliverable | Proves |
| --- | --- | --- |
| **M1** | API contract v0 (OpenAPI) + desktop skeleton (client, vault, onboarding chooser) + D1 decision landed in api repo | the spine |
| **M2** | Connected: OTP sign-in, workspace auto-provisioning (user never sees "brand"), channel list, **compose → post now to Instagram** | the 5-minute path — demo-able |
| **M3** | Connected scheduling + job status + history | laptop-closed story, mode one |
| **M4** | `producer-server` repo: worker + D1 + R2 + cron + queue engine + **Instagram sender** (BYO app, container flow, R2 media) | the hard sender, on the open stack |
| **M5** | Facebook + Threads senders; SELF_HOSTING.md guide complete; desktop custom-endpoint mode wired end-to-end | full trio, independent |
| **M6** | Settings + disclosure pages + updater UX + release workflow e2e | shippable |
| **M7** | Hardening, SECURITY.md + CLA bot (both repos), README + demo GIF + comparison table, sender backlog as labeled issues, launch collateral | flip public |

`producer-server` is built in the open from M4 — it is arguably the
stronger build-in-public artifact of the two repos. Remaining spike:
**S3 only** (walk the real Meta BYO app setup as a fresh user; the
screenshots become SELF_HOSTING.md). S1 (loopback) and S2 (resumable
upload) died with the local-engine design.

## 7. Risk register

| Risk | Level | Mitigation |
| --- | --- | --- |
| Two repos of scope for one launch | **High — the top risk** | producer-server is deliberately lean (single-user, no billing/orgs); the contract keeps surfaces small; M4-M5 timebox; connected mode alone is a shippable fallback launch |
| D1 (lean hosted endpoints) slips | Med | Fallback: connected client temporarily rides existing unit endpoints behind the same desktop client interface |
| Hosted FB/Threads needs Meta app review (Boomin's app) | Med | Independent covers them at launch; hosted parity is a post-launch workstream, stated in the matrix |
| Meta BYO setup friction for self-hosters | Med | S3 makes the guide truthful; per-scope checklist in the connect flow; test post step |
| Cloudflare single-vendor for self-host | Low-Med | Free tier + zero egress is the best-in-class deal today; AGPL means the community can port the worker (it's Hono + SQLite — portable by construction); BYO-Postgres variant documented |
| Hosted uptime/cost is now OSS reputation | Med | Free-tier quotas server-side; status page; independent mode is the pressure valve |
| OSS-purist pushback on hosted-default | Low | The independent stack is *fully* capable at launch (all three platforms, $0) — the strongest possible answer |
| Meta policy/API drift | Med | Senders isolate versioned endpoints; preflight enums; pinned Graph versions |
| Unsigned macOS friction | Low | Known + accepted; guided note; signing when funded (first Sponsors goal) |

## 8. Launch definition (exit of Phase 1)

Both repos flip public together when: §1 success criteria pass on all
three OSes; a signed-manifest release has shipped and been consumed by
the updater; SELF_HOSTING.md has been executed start-to-finish by a
fresh account (S3); CLA bot active on both repos; disclosure pages
reviewed against actual data flows; README shows the 5-minute connected
demo AND the "your server, your rules, $0" independent story; Mac
unsigned-install note published; sender backlog (YouTube/X/TikTok)
posted as labeled issues in producer-server.
