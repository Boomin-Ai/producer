# Phase 1 — Producer v0.1: one client, two backends

Status: DRAFT v4 — incorporates staff review of v3 (architecture GREEN;
six corrections applied below). Freeze candidate: this version is
intended to become the implementation contract.

The desktop app is a **client of a Producer endpoint**. There are two
backends implementing the same API contract:

- **Connected (default):** the endpoint is `api.boomin.ai`. Free Boomin
  account, publishing in ~2 minutes, content routes through Boomin.
- **Independent (self-hosted):** the endpoint is the user's own
  **`producer-server`** — a new open-source (AGPL) repo they deploy to
  their own Cloudflare account. Their server, their storage, their
  platform keys. Nothing ever touches Boomin, and they never pay Boomin
  a dollar. Ghost / n8n / Mastodon model.

The segmentation is convenience vs. sovereignty, not free vs. paid:
Connected = "I want this to work." Independent = "I want to own the
entire execution path."

**Why self-hosting is the independent answer:** cross-posting's value is
*all channels, one schedule, laptop closed*. A server the user owns
delivers that wholesale:

| Problem (dead local-engine draft) | Self-hosted server |
| --- | --- |
| Scheduled posts need the laptop open | Worker cron triggers run 24/7 free |
| IG/Threads media needs a public URL | served by their worker's media gateway |
| OAuth loopback uncertainty | server has a real HTTPS redirect URL |
| Media handoff / MediaSource bridges | deleted — not needed |
| Local publish engine + catch-up logic | deleted — queue lives server-side |
| BYO secrets juggled in a desktop keychain | secrets live on their worker |

**Launch platform matrix:**

| Platform | Connected (`api.boomin.ai`) | Independent (self-hosted) |
| --- | --- | --- |
| Instagram | **v0.1** (hosted integration live today) | **v0.1** — BYO Meta app |
| Threads | later (needs Boomin app review) | **v0.1** — BYO Meta app |
| Facebook Pages | later (needs Boomin app review) | **v0.1** — BYO Meta app |

---

## 1. Product definition

**Connected user:** a creator who wants posting in minutes and accepts
that content routes through Boomin (disclosed plainly).

**Independent user:** a technical creator or brand who can run
`wrangler deploy` and wants total self-sufficiency. For them, **the
self-hosting guide is the onboarding** — a first-class product artifact.

**Success criteria for v0.1 (all must hold):**

1. **Connected:** fresh install → signed in (email OTP) → first
   Instagram post in **under 5 minutes**.
2. **Independent:** following the guide, a technical user goes from
   nothing → deployed server → all three Meta-trio channels connected
   (their own Meta app) → a scheduled post that fires **with their
   computer off**, in **under an hour**, paying $0.
3. **One contract:** the desktop app has no mode-specific publish logic —
   it points at an endpoint and authenticates. Modes are per-channel and
   can run side by side.
4. **Disclosure:** the active endpoint is always visible; connected mode
   states plainly what routes through Boomin; independent mode states
   that nothing does.
5. **Delivery integrity across mixed endpoints:** a draft fanning out to
   channels on different endpoints survives a client crash mid-submit —
   the client outbox (§2.4) guarantees every endpoint eventually
   receives its instruction exactly once (idempotency keys), and each
   endpoint's queue guarantees no double-publish (checkpoints + job
   leases, §2.3). Retry retries only the failure.
6. The app updates itself from GitHub Releases: update artifacts are
   signed by the release key, signatures distributed through the update
   manifest, and verified by Tauri before installation.
7. **Secrets law (absolute):** the desktop keychain holds only endpoint
   session tokens. Platform secrets and storage-provider credentials
   never exist client-side — no exceptions, including BYO storage
   (§2.2). Nothing sensitive in logs or the webview.

