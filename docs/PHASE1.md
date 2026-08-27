# Phase 1 — Producer v0.1: the open-source cross-poster

Status: DRAFT for review. This is the complete plan for the first public
release. Scope is deliberately narrow: **cross-posting to the Meta trio
(Instagram, Facebook Pages, Threads) with bring-your-own-keys**, a real
publish queue, and a launch-quality shell. Multistreaming, other platforms,
media generation, and the Boomin network opt-in are later phases.

---

## 1. Product definition

**User:** a creator or small brand posting the same content to multiple
platforms, currently paying a cross-posting SaaS or doing it by hand.

**Promise:** download a desktop app, spend ~20 guided minutes creating your
own (free) Meta developer app, and post/schedule to Instagram + Facebook +
Threads from one composer — free, forever, no Producer account required.

**Success criteria for v0.1 (all must hold):**
1. A user with zero Meta developer experience gets from install to a
   successful post on all three platforms in under 30 minutes, guided
   entirely in-app.
2. Scheduled posts fire reliably while the app is running (tray included),
   and missed schedules are caught up with a clear notification on next
   launch — never silently dropped, never double-posted.
3. Publishing is per-channel atomic: if Threads succeeds and Instagram
   fails, the UI shows exactly that, and retry retries only the failure.
4. The app updates itself (signed update manifest) from GitHub Releases.
5. Tokens and app secrets never leave the user's machine except to Meta,
   and never appear in logs, the DB, or the webview.

**Non-goals for v0.1 (explicitly out of scope):** YouTube/X/TikTok senders,
multistreaming, media generation, analytics/insights, comment management,
carousels* and Stories*, team features, the Boomin network opt-in, mobile.
(*carousels/Stories land in v0.1.x if trivial after Reels ship.)

---

## 2. Architecture

### 2.1 The one structural rule

**All platform I/O, credentials, and persistence live in the Rust core
("the engine"). The React webview renders and never touches a token.**

Reasons: (a) webview fetch is CORS-bound and XSS-exposed; Rust `reqwest`
is neither. (b) The queue must survive UI navigation and crashes.
(c) The engine becomes a reusable crate — a future headless CLI/daemon
(`producer publish ...`) and the multistream phase build on the same core.

```
┌───────────────────────────── Tauri app ─────────────────────────────┐
│  React UI (composer, queue, wizard, settings)                       │
│      │  typed IPC commands + events (serde JSON)                    │
│  ────┴──────────────────────────────────────────────────────────    │
│  engine (Rust crate)                                                │
│    ├─ connections: OAuth loopback server, token refresh             │
│    ├─ vault: OS keychain (keyring crate) — secrets & tokens         │
│    ├─ store: SQLite (posts, targets, jobs, history)                 │
│    ├─ queue: state machine + scheduler (tokio)                      │
│    ├─ senders: trait PlatformSender — instagram / facebook /        │
│    │           threads (one module each; the extension point)       │
│    └─ media: local file handling + "media handoff" (see 2.4)        │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 The sender trait (the whole future of the project)

Every platform is one implementation of one trait. This is the contract
community contributors build against (YouTube, X, TikTok are "just" new
impls in Phase 2):

```rust
trait PlatformSender {
    fn platform(&self) -> Platform;
    /// Validate a draft against platform rules BEFORE queueing
    /// (caption length, media type/size/aspect, rate-limit budget).
    fn preflight(&self, post: &DraftPost, target: &Target) -> Vec<Issue>;
    /// Execute one publish job step. Long media flows are re-entrant:
    /// each call advances the job and persists a checkpoint.
    async fn publish(&self, job: &mut PublishJob, ctx: &EngineCtx)
        -> Result<StepOutcome, SendError>; // Done | InProgress | RetryAfter
}
```

`SendError` is classified: `Retryable(backoff)`, `TokenExpired`,
`RateLimited(until)`, `Permanent(user_message)`. The queue reacts to the
class, not the platform.

### 2.3 Publish queue state machine

Ported conceptually from the proven hosted engine (`content-publish.ts`),
rewritten in Rust. One `post` fans out to N `publish_jobs` (one per
selected channel):

```
draft ──schedule──▶ scheduled ──due──▶ queued ──▶ publishing ──▶ published
                        │                             │
                        └──cancel──▶ canceled         ├─ retryable ─▶ backoff ─▶ queued
                                                      └─ permanent ─▶ failed
