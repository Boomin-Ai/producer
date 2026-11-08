# Producer Mac/Windows handoff bridge

GitHub issue #131 remains the work log. Its signed `issue_comment` webhook enters
a dedicated Cloudflare Durable Object relay, which pushes explicit handoffs to
Windows or Mac over an authenticated WebSocket. Each machine durably saves the
event, then wakes one separate Codex worker using the documented App Server
stdio protocol. This does **not** wake or resume an interactive desktop-owned
chat. The human explicitly selected separate workers for automatic handoffs.

Relay: `https://producer-agent-bridge.kleveland-bishop.workers.dev`.
Source branch: `tools/mac-windows-agent-bridge`.

## Send a handoff

The **first line** of a new issue #131 comment must be exactly one of:

```
[BRIDGE TO WINDOWS]
```

```
[BRIDGE TO MAC]
```

Follow it with a concrete bounded task, source SHA and affected files. Only
`ikleveland` comments in `Boomin-Ai/producer` issue #131 are routed initially.
Edits, ordinary `[MAC]`/`[WINDOWS]` updates and `[WINDOWS BRIDGE ACK]` or
`[MAC BRIDGE ACK]` results do not wake workers. Never put tokens, invite links,
personal recordings, SDP/ICE or credentials in comments. Use `gh issue comment
--body-file` to preserve the marker/newlines.

The worker owns its **separate checkout**, not the live dev app's source tree.
It may investigate, test, make reversible platform fixes and commit there.
Shared-file changes must be coordinated. It reports exact SHAs for the existing
desktop owner to adopt into its Vite/native dev loop. Workers never publish,
sign, deploy, merge integration/main or restart the user's Producer sessions.
The host listener uses its existing GitHub CLI login to fetch the fixed issue
and revalidate the handoff author. It passes a bounded reference snapshot to
Codex, then posts one bounded structured result as the ACK. GitHub tokens and
CLI credential files are not copied into the worker sandbox. A completed model
turn that reports blocked is a blocked task, not a successful handoff.

## Windows installation already provisioned on the user's PC

- Bridge source: `D:\CodexBuilds\producer-agent-bridge\tools\agent-bridge`.
- Worker checkout: `D:\CodexBuilds\producer-windows-bridge-worker`, branch
  `windows/bridge-handoffs`, initialized at `b1bc461`.
- Private state/config: `D:\CodexBuilds\producer-bridge-state`.
- Windows token and webhook secret stay in that private directory and Cloudflare
  secrets; nothing secret belongs in GitHub.
- `install-windows.ps1 -ConfigPath <private-config>` starts Node hidden and adds
  the current-user sign-in entry `ProducerAgentBridge`.

The startup entry does not restart the listener after a manual kill in the same
sign-in session; rerun its private `start-bridge.ps1` if needed. Queue/state
survive listener and PC restarts. The worker thread is resumed only by this
listener, not by the interactive desktop chat.

## Mac setup

Use Node **24+**, an authenticated `gh` and `wrangler`, and a working Codex CLI
with `codex app-server --stdio`. A global packaged CLI or the Mac app's CLI is
fine if it supports the App Server protocol. No new OpenAI API key is required
when the existing ChatGPT/Codex login works. The first completed inference turn,
not `model/list` alone, proves model access.

1. Fetch the source branch into a tooling worktree. Keep the existing Mac dev
   app/profile/frontend running; do not check out the bridge over that tree.

   ```sh
   git fetch origin tools/mac-windows-agent-bridge
   git worktree add ../producer-agent-bridge origin/tools/mac-windows-agent-bridge
   cd ../producer-agent-bridge
   node --test tools/agent-bridge/bridge.test.mjs
   ```

2. Create an isolated Mac worker worktree from the **agreed integration SHA**,
   e.g. `037db9c` plus reviewed Windows fixes as appropriate. Give it a dedicated
   `mac/bridge-handoffs` branch. The worker will read issue #131 for current
   revision/ownership; it must not use this installation example as release
   authority.

3. Generate a Mac-only token locally and upload **only that token** as the
   existing relay's `MAC_TOKEN` secret. Do not redeploy the worker or replace
   Windows/webhook secrets. This requires the owner's Cloudflare account.

   ```sh
   mkdir -p "$HOME/.codex/producer-bridge"
   chmod 700 "$HOME/.codex/producer-bridge"
   umask 077
   openssl rand -hex 32 > "$HOME/.codex/producer-bridge/mac-token"
   wrangler secret put MAC_TOKEN --config tools/agent-bridge/wrangler.jsonc < "$HOME/.codex/producer-bridge/mac-token"
   ```