**Non-goals for v0.1:** YouTube/X/TikTok senders, multistreaming, media
generation, analytics, comment management, carousels/Stories, team
features, the network opt-in surface (Phase 2), mobile, home-machine
daemons (the server *is* the daemon). producer-server stays
**single-user by design** — accounts, orgs, teams, billing, RBAC, and
multi-tenancy are permanently out of scope for it; that simplicity is
what makes `wrangler deploy` credible as a product.

---

## 2. Architecture

### 2.1 The pieces

```
┌── producer (this repo, AGPL) ────────────────────────────────┐
│  Tauri 2 desktop app                                         │
│   ├─ UI: composer, queue, history, settings, onboarding      │
│   ├─ vault: OS keychain (endpoint session tokens ONLY)       │
│   ├─ outbox: durable submission intents (§2.4)               │
│   └─ client: typed client for the Producer API contract      │
└──────────────────────────────────────────────────────────────┘
                 │ same API contract │
        ┌────────┴────────┐  ┌───────┴──────────────────────────┐
        │ api.boomin.ai   │  │ producer-server (new repo, AGPL) │
        │ (closed, lean   │  │ Cloudflare Worker + Hono         │
        │  contract       │  │  ├─ auth: single-user bearer     │
        │  endpoints —    │  │  ├─ channels: BYO Meta OAuth     │
        │  decision D1)   │  │  ├─ media: private R2 + gateway  │
        │                 │  │  ├─ queue: state machine + cron  │
        │                 │  │  ├─ senders: TS modules ★        │
        │                 │  │  └─ store: D1 (SQLite)           │
        └─────────────────┘  └──────────────────────────────────┘
```

★ = the community extension point. Senders are TypeScript modules in an
open repo — a far larger contributor pool than Rust trait impls. License
note (stated precisely): AGPL §13 ensures that modified versions of
producer-server offered as a network service must make the corresponding
modified source available to the users of that service.

### 2.2 The API contract

One OpenAPI spec, versioned in the `producer-server` repo, implemented
by both backends: auth/session, channels (list/connect/disconnect),
media (`upload_id` OR `url`), posts (create/update/list), schedule,
publish-now, job status, history. Every mutating route accepts an
**idempotency key** (client-generated, unique per intent target — the
outbox's exactly-once mechanism). **Decision D1 (api repo workstream):**
the hosted side implements this contract as new lean
`/v1/app/producer/*` endpoints rather than exposing the web app's
unit/collection model.

**Sender capabilities, not hardcoded doctrine.** Each channel reports
its constraints through the contract and the composer renders from
them — never from numbers baked into the client:

```jsonc
{ "rateLimit": { "type": "rolling_window", "max": 50,
                 "windowSeconds": 86400 },      // IG's current cap
  "media": { "kinds": ["image","reel"], "maxBytes": ..., "aspect": ... },
  "text": { "maxChars": ... } }
```

(Instagram's API-publish cap is 50 posts per rolling 24h *at time of
writing* — precisely why limits are capability-driven: Meta will change
it again.)

**Media upload (both backends):** the client never touches storage
credentials. It requests an upload slot and PUTs to a temporary
capability URL:

```
POST /v1/media/uploads          (bearer auth)
  → { "upload_id": "...", "put_url": "https://…presigned, short-lived" }
PUT  <put_url>                  (raw bytes; no credentials involved)
```

**Media-by-URL — the free-forever connected tier.** Meta's publish APIs
fetch media from a URL; the backend never needs the bytes. The contract
therefore also accepts a plain public URL as a post's media. A connected
user on BYO storage costs Boomin only metadata (captions, schedules —
kilobytes): they can stay connected, scheduled, laptop-closed, and never
owe Boomin a dollar. Boomin-managed storage is the paid *convenience*
(quota + meter + purge per D2), never a toll on publishing.
Consistent with the secrets law, v0.1 connected BYO storage means the
user supplies an **already-public URL** (their bucket's public object,
their CDN, a Dropbox raw link). Optional v0.1.x: Boomin stores the
user's storage-provider credentials **server-side, encrypted** (same
AES-GCM vault pattern as platform tokens) and mints presigned URLs on
their behalf. What is never on the table: durable infrastructure
credentials in the desktop keychain. Caveat surfaced in the UI: a
URL-sourced scheduled post requires the object to remain reachable until
it fires — early deletion produces a clear, retryable error.

