<p align="center">
  <img src="site/chair.png" width="170" alt="Producer — the chair is yours" />
</p>

# Producer

> **Distribution for everyone.**

Producer is the open-source studio for creators and brands. One desktop app
that goes live, records, brings on guests, and posts — to your own channels,
with your own keys. Free and open source (AGPL-3.0). Runs on Boomin's hosted
platform or on a server you deploy yourself for $0.

Download at [producer.dev](https://producer.dev) · macOS (signed and
notarized), Windows, Linux · updates itself.

## What it does today

**Live**
- Scenes, sources, filters, transitions. Camera, screen, windows, text,
  browser sources.
- Go live to **Twitch, Kick, and YouTube at the same time** from one encode
  on your machine. No relay, no per-destination fee.
- Record locally. Output a **virtual camera** to any app that takes one.
- Read Twitch and Kick chat inside the studio.

**Guests**
- Share a link. Guests join from any browser, camera and mic go straight to
  your computer. Admit from the roster, drag onto a stage slot.
- Guests who have Producer join from Producer — their scene is their camera.
- Works on Boomin or on your own server. Signaling only ever passes through
  the server; media is peer to peer.

**Posting**
- Cross-post to Instagram, Facebook, and Threads with your own Meta app.
- Schedule posts server-side; they fire with your laptop closed.

## Where it runs

Producer speaks one contract to either backend, and you can use both at once.

| | Boomin hosted | Your own server |
| --- | --- | --- |
| Setup | sign in with email | ~20 minutes, one `wrangler deploy` |
| Cost | free tier, paid extras | $0 on Cloudflare's free tier |
| Who can see your data | Boomin | nobody |
| Live, guests, recording, posting, scheduling | yes | yes |
| Verified brands, booked and paid appearances | yes | no |

The `server/` directory is the whole self-hosted backend: a Cloudflare Worker
with D1, R2, a cron, and one Durable Object for guest signaling.
[server/SELF_HOSTING.md](server/SELF_HOSTING.md) is the walkthrough.

## Producer to Producer

Two people with Producer, each on their own server, can do a show together
with nothing in the middle:

1. You open a room. Your server knows it's open.
2. You send your friend the room link.
3. Their Producer opens it. Their video goes directly to your machine.
4. You admit them and put them on stage.

Their server is never involved. Yours only brokered the handshake.

## Where the line is

Everything about making a show is open: the app, the engine, guests, the
self-hosted server. That never gets worse to push you anywhere.

The **Boomin Network** is a different product: verified brand identity,
booked appearances with money held in escrow, and a stage clock that pays
out when the guest has actually been on stage. Those need a party both
sides trust, so they run on Boomin and the host's room lives there. A
self-hoster can join the Network as a guest and keep every show at home.

## Built to connect more

Every channel is an adapter. Live destinations are RTMP targets with a
platform-specific handshake; posting channels are senders in
`server/src/senders/`. Adding one is a contained change, which is how the
core is meant to grow to hundreds of channels without touching the studio.
Wanted next, all good first issues: X, TikTok, YouTube posting, custom RTMP
destinations.

## Honest status

- Guest media is STUN-only. A minority of guests behind strict NAT won't
  connect until you configure a TURN server (`ICE_SERVERS`). Documented.
- On Windows, guests need Producer allowed through the firewall. The installer
  adds the rule; if it's missing, Producer shows a fix button.
- Producer-hosted guests run inside a Producer window today. A native guest
  pipeline, no webview, is the next step.
- Instagram and Facebook senders on a self-hosted server have had fewer real
  runs than Threads. Report what breaks.

## Self-host quickstart

```sh
git clone https://github.com/Boomin-Ai/producer && cd producer/server && npm install
npx wrangler login
npx wrangler d1 create producer && npx wrangler r2 bucket create producer-media
# paste the database_id into wrangler.toml, set PRIMARY_TOKEN and SIGNALING_SECRET
npx wrangler deploy
```

Then in Producer: **Use my own server**, paste the URL and your primary token.

## Develop

Requires [Bun](https://bun.sh) ≥ 1.3 and [Rust](https://rustup.rs) (stable).
On Windows: Visual Studio Build Tools (MSVC) + WebView2. On macOS: Xcode
Command Line Tools. Full setup in [CONTRIBUTING.md](./CONTRIBUTING.md).

```sh
bun install
bun run tauri dev
```

## How it stays free

The app is AGPL-3.0 and runs on your keys. The license guarantees nobody can
take this code closed, and anyone running a modified version as a service
must share their changes. Boomin makes money on the hosted platform and the
Network, and on commercial licenses for companies that want Producer inside
proprietary products. The Boomin SDK packages are separately MIT-licensed
for that.

## Support the project

Star it, ship a channel, or [sponsor development](https://github.com/sponsors/ikleveland).
Using [Boomin hosted](https://boomin.ai) when you want the managed experience
funds the open one.

## License

AGPL-3.0-only © 2026 Boomin. `@boomin/sdk` and `@boomin/connect` are MIT.