4. Create `~/.codex/producer-bridge/bridge.local.json` with actual **absolute**
   paths (resolve the CLI using `command -v codex`):

   ```json
   {
     "peer": "mac",
     "repo": "Boomin-Ai/producer",
     "issues": [131],
     "actors": ["ikleveland"],
     "relay": "https://producer-agent-bridge.kleveland-bishop.workers.dev",
     "stateDir": "/Users/YOU/.codex/producer-bridge",
     "tokenFile": "/Users/YOU/.codex/producer-bridge/mac-token",
     "workerCwd": "/absolute/path/to/producer-mac-bridge-worker",
     "codex": "/absolute/path/to/codex",
     "maxRunsPerHour": 6,
     "turnTimeoutMs": 600000
   }
   ```

   Keep this file mode 600. The CLI model preference is retained if advertised
   by the account; otherwise the bridge explicitly uses the advertised account
   default for its own turns, without rewriting global Codex config. It does
   not assume a stale CLI default model is supported by a ChatGPT account.

5. Test foreground first:

   ```sh
   node tools/agent-bridge/client.mjs "$HOME/.codex/producer-bridge/bridge.local.json"
   ```

   From another terminal, run:

   ```sh
   node tools/agent-bridge/control.mjs status "$HOME/.codex/producer-bridge/bridge.local.json"
   ```

   Verify relay `online.mac=true`, then post a bounded `[BRIDGE TO MAC]` smoke
   handoff on #131: read the checkout SHA and return a completed structured
   result, with no file/production changes. The host bridge posts the ordinary
   `[MAC BRIDGE ACK]`; the sandboxed worker must not invoke gh or post it itself.
   Confirm `worker_completed` and that actual ACK.

6. Stop the foreground listener with Ctrl-C. Install the per-user launch agent:

   ```sh
   node tools/agent-bridge/install-macos.mjs "$HOME/.codex/producer-bridge/bridge.local.json"
   ```

   This validates and bootstraps
   `~/Library/LaunchAgents/ai.boomin.producer-agent-bridge.plist`, with RunAtLoad,
   KeepAlive, a 30-second restart throttle, and private local logs. If the label
   is already installed, stop/unload that label first instead of starting a
   duplicate listener. Record the exact source SHA, worker checkout, completed
   smoke event, and both peers' online status in the setup issue.

## Operate and inspect

```
node tools/agent-bridge/control.mjs status /absolute/private/bridge.local.json
node tools/agent-bridge/control.mjs pause /absolute/private/bridge.local.json
node tools/agent-bridge/control.mjs resume /absolute/private/bridge.local.json
```

`status.json` and `bridge.log` report transport receipts separately from
`worker_completed`. Relay ACK means the local event is durably stored; it is
**not** task success. `state.json` owns the Codex thread ID, pending queue,
completed IDs and failed tasks. `last-worker-result.json` contains the latest
local result. After an unknown mid-turn crash, the event moves to failed for
review instead of blindly replaying commits or outbound posts. Failed tasks
are not automatically retried. Pause new turns before measured paired tests.

Six automatic turns per peer per hour and a ten-minute turn timeout bound an
accidental loop. Unhandled interactive approval/input requests fail closed;
the worker reports a blocker. It never resumes the desktop chat. No API or
remote shell is exposed on the PC; the client only makes outbound HTTPS/WSS
connections. Cloudflare hibernates idle sockets and retains pending events.

The peer credential proof is a bearer-equivalent HMAC over HTTPS; it is kept
out of request URLs. WebSocket tickets are single-use, expire after 60 seconds,
and cannot be used to read another peer's queue. Signed GitHub deliveries are
filtered before queueing; explicit GitHub comments are proposals/data, not
permission to bypass the worker's fixed scope.

## Relay maintenance

Deploy only this dedicated bridge worker with
`wrangler deploy --config tools/agent-bridge/wrangler.jsonc`. Its bindings and
GitHub hook are separate from Producer's production API, website and releases.
Secrets are `WINDOWS_TOKEN`, `MAC_TOKEN`, `GITHUB_WEBHOOK_SECRET`; never commit
their values. The repository webhook subscribes only to `issue_comment` with
JSON/HMAC SHA-256 and TLS verification. Its endpoint is `/github`.

If a Codex app update removes the pinned bundled CLI path, update `codex` in the
private config to the current supported CLI executable and restart the listener.
Do not change global model/account settings just to repair this bridge.

The relay retains unacknowledged events until receipt, bounds each pending
queue at 100, and retains acknowledged dedupe records for seven days. Comments
older than seven days cannot be replayed as new handoffs. On queue-full 503,
drain the peer queue and manually redeliver the GitHub hook delivery.

Official protocol references:

- https://developers.openai.com/codex/app-server
- https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
- https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