### 2.3 producer-server (the new repo)

- **Stack:** Cloudflare Worker, Hono, **D1** (not Neon — one vendor, one
  account, one `wrangler deploy`; "bring your own Postgres" is a
  documented variant, not the default), private R2, cron triggers,
  worker secrets for platform keys.
- **Tenancy:** single-user. Auth is one bearer token generated at deploy
  time and pasted into the desktop app.
- **Auth model (stated precisely):** bearer auth on every Producer API
  route; OAuth browser/callback routes use short-lived, single-use
  connect sessions and validated single-use `state` — never the bearer
  token. Flow:

```
Desktop ── Bearer ──▶ POST /channels/instagram/connect-session
                        → one-time browser URL (ephemeral nonce)
Browser ──▶ /connect/instagram?session=<nonce> ──▶ Meta consent
Meta    ──▶ /oauth/callback?code&state   (validated, single-use state)
```

- **Media: private bucket, public objects.** R2 is **private**; the
  worker exposes individual objects through an opaque capability
  endpoint — `GET /media/<opaque-capability-id>` — and only objects
  intended for platform ingestion get one. No public-bucket feature, no
  accidentally-public neighbors; per-object lifecycle, revocation, and
  audit logging; capability URLs can later become signed/expiring
  without contract changes. (IG and Threads legitimately require
  remotely fetchable URLs — the *gateway* is the public interface, never
  the bucket.)
- **Queue:** the proven state machine (draft → scheduled → queued →
  publishing → published/failed) with exponential backoff and error
  classes (`Retryable`/`TokenExpired`/`RateLimited(until)`/`Permanent`).
  Two distinct invariants, both enforced:
  - **Idempotency:** platform-side IDs (upload sessions, IG containers)
    persist before the call that consumes them; client idempotency keys
    dedupe re-submits.
  - **Mutual exclusion:** jobs carry a **lease**
    (`lease_owner`, `lease_expires_at`, `next_attempt_at`); a cron tick
    claims a job with a single conditional UPDATE (status eligible, due,
    lease absent-or-expired) and proceeds only if it acquired the row.
    D1 serializes writes per database and `batch()` executes statement
    groups transactionally — sufficient for a single-user queue.
- **Senders v0.1:** Instagram (feed image + reel via container flow),
  Facebook Pages (direct upload; native `scheduled_publish_time` used
  opportunistically), Threads (text + media). Each sender exports its
  capabilities object (§2.2).

### 2.4 The desktop app — thin client plus one durable duty

No local publish engine, no local scheduler, no media bridges. It is:
shell + onboarding chooser + composer/queue/history rendered from the
API + settings + updater + keychain (session tokens only) + **the
outbox**.

**The client outbox (delivery integrity for mixed-endpoint fan-out).**
One draft can target channels on different endpoints; no single server
ever sees the whole logical operation, so the *client* must own
delivering it durably. Before sending anything, the app persists the
fan-out intent locally (SQLite):

```
submission_intents(id, created_at, payload_hash)
submission_targets(intent_id, endpoint_id, channel_id,
                   idempotency_key, status: pending | acknowledged)
```

Submission marks each target acknowledged as its endpoint accepts; a
crash mid-fan-out resumes unacknowledged targets on next launch, reusing
the same idempotency keys so endpoints dedupe. The intent is deleted
when every target is acknowledged. The boundary this draws:
**the desktop owns delivery of the scheduling instruction; endpoints own
execution of the schedule.** The outbox stores instructions, never
tokens or media.

### 2.5 The zero-dollar independent stack (the honest math)

