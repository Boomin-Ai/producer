# Phase 1 — Producer v0.1: the two-mode cross-poster

Status: DRAFT v2 for review. Supersedes the single-mode (BYO-only) draft.

v0.1 ships a desktop cross-poster with **two honestly-labeled modes**:

- **Connected mode (default):** sign in with a free Boomin account and
  publish through Boomin's hosted, already-approved platform integrations.
  Setup in ~2 minutes. Content routes through Boomin's servers.
- **Independent mode (the option):** bring your own platform keys; nothing
  ever touches a Boomin server. Slower setup, total self-sufficiency —
  the app keeps working even if Boomin disappears.

Precedent: Signal, Bitwarden, Ghost — open-source clients, hosted default,
real self-host escape hatch. The escape hatch being *real* is what keeps
the default honest.

**Launch platform matrix (the honest version):**

| Platform | Connected (hosted) | Independent (BYO) |
| --- | --- | --- |
| Instagram | **v0.1** (hosted integration is live today) | v0.1.x (needs media-handoff track, see §6) |
| Threads | later (needs Boomin app review) | **v0.1** (text posts; no media bridge needed) |
| Facebook Pages | later (needs Boomin app review) | **v0.1** (direct uploads; no bridge needed) |

Every platform is reachable at launch through at least one mode, and each
mode launches with something real.

---

## 1. Product definition

**User:** a creator or small brand posting the same content everywhere,
currently paying a cross-posting SaaS or doing it by hand.

**Success criteria for v0.1 (all must hold):**

1. **Connected:** a fresh user goes from install → signed in → first
   Instagram post in **under 5 minutes** (email OTP, connect IG, post).
2. **Independent:** a user with zero Meta developer experience gets
   Threads + Facebook posting working fully locally in **under 30 guided
   minutes**, and the app states plainly that no Boomin server is involved.
3. **Disclosure:** every connected channel is visibly badged with its mode;
   a first-run screen and Settings page state exactly what talks to what,
   in plain language. No silent server dependency, ever.
4. Publishing is per-channel atomic with no double-posts: independent
   jobs checkpoint before side-effectful calls; connected jobs are
   idempotent via hosted job IDs.
5. Scheduled posts behave as documented per mode (§4.3): connected fires
   server-side even with the laptop closed; independent fires locally with
   tray + catch-up-on-launch, and the difference is stated in the UI.
6. The app updates itself from GitHub Releases (signed update manifest).
7. Secrets hygiene: Boomin session token, BYO app secrets, and OAuth
   tokens live in the OS keychain; never in SQLite, logs, or the webview.

**Non-goals for v0.1:** YouTube/X/TikTok senders, multistreaming, media
generation, analytics, comment management, carousels/Stories, team
features, the Boomin network opt-in surface (Phase 2 — but see §8 note),
mobile. Independent-Instagram is v0.1.x, not v0.1 (§6).

---

## 2. Architecture

### 2.1 The structural rule (unchanged)

**All platform I/O, credentials, and persistence live in the Rust core
("the engine"). The React webview renders and never touches a token.**

```
┌───────────────────────────── Tauri app ─────────────────────────────┐
│  React UI (composer, queue, wizard, settings)                       │
│      │  typed IPC commands + events                                 │
│  ────┴──────────────────────────────────────────────────────────    │
│  engine (Rust crate)                                                │
│    ├─ vault: OS keychain (Boomin token, BYO secrets, OAuth tokens)  │
│    ├─ store: SQLite (posts, channels, jobs, history, settings)      │
│    ├─ queue: local state machine + scheduler (independent mode)     │
│    ├─ connected: thin client for api.boomin.ai (auth, channels,     │
│    │             media upload, publish, schedule, status polling)   │
│    └─ senders: trait PlatformSender (independent mode) —            │
│                threads / facebook in v0.1; the extension point      │
└─────────────────────────────────────────────────────────────────────┘
```

