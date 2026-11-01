# Producer Set authoring MCP

Local stdio MCP for Claude Code, Codex and other MCP clients. The agent supplies a compact design plan or a revision-fenced edit. Producer's existing compiler and canonical validator produce a new `.set.json`. No second model call, provider credential, running workspace server or native app is required.

## Setup

Requires Node 22+ and this Producer checkout's dependencies:

```sh
npm ci
npm ci --prefix tools/producer-mcp
```

Open Claude Code at the repository root. The committed `.mcp.json` registers `producer-sets`, and `.claude/skills/producer-sets/SKILL.md` supplies the skill. Claude's normal project MCP trust handling applies. See [Claude MCP setup](https://code.claude.com/docs/en/mcp) and [skills locations](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview).

For Codex, use an absolute checkout path:

```sh
codex mcp add producer-sets -- node /absolute/producer/tools/producer-mcp/server.mjs
```

Copy the skill folder into `~/.codex/skills/producer-sets` for personal discovery. MCP configuration follows the [official Codex MCP instructions](https://learn.chatgpt.com/docs/extend/mcp). Reconnect the client after adding a server if the new tools are not listed.

The default artifact directory is `~/Documents/Producer Sets`. Set `PRODUCER_SETS_DIR` in the MCP process environment to choose another directory. Only regular `.set.json` files directly inside that directory are readable. Paths outside it and symbolic links are rejected. Outputs have unique names and never overwrite source Sets. No credentials belong in MCP config or Set documents.

## Tools

| Tool | Result |
| --- | --- |
| `producer_capabilities` | Current compiler catalog, compact contract and scope |
| `producer_list_sets` | Up to 200 package filenames |
| `producer_inspect_set` | Asset-free tree and exact revision |
| `producer_compile_set` | New validated package from a plan; optional local asset source |
| `producer_edit_set` | New package from atomic edits against an exact revision |
| `producer_validate_set` | Full canonical package validation |
| `producer_check_geometry` | Ring alignment/radius/padding and advisory text overlap checks |
| `producer_visual_check` | Real browser text-fit measurements for every configured layout, plus geometry findings |
| `producer_repair_ring` | Revision-fenced ring repair around an explicitly selected camera, saved as a new draft |
| `producer_preview_set` | Standalone HTML using the actual Producer SetPreview renderer |

Resources: `producer://authoring/guide` is the compact authoring contract; `producer://authoring/schema` exposes the full canonical JSON schema directly from the codec. Load the latter only for advanced file authoring.

Try: “Use producer-sets to make an Attention Is Currency studio in landscape and portrait. Cream, black and red; a circular host camera with a visible voice-reactive ring, and an editable topic headline. Generate both previews.”

The compact profile currently supports panels, text, cameras, existing image assets and four trusted audio-reactive effects. Edits support moving direct layout children, changing literal text, replacing an element with a camera and duplicating layouts. Full-schema file authoring is broader; validation does not mean every feature can be generated through the compact plan.

The visual check needs an installed Chromium browser. On macOS it defaults to `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`; elsewhere configure `PRODUCER_BROWSER_PATH` in the MCP environment. The server never downloads a browser during a tool call. An unavailable browser is an error, not a successful visual check. HTML previews also display a report after checking all layouts. Findings cover current text/default values and direct numeric ring geometry, not all future feed values or animation states. Overlap findings are advisory because editorial layering can be intentional. Ring repairs never move the camera or other artwork; insufficient space produces a diagnostic instead.

## Boundaries and verification

This is a **local authoring server**, not a hosted Claude web connector or room-control bridge. Its capability profile describes this checkout, not the installed native renderer. All reports mark native readiness as untested. Browser cameras are placeholders, microphone animation is simulated, and native media references need Producer. Import the resulting file into Producer to bind sources, rehearse and check native output. There is no automatic room preparation, take, device activation, recording, streaming or deployment.

```sh
npm run test:mcp
# Include real browser rendering (optional; use your installed Playwright module):
PRODUCER_PLAYWRIGHT_MODULE=/absolute/path/playwright-core/index.mjs npm run test:mcp
```

The test connects through the official SDK's real stdio transport and verifies tools/resources, compilation, revision conflicts, unchanged originals, invalid geometry, file boundaries, preview generation and optional browser rendering/script escaping. The server uses the [official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server).

Separate paid acceptance of Producer's saved-Claude route is opt-in, with exactly one request per invocation:

```sh
node scripts/test-design-generation-live.mjs --live \
  --workspace-file /private/path/workspace.json --connection SAVED_CONNECTION_ID
```

That script uses an existing managed connection; it does not put keys in a Set or logs. It reports provider timing, layout counts and sizes, and saves artifacts under `target/authoring-acceptance`. It does not establish native rendering or a statistical generation success rate.
