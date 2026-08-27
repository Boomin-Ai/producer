# Producer

> **Stop posting. Start producing.**

Producer is the open-source studio for creators and brands: **post everywhere,
stream everywhere** — from one desktop app, with your own keys, on your own
channels. MIT-licensed. Built by [Boomin](https://boomin.ai).

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

The desktop app is MIT and runs on your keys — that part is free forever.
Boomin makes money on the hosted platform (managed keys, credits for media
generation, the paid multistream relay, and the brand network). Think
ComfyUI and Comfy Cloud: same team, open core, honest split.

## License

MIT © 2026 Boomin