Cloudflare Workers Free: 100k requests/day with cron triggers included;
D1 free tier: **500 MB per database / 5 GB per account**, ~5M rows
read/day, ~100k written/day; R2: 10 GB-month storage with **zero egress
fees**; `workers.dev` HTTPS domain included. A single creator posting
daily consumes a rounding error of each (a year of queue history is
megabytes, not hundreds of them). Their costs: **$0 to Boomin ever (by
design), $0 to Cloudflare at personal scale**, plus their own free Meta
app and technical effort. Outgrow 10 GB of stored media → purge or pay
Cloudflare cents — never Boomin.

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

`SELF_HOSTING.md` in the producer-server repo: create Cloudflare account
→ `wrangler deploy` (D1 + R2 + cron provisioned by config) → generate
the app token → create your Meta app (screenshots + deep links; spike S3
produces this content) → set secrets → paste endpoint into Producer →
connect channels → test post → verify a scheduled post fires with the
laptop closed. Includes the free-tier cost table and upgrade-path note.

### 3.3 Composer

One draft → N channels (mixed endpoints — outbox-backed). Text + one
image or one video/reel. Per-channel accordion (caption override, IG
reel share-to-feed, Threads reply-control, FB Page pick). Live preflight
rendered **from each channel's capabilities object** — caption limits,
media constraints, and rate-limit budget come from the contract, never
from client-side constants. Post now / Schedule / Save draft.

### 3.4 Queue & history

Upcoming + in-flight with per-channel state chips (cancel / retry /
reschedule); history with links to live posts and plain-language errors;
retry retries only failures. All scheduling is server-side on both
endpoints — **"fires with your computer off" is true everywhere.**

### 3.5 Settings

Endpoints (Boomin sign-in; custom endpoint + token, connection health) ·
Channels (per-endpoint, reconnect, scopes) · Publishing defaults ·
**Privacy — "what talks to what"** (per-endpoint disclosure, always one
click away) · Behavior (notifications) · Updates · Advanced (log viewer,
outbox inspector).

### 3.6 Updater & releases

`tauri-plugin-updater`: update artifacts are signed by the release key
(minisign keypair generated at M1; private key in CI secrets + one
offline backup), signatures are distributed through the update manifest
on GitHub Releases, and Tauri verifies them before installation —
verification cannot be disabled. `tauri-action` workflow: tag →
win/mac/linux builds → OS code-sign-if-secrets-present (Apple/Windows
steps no-op until certs are funded) → draft release with changelog.

---

## 4. Security & privacy posture

- Disclosure is a feature: per-endpoint data-flow statements; the active
  endpoint always visible in the shell.
