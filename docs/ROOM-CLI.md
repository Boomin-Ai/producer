# Development room control

Start the regular frontend for an **isolated, signed development bundle** with:

```sh
VITE_ROOM_CLI=1 npm run dev -- --host 127.0.0.1 --port 1436
node scripts/room-cli.mjs
node scripts/room-cli.mjs home state
node scripts/room-cli.mjs room state
node scripts/room-cli.mjs assistant state
```

Port 1436 is the existing Mac DJ Test bundle's dev URL. Use the configured port
for other isolated bundles. This is the complete application, not a stripped room
fixture. A production bundle is not accepted. The transport is absent from
production builds and disabled by default in development.

State snapshots expose the room document, scene/source inventory and geometry,
Set layouts/fields/bindings, dock placement and expansion, engine/output status,
and Assistant context, progress, conversation and private draft. Credentials,
private media locations and embedded asset bytes are replaced with markers.
Snapshots are generated on request, not on incoming video/audio frames.

Each surface returns a command catalog and an epoch. The CLI obtains fresh state
before mutations, then sends the epoch and room ID. Navigation invalidates stale
commands. Unknown commands and raw JavaScript/native invocation are rejected.

```sh
node scripts/room-cli.mjs home room.create '{"name":"Assistant Reliability Lab"}'
node scripts/room-cli.mjs home room.open '{"id":"ROOM-ID"}'
node scripts/room-cli.mjs room panel.move '{"panel":"assistant","dock":"bottom"}'
node scripts/room-cli.mjs room dock.set '{"dock":"bottom","open":true,"size":56}'
node scripts/room-cli.mjs room assistant.open
node scripts/room-cli.mjs assistant prompt '{"text":"Create a paired-format Set"}'
node scripts/room-cli.mjs assistant send
node scripts/room-cli.mjs assistant state
node scripts/room-cli.mjs assistant review
node scripts/room-cli.mjs room sets.list
node scripts/room-cli.mjs room set.load '{"id":"SET-ID"}'
node scripts/room-cli.mjs room set.layout '{"id":"LAYOUT-ID"}'
node scripts/room-cli.mjs room leave
```

`assistant create @plan.json` runs the same revision-fenced Set tool and Worker
validator as the Assistant. It accepts `{plan:{schema:"producer.design-plan/2",
package:...,assetRefs:[]},label:"..."}`. It does not publish or change output.
`assistant review` saves the candidate and opens the ordinary private Set editor.
`set.load` explicitly selects a saved Set using the room's normal preparation
handler. Device capture and output actions retain their existing native checks.

The current catalog covers room creation/entry/exit, panels, docks, inactive scene
creation, scene source placement/selection, Set selection/layout/fields/output,
device inventory, hidden camera/screen/color creation, source binding and
Assistant authoring/review. It deliberately does
not expose streaming/recording start, guest admission, microphone mute, publishing
or arbitrary integration calls. The host Assistant now uses an explicit subset
of these named room actions alongside private Set/Show authoring. It receives
fresh structural context on inference rounds, not automatic camera pixels,
audio, chat or credentials. Scene cuts, active scene edits, capture starts and
on-output Set-role changes require host confirmation; room and epoch fences
are checked again after approval. The internal action registry ships with the
app; this HTTP/HMR transport remains development-only.

`assistant attachments.add` accepts explicitly supplied synthetic bytes for
development tests, never a local file path. `assistant room.approve` resolves
the current approval ID for an authorized test. Neither command is advertised
to the model. Production attachment selection uses the native file picker or
an explicitly pasted screenshot, with separate inspiration/production purposes.

The CLI token is generated per dev-server session and stored in
`.room-control/session.json` (directory 0700, file 0600, ignored by Git). HTTP accepts
loopback connections with a bearer token, rejects browser-origin requests and
unexpected Host headers, and routes to exactly one connected isolated dev window.
Keep the dev server private. Treat a trusted local development server as code
execution authority. A timeout does not prove a mutation failed: inspect state
before retrying. Do not retry mutations automatically.

Checks:

```sh
node scripts/test-room-cli.mjs
PRODUCER_TEST_CLI_HTTP=1 node scripts/test-room-cli.mjs
node scripts/test-assistant-reliability.mjs
```