```

- Backoff: exponential with jitter, caps at 3 attempts for permanent-ish
  classes, honors `RateLimited(until)` exactly.
- Re-entrancy: media containers (IG) are multi-step with server-side
  processing waits; each step checkpoints `job.state_json` so a crash or
  quit mid-publish resumes instead of double-posting. **Idempotency rule:
  a creation ID / container ID is persisted before the network call that
  uses it.**
- Scheduler: tokio interval task scans for due jobs. App quits to tray by
  default (configurable); optional launch-at-login. On startup, overdue
  jobs → user notification: "3 posts were due while Producer was closed —
  review & send."

### 2.4 The hard problem: Meta wants public URLs for media

Instagram feed images and Threads media are created from a **publicly
reachable URL** — the API does not accept a direct binary upload for them.
Facebook Pages accepts direct uploads; Instagram Reels supports the
resumable upload protocol. A local-first desktop app must bridge this
honestly:

| Path | Used for | Notes |
| --- | --- | --- |
| Direct upload | Facebook photos/videos | multipart, no bridge needed |
| Resumable upload | Instagram Reels | rupload protocol; **spike S2 verifies** |
| Text-only | Threads text posts | no media, no bridge — ships first |
| **Media handoff** | IG feed images, Threads media | see below |

**Media handoff (v0.1 design):** an optional, disclosed, ephemeral relay.
The app PUTs the file to a signed URL, gets back a public HTTPS URL,
passes it to Meta, and the object auto-deletes on publish confirmation
(TTL fallback 1h). Three interchangeable backends behind one setting:

1. **Boomin handoff (default):** a ~100-line open-source Cloudflare
   Worker + R2 bucket that Boomin operates for free. The worker source
   lives in this repo (`handoff/`) — auditable, and anyone can press
   "Deploy to Cloudflare" and run their own.
2. **Self-hosted handoff:** point the app at your own deployment of that
   same worker (one URL field in Settings).
3. **BYO S3-compatible bucket:** for purists — presigned PUT + public
   URL from the user's own bucket config.

Disclosure rule: the first time a post needs handoff, the app says exactly
what will be uploaded, where, and for how long. No silent relaying. This
is the one place v0.1 touches a Boomin server, and it is optional.

### 2.5 OAuth on desktop

- Loopback flow: engine binds `127.0.0.1:<ephemeral>` before opening the
  system browser to Meta's authorize URL; captures the redirect; PKCE/state
  enforced; port and state single-use.
- The wizard has the user register `http://127.0.0.1:<port>/callback` (and
  `https://` variant where Meta requires it) in their own app's settings.
  **Spike S1 verifies loopback redirect acceptance per product** (Facebook
  Login is known-good in dev mode; Instagram Business Login and Threads
  need confirmation — fallback design if HTTPS-only: local self-signed
  HTTPS listener with an in-wizard trust step, or Meta's manual-copy code
  flow).
- Token lifecycle in the vault: IG long-lived (~60d) with refresh;
  FB user token exchanged for long-lived, then per-Page tokens; Threads
  long-lived (~60d) with refresh. A background task refreshes anything
  expiring within 7 days and surfaces "reconnect needed" states in UI and
  tray badge.

### 2.6 Data model (SQLite)