- **Secrets law:** desktop keychain holds session tokens only. Platform
  secrets and storage credentials live server-side exclusively (Boomin's
  encrypted vault or the user's worker secrets). The outbox stores
  instructions, never secrets or media bytes.
- **Auth model:** bearer auth on every Producer API route; OAuth
  browser/callback routes use short-lived single-use connect sessions
  and validated single-use `state` (§2.3).
- **Media:** private R2; objects exposed individually via the opaque
  capability gateway; per-object revocation and audit logging.
- producer-server: tokens encrypted at rest in D1 (AES-GCM, key in
  worker secrets), log scrubbing on token shapes.
- Real CSP in the webview (drop scaffold's `csp: null`); Tauri
  capabilities minimized.
- **No telemetry in v0.1** in the app or producer-server. What Boomin
  observes in connected mode is the API traffic itself, disclosed.
- `SECURITY.md` with disclosure contact in both repos at flip-public.

## 5. Testing strategy

- producer-server: queue state-machine unit tests (every edge, backoff,
  idempotent resume, **lease contention** — two ticks racing one job),
  sender integration tests against a mock Graph server (golden fixtures
  incl. the multi-step IG container flow), cron-tick tests, contract
  tests generated from the OpenAPI spec.
- Desktop: **outbox crash-recovery tests** (kill between endpoint
  acknowledgements; assert resume + dedupe via idempotency keys); client
  contract tests against a local `wrangler dev` instance — the
  self-host stack doubles as the test harness; composer renders
  capability-driven preflight correctly.
- Manual pre-release checklist on all three OSes (WebView2 / WKWebView /
  WebKitGTK) against real dev-mode Meta apps.
- CI: existing 3-OS build matrix + server/client tests + a release
  workflow dry-run on a `v0.0.x-rc` tag.

## 6. Build order

| M | Deliverable | Proves |
| --- | --- | --- |
| **M1** | API contract v0 (OpenAPI, incl. idempotency keys + capabilities + media upload/URL) + desktop skeleton (client, vault, outbox, onboarding chooser) + D1 decision landed in api repo | the spine |
| **M2** | Connected: OTP sign-in, workspace auto-provisioning (user never sees "brand"), channel list, **compose → post now to Instagram** | the 5-minute path — demo-able |
| **M3** | Connected scheduling + job status + history; outbox proven across crash tests | laptop-closed story, mode one |
| **M4** | `producer-server` repo: worker + D1 + private R2 + capability gateway + cron + queue (leases) + **Instagram sender** (BYO app, container flow) | the hard sender, on the open stack |
| **M5** | Facebook + Threads senders; connect-session OAuth flow; SELF_HOSTING.md complete; desktop custom-endpoint mode end-to-end; mixed-endpoint fan-out demo | full trio, independent |
| **M6** | Settings + disclosure pages + updater UX + release workflow e2e | shippable |
| **M7** | Hardening, SECURITY.md + CLA bot (both repos), README + demo GIF + comparison table, sender backlog as labeled issues, launch collateral | flip public |

`producer-server` is built in the open from M4. Remaining spike:
**S3 only** (walk the real Meta BYO app setup as a fresh user; the
screenshots become SELF_HOSTING.md).

## 7. Risk register

| Risk | Level | Mitigation |
| --- | --- | --- |
| Two repos of scope for one launch | **High — the top risk** | producer-server is deliberately lean (single-user, no billing/orgs); the contract keeps surfaces small; M4-M5 timebox; connected mode alone is a shippable fallback launch |
| D1 (lean hosted endpoints) slips | Med | Fallback: connected client temporarily rides existing unit endpoints behind the same desktop client interface |
| Hosted FB/Threads needs Meta app review (Boomin's app) | Med | Independent covers them at launch; hosted parity is a post-launch workstream, stated in the matrix |
| Meta BYO setup friction for self-hosters | Med | S3 makes the guide truthful; per-scope checklist in the connect flow; test post step |
| Outbox adds client-side state | Low-Med | Deliberately tiny (two tables, instructions only); crash-recovery tests in CI; outbox inspector in Advanced settings |
| Cloudflare single-vendor for self-host | Low-Med | Best free tier + zero egress available today; AGPL + Hono + SQLite keep the worker portable by construction; BYO-Postgres variant documented |
| Hosted uptime/cost is now OSS reputation | Med | Free-tier quotas server-side; status page; independent mode is the pressure valve |
| Meta policy/API drift | Med | Capability-driven limits (§2.2); versioned endpoints isolated per sender; pinned Graph versions |
| Unsigned macOS friction | Low | Known + accepted; guided note; signing when funded (first Sponsors goal) |

## 8. Launch definition (exit of Phase 1)

Both repos flip public together when: §1 success criteria pass on all
three OSes (including outbox crash-recovery and mixed-endpoint fan-out);
a release with Tauri-verified signed artifacts has shipped and been
consumed by the updater; SELF_HOSTING.md has been executed
start-to-finish by a fresh account (S3); CLA bot active on both repos;
disclosure pages reviewed against actual data flows; README shows the
5-minute connected demo AND the "your server, your rules, $0"
independent story; Mac unsigned-install note published; sender backlog
(YouTube/X/TikTok) posted as labeled issues in producer-server.
