# Local studio ownership: first implementation boundary

Status: proposed implementation slice, November 8, 2026. The product direction
is accepted: Producer works independently; Boomin Network is an optional
collaboration service. This document specifies the prerequisite change before
exposing a no-account studio entry. No migration described here has been applied
to an installed profile.

## Ownership contract

A persisted workspace owns local production documents. An endpoint attaches
authenticated remote services to a workspace. A local workspace is not an
endpoint with a fabricated URL, token or Boomin identity.

Add a durable workspace owner separate from endpoint credentials. Persist one
Local workspace ID per application profile; restarting, signing out, adding a
server or disconnecting an account must not regenerate it. Existing endpoint
owners and legacy owners whose endpoint was already deleted also need retained
workspace records. Endpoint removal detaches service access; it does not transfer
the owner's rooms, destinations, recording catalog or credential references.

Keep `endpoint_id` where it means a real remote connection or provenance:
outbox targets, uploads, integration credentials, cache keys, server room access
and recording synchronization. Introduce explicit `workspace_id` for local
production ownership. A detached remote room must not become locally authorized
to host merely because no endpoint can be resolved. Copy/transfer and verified
reattachment are separate operations.

Do not infer an authenticated remote workspace identity from a display name,
handle or matching URL. The current Boomin producer session supplies a display
name, not an immutable brand ID suitable for automatic reattachment. Preserve
detached ownership until a verified reattachment contract exists.

## Versioned migration

Run the ownership migration in one transaction with a durable migration marker.
Stop `store::init`'s repeating NULL-to-first-connected-endpoint backfill before
assigning new Local ownership. Preserve existing non-NULL endpoint assignments
exactly; never guess that a row belongs to a different connected account.

| Existing record | Required owner after migration |
|---|---|
| Room or destination with endpoint ID | Retained workspace for that exact legacy owner |
| Room or destination with NULL endpoint | Stable Local workspace |
| Recording with endpoint ID | Retained workspace for that exact owner |
| Recording with NULL endpoint and a known room | That room's resolved workspace |
| Recording with NULL endpoint and no known room | Stable Local workspace |
| Record whose endpoint was deleted | Retained detached owner, never the active account |

Preserve room JSON, source/Set IDs, media paths, destination IDs, enabled state,
timestamps, recording metadata and opaque keychain references. Migration must
not read or rewrite stream-key contents. A failed or interrupted transaction
leaves the prior data usable; rerunning a completed migration changes no owner.
Include schema and foreign-key integrity checks, not only row-count assertions.
The existing destination preset-table rebuild must preserve the new owner
column. Create a SQLite-consistent pre-migration backup and define downgrade
behavior: an older executable must not reopen the new schema and resume its
legacy ownership backfill.

Do not apply this migration to the user's production or active test profile
until fixture upgrades and real engine-enabled builds are qualified. Use
disposable profile copies for native migration tests.

## Scope every production operation

An omitted endpoint must no longer mean all workspaces. New room, destination
and recording operations take an explicit workspace owner; get/update/delete
verify both owner and record ID. List and fresh-document reads must stay in that
scope, including asynchronous reads that finish after a workspace switch.

Streaming start receives the selected workspace and explicit destination IDs.
Resolve every destination under that owner before reading any stream key or
starting output. Mixed-owner, missing, disabled or stale selections fail before
an encoder/output starts. An empty selection must never fall back to all enabled
destinations. Preserve the existing remote room presence authorization separately.

Existing by-ID room refreshes in Home, room sharing and room synchronization
need an explicitly scoped getter rather than relying on unscoped list calls.
Local recording catalog reads need the same owner even with no endpoint; remote
recording registration remains optional and requires its actual connection.

## UI and Set execution

Add an explicit Local workspace choice and a first-run **Start locally** entry.
Startup and the active-workspace resolver must preserve that choice rather than
falling back to a connected brand. Show optional Boomin Network/server connection
alongside the Local workspace. Connecting a server does not adopt local assets.

The first complete local path is room creation, source setup, local Set library
and MCP import/export, layout selection, recording/catalog and explicitly selected
RTMP destinations. Destination settings must be reachable without an endpoint.
Hosted publishing, brand identity, social data and network guests retain their
real provider requirements.

Simple local layout/value controls already have local execution paths. Stateful
live Set modules need an actual local authority adapter using the existing
command/snapshot contract. Rehearsal simulation must not be relabeled as live.
The local visual-production entry may ship before that adapter, with unavailable
stateful module actions clearly gated. Enable only supported device-backed
capabilities; weather/social/audience controls remain disconnected until their
corresponding services are attached.
External MCP file authoring already works without workspace credentials;
in-app hosted AI authentication is a separate capability.

Local selection must also fence Home's channel/job reads, avatar fallback and
Settings provider fallback. Having an account saved on the device is not consent
to use it from the Local workspace. Diagnostic recording and optional sharing
retain their existing separate consent; local production requires no Boomin
telemetry destination.

## Concrete code boundaries

| Boundary | Current implementation to change |
|---|---|
| Migration and durable ownership | `src-tauri/src/store.rs` |
| Endpoint attachment/detachment | `src-tauri/src/ipc.rs` |
| Room/destination CRUD and streaming selection | `src-tauri/src/live/commands.rs` |
| Recording catalog and optional remote sync | `src-tauri/src/recordings.rs` |
| IPC owner types and explicit scope | `src/lib/ipc.ts` |
| Active selection and startup | `src/lib/workspace.ts`, `src/App.tsx`, `src/views/Onboarding.tsx` |
| Scoped cards, creation and settings | `src/views/Home.tsx` |
| Room authorization, controls and output | `src/views/Live.tsx` |
| Fresh room reads and reconciliation | `src/lib/roomLink.ts`, `src/lib/roomSync.ts` |
| Live module authority | `src/features/presentation/useSetModules.ts` and module runtime adapters |

## Required evidence before enabling the entry

1. Clean profile starts without account/server configuration, creates a room and
   retains the same workspace, room, Set and sources after offline restart.
2. Upgrade fixtures cover old preset schemas, NULL and assigned owners, multiple
   connected workspaces, detached owners, orphan recordings and repeat opens.
   Row contents and credential references remain intact.
3. Local/account A/account B/server reads and mutations are isolated. A delayed
   old-workspace response cannot replace the current view or start output.
4. Adding/removing accounts never silently moves local work or turns a detached
   remote room into local host authority. Remote access checks still apply.
5. An output-start test proves invalid/mixed-owner destinations cause zero
   keychain reads and zero engine starts. Only the explicit validated IDs start.
6. Local Set layouts and supported controls execute in the native engine.
   Unavailable stateful module actions and provider controls are gated explicitly;
   enabling local live modules requires its separate authority-adapter tests.
   No rehearsal transport, invented identity or account bearer substitutes for
   authority. Local mode does not fall back to a saved account for background
   channel/job/avatar requests.
7. Recording finishes, reopens from the local catalog and remains local without
   automatic upload. Remote registration and diagnostic sharing retain explicit
   existing consent and provider scope.
8. Mac and Windows engine-enabled builds pass the same ownership cases, plus
   room close/reopen, camera/mic, Set restore and guest regression checks in
   connected workspaces. Keep the paired network baseline frozen during tests.

Deliver storage, scoped IPC, local execution and UI as reviewable dependent
changes; expose the Local entry only when these prerequisites pass together.
Portable guest authority and server-to-server federation follow this boundary
and are not implemented by a Local button.