```
accounts(id, platform, display_name, external_id, scopes, connected_at,
         token_ref /* keychain key, never the token */, status)
posts(id, created_at, body_text, media_json /* local paths + kinds */,
      status, scheduled_at, created_from)
targets(id, post_id→posts, account_id→accounts, per_platform_overrides_json)
publish_jobs(id, target_id→targets, state, attempt, next_attempt_at,
             state_json /* checkpoints: container ids, upload session */,
             error_class, error_message, published_external_id, timestamps)
app_settings(key, value)
```

Keychain holds: per-account OAuth tokens, per-platform app secrets
(`vault:{platform}:{app_id}`), updater has its own OS-level story. DB holds
references only.

---

## 3. Feature spec

### 3.1 Connection wizard (the make-or-break UX)

Per platform, a full-screen guided flow with screenshots and deep links
into developers.facebook.com:

1. "Create your (free) Meta app" — link + exact click path + why (own
   your pipeline; Boomin never sees your accounts).
2. Enable the right product (Instagram / Facebook Login / Threads),
   add yourself as tester where dev-mode requires it.
3. Paste App ID + App Secret → stored in keychain → "Connect" runs OAuth.
4. Live verification: fetch profile, show avatar + handle, run a
   permissions checklist (each scope: granted/missing with fix link).
5. Optional test post to confirm end-to-end.

Requirements register (shown before starting): Instagram must be a
Business/Creator account; Facebook posting targets a Page; rate limits
stated up front (IG: 100 API posts/24h).

### 3.2 Composer

- One draft → N channels. Text body + media (image or single video/reel
  in v0.1) via file picker or drag-drop.
- Per-channel accordion (pattern proven in the hosted app): caption
  override, IG share-to-feed toggle for reels, Threads reply-control,
  FB Page selection.
- Live preflight per channel (sender `preflight()`): caption length,
  media constraints, aspect warnings, "will need media handoff" notice.
- Actions: Post now / Schedule (local timezone, explicit) / Save draft.

### 3.3 Queue & history views

- Queue: upcoming scheduled + in-flight jobs with per-channel state chips,
  cancel/retry/edit-reschedule.
- History: reverse-chron published/failed with external post links,
  error explanations in plain language, one-click retry for failures.

### 3.4 Settings console (OBS-style, v0.1 scope)

Sections: Connections (accounts, scopes, reconnect) · Publishing defaults ·
Media handoff (Boomin / self-hosted URL / BYO bucket) · Behavior (tray,
launch-at-login, notifications) · Updates (channel, check now) ·
Advanced (log viewer, log level, data folder). Console layout is a plain
sectioned page in v0.1 — the dockable panel system arrives with
multistream.

### 3.5 Updater & releases

- `tauri-plugin-updater`, update manifest + artifacts on GitHub Releases,
  minisign keypair generated at M1 (private key: CI secret + one offline
  backup; documented recovery stance).
- Release workflow (`tauri-action`): tag → build win/mac/linux →
  sign-if-secrets-present (Apple + Windows steps are no-ops until secrets
  exist) → draft release with changelog.
- In-app: background check on launch + daily; non-nag banner + Settings
  page; "Restart to update".

---

## 4. Security & privacy posture

- Tokens/secrets: OS keychain only; never in SQLite, logs, or the webview;
  log scrubber redacts anything matching token shapes as defense-in-depth.