Both modes flow through the same engine so the UI is mode-agnostic: a
"channel" is either `Connected(boomin_channel_id)` or
`Independent(account_id)`, and the composer/queue/history don't care.

### 2.2 Connected mode client

- **Auth:** Boomin email OTP (existing `/auth/otp` + `/auth/verify`),
  session token in keychain. No password ever exists.
- **Channels:** list the workspace's connected social integrations
  (Instagram today) via existing integration endpoints.
- **Media:** upload via the existing files API (presigned direct-to-R2
  for large files). This is what dissolves Instagram's public-URL
  requirement in the default mode.
- **Publish & schedule:** executed server-side by the hosted publish
  engine (the production-proven job state machine). The app submits,
  then polls/receives status into local history.
- **Where media lives:** source files stay on the user's disk (SQLite
  stores paths, never blobs). Connected publishing uploads a copy to
  Boomin storage (R2) for the hosted engine to hand to the platform.
  **Open decision D2 — retention of that copy:** default to persisting
  it as the user's cloud media library (matches the hosted product's
  Drive; enables reuse + history previews) with a per-workspace
  "auto-delete after publishing" setting and delete-anytime controls,
  all stated on the disclosure page — vs. ephemeral-by-default.
  Free-tier storage quota bounds cost either way. Independent-mode
  media never touches Boomin: FB uploads go disk→Meta directly; the
  future independent-IG bridge (§6) is ephemeral by design (delete on
  publish confirmation, 1h TTL fallback).
- **Open decision D1 (needs an owner in the api repo):** desktop submits
  through the existing unit/collection endpoints vs. a new lean
  `POST /v1/app/posts` surface purpose-built for the desktop composer.
  The lean endpoint is preferred (decouples desktop from the web app's
  content model); it is a small, additive api-repo workstream and the
  only server-side work Phase 1 requires.

### 2.3 Independent mode engine

- **Sender trait** — the community extension point; YouTube/X/TikTok in
  Phase 2 are new impls of this contract:

```rust
trait PlatformSender {
    fn platform(&self) -> Platform;
    /// Validate a draft BEFORE queueing (caption length, media
    /// type/size, rate-limit budget). Issues render in the composer.
    fn preflight(&self, post: &DraftPost, target: &Target) -> Vec<Issue>;
    /// Advance one publish job step; re-entrant with persisted
    /// checkpoints so a crash resumes instead of double-posting.
    async fn publish(&self, job: &mut PublishJob, ctx: &EngineCtx)
        -> Result<StepOutcome, SendError>; // Done | InProgress | RetryAfter
}
```

  `SendError` classes — `Retryable(backoff)`, `TokenExpired`,
  `RateLimited(until)`, `Permanent(msg)` — drive the queue generically.

- **Local queue state machine** (independent jobs only):

```
draft ─▶ scheduled ─▶ queued ─▶ publishing ─▶ published
             │                     ├─ retryable ─▶ backoff ─▶ queued
             └─▶ canceled          └─ permanent ─▶ failed
```

  Exponential backoff with jitter; honors `RateLimited(until)`;
  **idempotency rule:** any platform-side ID (upload session, container)
  is persisted before the call that consumes it.

- **OAuth loopback:** engine binds `127.0.0.1:<ephemeral>`, opens the
  system browser, captures the redirect; PKCE + single-use state.
- **Token lifecycle:** FB long-lived user token → per-Page tokens;
  Threads long-lived (~60d) with refresh; background refresh for
  anything expiring within 7 days; "reconnect needed" surfaced in UI.

### 2.4 Data model (SQLite)

```
channels(id, mode /* connected|independent */, platform, display_name,
         external_id, boomin_channel_id?, token_ref?, scopes, status)
posts(id, created_at, body_text, media_json, status, scheduled_at)
targets(id, post_id, channel_id, per_platform_overrides_json)
publish_jobs(id, target_id, executor /* local|hosted */, state, attempt,
             next_attempt_at, state_json, hosted_job_id?,
             error_class, error_message, published_external_id, timestamps)
app_settings(key, value)
```

