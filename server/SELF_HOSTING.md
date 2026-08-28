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
- This repo: `git clone https://github.com/Boomin-Ai/producer-server && cd producer-server && npm install`

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

## 7. Verify the laptop-closed promise

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
- **Boomin:** nothing. No calls, no telemetry, no account. If Boomin
  disappears tomorrow, this keeps working.

## Limits of the free tier (you will not hit these posting daily)

Workers: 100k requests/day, cron included · D1: 500 MB/database,
5 GB/account · R2: 10 GB-month stored, zero egress fees. A year of
queue history is megabytes.

## Updating

```sh
git pull && npm install && npx wrangler deploy && npm run db:migrate
```

The schema is idempotent; migrations never destroy data.
