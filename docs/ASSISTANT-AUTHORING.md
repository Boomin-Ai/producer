# Assistant authoring foundation

Producer owns media authoring and execution. ChatGPT is the first local inference
adapter; Boomin remains the collaborative network. Prompt-sheet code informed
the design without adding Boomin as a model provider.

## Shared contracts

`shared/authoring/session.ts` is a document-agnostic transaction/history service.
The Set adapter delegates to the existing canonical compiler and validator.
Stable-ID property/track operations resolve against the inspected revision;
canonical edits retain access to every supported field, control arrangement,
runtime definition and 3D world. Existing Set formats remain unchanged.

History stores one base package and bounded edit commands. Writes serialize;
stale, conflicting or invalid transactions leave the current draft intact.
Undo/redo and saved-journal restore use the same domain adapter. The browser
Assistant runs authoring in a dedicated worker and persists journals in
IndexedDB. MCP uses the same Set service with its existing file permissions.

New authored transactions also resolve the default state of every layout using
the pure rehearsal/projection contracts before committing. This catches valid
binding shapes with invalid renderer values, such as a zero music waveform
height. It does not allocate GPU resources, start devices, or prove every
control state. The same validation gates explicit preparation loading and MCP
compile/validate operations. It never runs in the room's frame/audio path.

Journals are scoped by source revision as well as endpoint and Set identity.
Reopening a different source version cannot overwrite its earlier draft.
Existing journals remain readable and repairable; a preview error boundary
keeps the Assistant, saved history and undo controls available after a render
failure. Failed candidates do not replace a working draft.

Set controls remain authored surfaces, including per-layout visibility,
arrangements, bindings, configuration and minimized controls. Assistant preview
uses the existing control renderer against an isolated rehearsal session.

## Provider boundary

`crates/assistant-runtime` performs official ChatGPT OSS dynamic registration,
loopback PKCE/state/nonce authorization, signed ID-token validation, account
selection, serialized token refresh, model discovery, SSE inference, cancellation
and sign-out. It has no room or engine dependency. The Tauri adapter supplies a
separate OS credential-vault namespace and a per-profile process lock. Tokens,
authorization URLs and endpoint credentials never enter the webview.

First-time browser authorization has a bounded 15-minute window for account
selection, MFA and consent. Producer shows its deadline; cancellation still
stops the attempt immediately. An expired attempt requires a fresh browser
flow and a new PKCE/state/nonce; pasted callback URLs are never replayed.

Completed response items return in the native command result; the progress
channel is only for streaming text. Command completion and channel delivery can
be reordered by IPC, especially with large tool payloads. The provider adapter
also awaits the terminal payload from older development hosts. No tool executes
from partial text or from a command acknowledgment without its completed data.
The transport regression deliberately delivers that data after the acknowledgment.

The native runtime initializes lazily on opening the Assistant. Model calls and
credential operations do not run in the audio/graphics path. Existing room
transitions and preparation/output ownership remain unchanged.

References: [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## Room, Set and Show authoring

The host Assistant distinguishes the Room workspace (scenes, native sources,
source assignments and docks), the reusable Set design, and the Show rundown.
An explicit room-tool allowlist shares existing host actions with the development
CLI. It has no generic eval, native invocation or arbitrary integration proxy.
Room context is inspected on request; no serialization or inference runs on
incoming media frames. Source creation uses the native engine's supported hidden
camera, screen and color recipes. Text graphics and imported media are authored
inside the private Set. Capture and live-output changes wait for host approval.

`producer.author_show` writes a real canonical `package.show`, validates phase
layout references and adds Start/Previous/Next controls without replacing authored
controls. Shows use existing runtime cues. `collectMs` is a voting collection
timer, not a general-purpose automatic segment scheduler.

Explicit attachments distinguish inspiration from production material. Attached
image previews use image input; reference images are not imported as Set assets.
Production files pass the existing local asset validator and receive stable IDs
the model may reference. Full production bytes stay in the local draft worker;
the model receives metadata and image previews where supported. Attachment text
is untrusted content. This does not add an image-generation provider.

## Future extension

Set tools inspect/read schema and create/edit private Set/Show drafts. The host
explicitly loads preparation; existing native readiness and output confirmation
remain required. Changing account, model, sharing policy or closing the editor
fences old inference results. Completed edits are retained; unfinished responses
cannot execute tools. No automatic room capture, chat, audio or credentials are shared.

Timeline and audio documents can add domain adapters to the shared service.
Reusable animation still needs explicit composition-local time, deterministic
procedural sampling and qualified seek/export before timeline reuse is claimed.
This first slice does not implement a DAW, timeline renderer, continuous room
following, voice, arbitrary host control or media-generation approval workflow.

`scripts/test-assistant-room-authoring.mjs` checks room authority, replay and
approval fences, linked Show execution and asset-purpose separation.
`scripts/test-assistant-room-browser.mjs` exercises the actual React tool loop,
worker and file selection with mocked inference. Real ChatGPT image recognition,
Set/Show creation, source binding and native Show Start/Next were separately
qualified in the signed dev bundle; synthetic color sources are not camera or
microphone performance evidence.

## Verification

`test:authoring-foundation` checks transactions, preservation, concurrency,
history and a second document adapter. `scripts/test-assistant-browser.mjs`
exercises the real worker and IndexedDB with a fake inference adapter, including
explicit loading, cancellation and sharing-policy fences. Rust tests verify the
OAuth request/callback contract, real test signatures and stream parsing.
The test signing key is discarded; committed fixtures contain public keys and
synthetic test tokens only. Browser/contract passes are separate from real
ChatGPT authentication, native readiness and physical recording performance.
`scripts/test-assistant-preview.mjs` covers real React fault isolation and
repair, a default-invalid alternate layout, older draft recovery, and separate
journals for source revisions. These browser tests run with mocked inference;
real signed-app sign-in and focused edits were also checked separately.

For an isolated native login check, start Vite on port 1436 with
`VITE_PRODUCER_ASSISTANT_WORKBENCH=1` and open the existing signed Producer DJ
Test bundle. This development-only view reuses SetConfiguration and the real
Assistant provider without mounting a room or starting capture. The flag is
removed from production builds. A saved candidate still needs the normal room's
native preparation before output. `scripts/test-assistant-workbench.mjs` checks
that this view uses no live-engine commands; it does not qualify authentication.