Keychain: `vault:boomin:session`, `vault:{platform}:{app_id}:secret`,
`vault:account:{id}:tokens`. DB stores references only.

---

## 3. Feature spec

### 3.1 Onboarding chooser (first run)

Two doors, honestly described, both first-class:

> **Connect with Boomin** — free account, publishing in ~2 minutes.
> Your posts route through Boomin's servers to reach the platforms.
>
> **Independent setup** — your own platform keys, ~20-30 minutes,
> nothing touches Boomin. Works forever, even if we don't.

Modes are per-channel, not global — a user can run connected Instagram
and independent Threads side by side. The chooser is re-enterable from
Settings; nothing is locked in.

### 3.2 Composer

- One draft → N channels (mixed modes). Text + one image or one
  video/reel via picker or drag-drop.
- Per-channel accordion (pattern proven in the hosted web app): caption
  override, IG reel share-to-feed, Threads reply-control, FB Page pick.
- Live preflight per channel; channel chips show platform + mode badge.
- Actions: Post now / Schedule / Save draft.

### 3.3 Queue & history

- Upcoming + in-flight with per-channel state chips; cancel / retry /
  reschedule. Hosted job statuses poll into the same view.
- History: reverse-chron with links to the live posts, plain-language
  error explanations, one-click retry of failures only.
- Scheduling difference stated inline: connected = "fires even if your
  computer is off"; independent = "Producer must be running (tray counts)"
  with launch-at-login offered and overdue catch-up on next open.

### 3.4 Independent connection wizard (Threads, Facebook)

Guided per-platform flow with screenshots + deep links into
developers.facebook.com: create the (free) Meta app → enable the product
→ add yourself as tester → paste App ID/Secret (→ keychain) → OAuth →
live verification (profile fetch + per-scope checklist) → optional test
post. Requirements stated up front (FB posting targets a Page; IG
independent not yet available — roadmap link; rate limits listed).

### 3.5 Settings console

Connections (channels, modes, scopes, reconnect) · Publishing defaults ·
Behavior (tray, launch-at-login, notifications) · **Privacy — "what talks
to what"** (the disclosure page, always one click away) · Updates ·
Advanced (log viewer, data folder). Plain sectioned page in v0.1; the
dockable panel system arrives with multistream.

### 3.6 Updater & releases

`tauri-plugin-updater` + minisign-signed manifest on GitHub Releases
(private key: CI secret + one offline backup). `tauri-action` release
workflow: tag → build win/mac/linux → sign-if-secrets-present (Apple /
Windows steps no-op until certs exist) → draft release with changelog.
In-app: background check, non-nag banner, "Restart to update".

---

## 4. Security & privacy posture

- **Disclosure is a feature:** first-run screen + permanent Settings page
  stating per-mode data flow. Connected mode sends: media files, captions,
  schedule times, and platform account linkage to Boomin (governed by the
  hosted ToS/privacy policy — linked). Independent mode sends nothing to
  Boomin; the app makes no Boomin network calls for independent-only
  users beyond the update check to GitHub.