- Webview: real CSP (drop the scaffold's `csp: null`), Tauri capabilities
  minimized to the IPC surface actually used, no remote content in the
  shell.
- Telemetry: **none in v0.1.** Not even opt-in. Crash reporting revisited
  post-launch as opt-in. (This is a launch talking point against SaaS
  competitors.)
- Updates signed (minisign) independent of OS code signing.
- Media handoff: disclosed, optional, TTL-bounded, source in-repo.
- `SECURITY.md` with a disclosure contact ships at flip-public.

## 5. Testing strategy

- Engine unit tests: state machine transitions (every edge), backoff
  math, error classification, checkpoint/resume (kill mid-publish tests).
- Sender integration tests against a local mock Graph server (wiremock):
  golden request/response fixtures per endpoint, including the multi-step
  IG container flow and failure/ratelimit paths.
- Manual pre-release checklist against real dev-mode apps + test accounts
  on all three OSes (webview differences: WebView2/WKWebView/WebKitGTK).
- CI (already live) extended: engine tests + clippy; release workflow
  dry-run on a `v0.0.x-rc` tag before the real launch tag.

## 6. Build order (dependency-ordered milestones)

| M | Deliverable | Proves |
| --- | --- | --- |
| **S** | Spikes S1–S3 (below) — timeboxed, before anything else | the risky assumptions |
| **M1** | Engine skeleton: SQLite + migrations, keychain vault, IPC contract, log scrubber, updater keypair | foundations |
| **M2** | OAuth loopback + connection wizard for **Threads** + token refresh | the auth spine, simplest platform |
| **M3** | Composer + drafts + preflight; queue state machine with a `MockSender` | core loop testable without Meta |
| **M4a** | **Threads text posting** live end-to-end (no media bridge needed) | first real post — demo-able |
| **M4b** | **Facebook Pages** sender (direct uploads) | second platform, media without handoff |
| **M4c** | Media handoff worker + **Instagram** sender (feed image + reel) | the hard one, last |
| **M5** | Scheduler, retries, catch-up-on-launch, history view, tray | reliability story |
| **M6** | Settings console + updater UX + release workflow end-to-end | shippable |
| **M7** | Hardening pass, SECURITY.md, CLA bot, README/demo GIF/comparison table, issue templates, launch collateral | flip public |

Sequencing rationale: Threads-first gets a real cross-platform post
working before the media-handoff complexity; Instagram lands last because
it depends on the handoff. A demo exists from M4a onward — build-in-public
content starts there, before launch.

## 7. Spikes (timeboxed verification of assumptions — do first)

- **S1 — OAuth loopback acceptance:** confirm `http://127.0.0.1` redirect
  URIs are accepted by Facebook Login, Instagram Business Login, and
  Threads in dev mode. Output: working authorize→callback for each, or
  the documented fallback per platform.
- **S2 — Instagram Reels resumable upload:** confirm a local video can be
  published to Reels via resumable upload with no public URL. Output:
  scripted end-to-end proof or "handoff required for reels too".
- **S3 — Threads app setup friction:** walk the full dev-mode setup for
  Threads API as a fresh user; measure minutes and screenshot every step
  (this becomes the wizard content). Output: the real wizard script + any
  blocker (e.g., unexpected review requirements) surfaced now, not at M4a.

## 8. Risk register

| Risk | Level | Mitigation |
| --- | --- | --- |
| Media public-URL constraint breaks "no servers" purity | High | §2.4: three interchangeable backends, open-source worker, full disclosure; Threads-text + FB work without it |
| Meta dev-mode setup friction kills conversion | High | Wizard is a first-class feature (S3 makes it truthful); in-app permission checklist; test post |
| OAuth redirect rules differ per Meta product | Med | Spike S1 before M2; fallbacks designed |
| Scheduled posts while app closed | Med | Tray default + launch-at-login + catch-up flow; roadmap note: headless daemon later |
| Meta policy/API drift | Med | Senders isolate versioned endpoints; preflight enum errors; pin Graph version per sender |
| Solo maintainer + review-agent loop | Med | Small PRs per milestone; CI gates; this doc as the contract |
| Scope creep (carousels, stories, analytics…) | Med | §1 non-goals; anything not listed is v0.1.x+ |
| Unsigned macOS friction at launch | Low | Known + accepted; guided install note; signing lands when funded |

## 9. Launch definition (exit of Phase 1)

Repo flips public when: all §1 success criteria pass on all three OSes;
release workflow has shipped a signed-manifest release consumed by the
updater; CLA bot active; README shows a real 30-second demo GIF; the
"Mac unsigned install" note exists; senders backlog (YouTube/X/TikTok)
posted as labeled issues for contributors.
