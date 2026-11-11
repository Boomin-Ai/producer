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

The native runtime initializes lazily on opening the Assistant. Model calls and
credential operations do not run in the audio/graphics path. Existing room
transitions and preparation/output ownership remain unchanged.

References: [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

## First scope and future extension

The first tools inspect/read schema and create/edit private Set drafts. The host
explicitly loads preparation; existing native readiness and output confirmation
remain required. Changing account, model, sharing policy or closing the editor
fences old inference results. Completed edits are retained; unfinished responses
cannot execute tools. No room capture, chat, audio or credentials are shared.

Timeline and audio documents can add domain adapters to the shared service.
Reusable animation still needs explicit composition-local time, deterministic
procedural sampling and qualified seek/export before timeline reuse is claimed.
This first slice does not implement a DAW, timeline renderer, continuous room
following, voice, arbitrary host control or media-generation approval workflow.

## Verification

`test:authoring-foundation` checks transactions, preservation, concurrency,
history and a second document adapter. `scripts/test-assistant-browser.mjs`
exercises the real worker and IndexedDB with a fake inference adapter, including
explicit loading, cancellation and sharing-policy fences. Rust tests verify the
OAuth request/callback contract, real test signatures and stream parsing.
The test signing key is discarded; committed fixtures contain public keys and
synthetic test tokens only. Browser/contract passes are separate from real
ChatGPT authentication, native readiness and physical recording performance.