- Tokens/secrets in OS keychain only; log scrubber redacts token shapes.
- Real CSP (drop scaffold's `csp: null`); Tauri capabilities minimized.
- **No telemetry in v0.1** — not even opt-in. What Boomin observes in
  connected mode is the API traffic itself, disclosed above. Crash
  reporting revisited post-launch as opt-in.
- `SECURITY.md` with disclosure contact ships at flip-public.

## 5. Testing strategy

- Engine unit tests: state machine edges, backoff math, error classes,
  checkpoint/resume (kill mid-publish), mixed-mode fan-out.
- Sender integration tests against a mock Graph server (wiremock) with
  golden fixtures; connected-client tests against a mock Boomin API.
- Manual pre-release checklist on all three OSes against real accounts
  (WebView2 / WKWebView / WebKitGTK differences).
- CI extended with engine tests + clippy; release workflow dry-run on a
  `v0.0.x-rc` tag before launch.

## 6. Independent-Instagram track (v0.1.x, not launch-blocking)

Instagram feed images require a publicly reachable URL — a structural
constraint, not a spike outcome. Independent IG therefore needs a media
bridge and ships after launch, gated on spikes:

- **S1** — loopback OAuth acceptance for IG Business Login / Threads
  (FB known-good). Fallbacks: local self-signed HTTPS or manual-code flow.
- **S2** — IG Reels resumable upload without a public URL (if yes,
  independent reels skip the bridge).
- **S3** — Threads dev-mode setup walkthrough (feeds the wizard content;
  runs before M4).

Bridge design (when it ships): one setting, three interchangeable
backends — (a) Boomin ephemeral handoff (open-source ~100-line Worker in
this repo, auto-delete on publish, TTL 1h), (b) self-hosted deployment of
that same Worker, (c) BYO S3-compatible bucket. Full disclosure at first
use. Purists get (b)/(c); nobody is silently routed.

## 7. Build order

| M | Deliverable | Proves |
| --- | --- | --- |
| **M1** | Engine skeleton: SQLite + migrations, keychain vault, IPC contract, log scrubber, updater keypair. Parallel: **D1 decision + lean publish endpoint** in api repo | foundations |
| **M2** | Boomin OTP sign-in + connected channel list + **connected Instagram: compose → post now**, end-to-end | the 5-minute default path — demo-able |
| **M3** | Connected scheduling + status polling + history view | the "laptop closed" story |
| **M4** | Sender trait + local queue + **independent Threads** (wizard → OAuth → text post, fully local) | the escape hatch is real |
| **M5** | **Independent Facebook Pages** (direct media uploads) + tray/catch-up scheduler | second sender proves the trait |
| **M6** | Settings console + disclosure pages + updater UX + release workflow e2e | shippable |
| **M7** | Hardening, SECURITY.md, CLA bot, README + demo GIF + comparison table, issue templates, launch collateral | flip public |

Spikes S1–S3 run in parallel from M1; they gate only the v0.1.x
independent-IG track, never the launch. A real demo exists at M2 —
build-in-public content starts there.

## 8. Risk register

| Risk | Level | Mitigation |
| --- | --- | --- |
| Hosted uptime/cost becomes part of the OSS product's reputation | High | It already is Boomin's product surface; free-tier publish quotas; status page; independent mode is the pressure valve |
| OSS-purist pushback on hosted-default | Med | Independent mode ships *working* at launch (Threads+FB), disclosure UX is loud, independent-IG roadmap public |
| D1 slips (api-repo dependency) | Med | Fallback: reuse existing unit endpoints behind the connected client; lean endpoint refactor later |
| Meta dev-mode friction in independent wizard | Med | S3 makes the wizard truthful; scope checklist; test post |
| Scheduling expectations (independent, app closed) | Med | Difference stated in-UI per §3.3; connected mode is the answer for "always fires" |
| Free connected tier abused / rate limits | Low-Med | Per-account platform limits already bind (IG 100/24h); hosted quotas configurable server-side |
| Meta policy/API drift | Med | Versioned endpoints isolated per sender; connected mode insulated by hosted layer |
| Scope creep | Med | §1 non-goals; anything unlisted is v0.1.x+ |
| Unsigned macOS friction | Low | Known + accepted; guided install note; signing when funded |

Note on the network moat: connected mode means every default user holds a
Boomin account at launch. The Phase-2 network opt-in becomes a checkbox on
an existing account rather than a new signup — by design.

## 9. Launch definition (exit of Phase 1)

Repo flips public when: §1 success criteria pass on all three OSes;
a signed-manifest release has shipped and been consumed by the updater;
CLA bot active; disclosure pages reviewed against actual data flows;
README shows a 30-second demo GIF of the 5-minute connected path AND
names independent mode honestly; Mac unsigned-install note published;
sender backlog (YouTube/X/TikTok + independent-IG) posted as labeled
issues for contributors.
