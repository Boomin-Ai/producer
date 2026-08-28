# Producer

> **Stop posting. Start producing.**

Producer is the open-source studio for creators and brands: **post everywhere,
stream everywhere** — from one desktop app, with your own keys, on your own
channels. Free and open source (AGPL-3.0). Built by [Boomin](https://boomin.ai).

## Why

Every cross-posting tool charges you monthly for what the platforms give you
for free. Every multistreaming service charges you for bandwidth your own
machine can push. Producer collapses both into one app you own:

- **Cross-post** to Instagram, Facebook, and Threads with your own Meta app —
  no review process, no middleman, no subscription. YouTube, X, and TikTok
  next.
- **Multistream** (coming after cross-posting): one encode, many RTMP
  destinations, straight from your desktop.
- **Optional Boomin network**: one click connects you to a collaborative
  brand network — programs, partners, budgets. Skip it entirely and Producer
  still works, forever, for free.

## One repo, both halves

```
/            the desktop app — Tauri 2 + Rust + React (this page)
/server      producer-server — the self-hosted backend: a Cloudflare
             Worker (D1 + R2 + cron) you deploy with one command, so
             posting and scheduling run on YOUR account for $0.
             → server/SELF_HOSTING.md is the ~20-minute walkthrough
/server/contract   the Producer API contract (OpenAPI) — the spine the
             desktop, the hosted backend, and your server all share
```

The app speaks one contract to either backend: **Connected** (Boomin's
hosted platform, posting in ~2 minutes) or **Independent** (your own
producer-server — nothing ever touches Boomin). Both can run side by
side, and one post can fan out across them.

## Status

**Pre-launch, building in public.** v0.1 ships cross-posting for the Meta
trio (Instagram, Facebook, Threads) with bring-your-own-keys. Watch the
[issues](https://github.com/Boomin-Ai/producer/issues) for the live roadmap.

| Milestone | Status |
| --- | --- |
| Tauri 2 + React shell | done |
| Meta BYO-app setup wizard (OAuth, keychain storage) | in progress |
| Publish queue: drafts → scheduled → published, retries | in progress |
| Instagram / Facebook / Threads senders | in progress |
| YouTube sender (with API-audit walkthrough) | planned |
| X sender | planned |
| TikTok sender | planned |
| Multistream: local multi-RTMP fan-out | planned |
| Media generation (BYO fal / ElevenLabs keys) | planned |

## Quickstart (development)

Requires [Bun](https://bun.sh) ≥ 1.3 and [Rust](https://rustup.rs) (stable).
On Windows: Visual Studio Build Tools (MSVC) + WebView2. On macOS: Xcode
Command Line Tools.

```sh
bun install
bun run tauri dev
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full setup.

## How it stays free

The desktop app is AGPL-3.0 and runs on your keys — free forever, and it
*stays* free: the license guarantees nobody can take this code closed, and
anyone running a modified version as a service must share their changes
with their users. Boomin makes money on the hosted platform (managed keys,
credits for media generation, the paid multistream relay, and the brand
network) and on commercial licenses for companies that want Producer inside
proprietary products. Want this functionality embedded in your own product
without AGPL obligations? That's what the MIT-licensed Boomin SDK is for.
Think ComfyUI and Comfy Cloud: same team, open core, honest split.

## Support the project

Producer is free and always will be. If it saves you a subscription, consider
[sponsoring development](https://github.com/sponsors/ikleveland) — every bit
funds more platform senders and faster releases. The other great ways to help:
star the repo, ship a PR, or use [Boomin hosted](https://boomin.ai) when you
want the managed experience.

## License

AGPL-3.0-only © 2026 Boomin. The Boomin SDK packages (`@boomin/sdk`,
`@boomin/connect`) are separately MIT-licensed.
