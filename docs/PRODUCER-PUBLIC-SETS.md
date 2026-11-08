# Producer public identities and downloadable Sets

Audit date: 2026-11-08. Producer source: `98a2a87` plus the uncommitted beta-entry changes. Boomin API source: `9ff3e38`; Boomin web source: `e65fd14`. These are source findings, not a deployment or a verification of live production routes.

The requested addresses are `producer.dev/<handle>` and `producer.dev/<handle>/set/<set-slug>`, for example `producer.dev/kleveland/set/internetdj`. They should use the same canonical Boomin brand handle selected in Producer. This document proposes publication; it does not implement it.

## Existing identity and routing

| Surface | Current implementation | Consequence |
| --- | --- | --- |
| Producer website | `site/_worker.js` proxies branded guest/audience pages and their room assets, and streams stable GitHub installers. Other paths reach `env.ASSETS.fetch(req)`. | Neither a bare handle nor a Set publication has a dynamic route. A static landing-page fallback is not proof of an identity or Set page. |
| Canonical handle | Boomin API `src/routes/app/auth-workspace.ts`: authenticated `GET /v1/app/brands/handle-availability`; org-admin `POST /v1/app/brands`; brand-admin `PATCH /v1/app/brands/:brandId`. | Reuse this ownership and namespace. Do not create a second Producer-specific handle registry disconnected from Boomin. |
| Handle race protection | Boomin migration `drizzle/0133_brand_handle_unique.sql` creates unique `lower(brands.slug)` for rows with `deleted_at IS NULL`. | Live handles are globally case-insensitive unique, even across organizations. A preflight availability result does not reserve a handle; the write/index remains authoritative. |
| Handle editing | Boomin web `src/components/workspace/ConsolePanel.tsx` probes availability and saves through `api.updateBrand`; it warns that changing the handle changes the workspace URL. | There is existing authenticated handle editing, but no dedicated preferred-handle claim step in Producer's sign-in form. |
| Public brand projection | Boomin `GET /v1/connect/b/:slug`, in `src/routes/connect/brand-page.ts`, returns allowlisted active, non-deleted brand/lobby data. | A public identity source already exists. Avoid copying private workspace/account payloads into a Producer profile. |
| Boomin public rendering | Web `src/pages/PublicPageRenderer.tsx` uses a published custom page if present, otherwise a bare slug falls back to `BrandPublicPage`. Unmatched multi-segment paths render Page not found. | Boomin's public lobby does not currently provide `/<handle>/set/<slug>` downloads. |
| Existing template sharing | `api/src/services/public-templates.ts` and `routes/public-share.ts` support published workspace/flow templates, with explicit visibility gates and permanent template slugs. | Useful publication patterns, but different artifacts and import semantics. |

Identity is the selected **brand**, not a machine or a personal login. One account may act in several brands; the same brand selected on Mac and Windows should own the same public address. Publication records should reference stable `brandId`, not duplicate the mutable slug as ownership.

### Signup and an account without a workspace

`https://boomin.ai/signup` is an explicit web route: `web/src/App.tsx` mounts `LoginPage` at both `/signup` and `/login` before the dynamic public-page fallback. `LoginPage` requests and verifies email OTPs through the existing API.

`api/src/routes/app/auth-workspace.ts` provisions a default workspace for a genuinely new email via `resolveBrandWorkspaceContext(..., {provisionIfEmpty: true})`. Existing audience-tier accounts intentionally remain workspace-less; `src-tauri/src/ipc.rs` then rejects Producer connection when the brand list is empty. Boomin's `web/src/pages/PortalPage.tsx` has an explicit **Create your workspace** action using `api.createOrg`, so this is a web recovery path, not a reason to silently create a brand in Producer.

The beta-entry UI now gives an explicit fixed Boomin signup link and says to set up an account/workspace and then sign in. It preserves the normal OTP path and existing self-hosted endpoints. It does not yet claim a chosen public handle or automatically publish a profile/Set. A default workspace slug is not a preferred-handle selection experience.

## Existing Set authoring and storage

* `tools/producer-mcp/server.mjs` authors local files only. Its tools compile, edit, validate, inspect and preview complete `.set.json` packages; they do not carry workspace credentials, upload packages, mutate rooms or start devices.
* `src/features/presentation/schema.ts`, `validation.ts` and `assets.ts` define the canonical `producer.presentation/2` package. The complete JSON is bounded to 40 MiB, embedded assets to 12 MiB each, and layout/asset/reference structures are validated.
* `src/features/presentation/SetConfiguration.tsx` imports validated packages into the native library and prepares them through the existing editor/rehearsal path. Viewing or importing an artifact is not permission to take it on output.
* Boomin's `src/routes/set-modules.ts` stores room runtime state and saved integration bindings through authenticated room/brand routes. Saved integrations encrypt provider credentials separately. These routes are not a full-package distribution library.
* Hosted `POST /v1/app/data-integrations/:id/author-set` returns a validated draft through a saved provider connection; it does not store generated packages. The generated API module currently exposes a restricted authoring parser/profile, with a 64 KiB asset-free base and a smaller supported feature set. Reusing that public parser would reject full DJ/Three.js packages.
* `scripts/export-set-authoring.mjs` already demonstrates reproducible generation from Producer's canonical code, including source/artifact hashes. A publication validator can follow this pattern while exporting the complete package parser and requirements/features helpers separately.
* No full Producer Set publication table or anonymous package-download route was found in the inspected Boomin database/routes/services. The existing `resources` table has a database kind constraint allowing only `flow_template` and `workspace_template`; a Producer Set should not be disguised as either.

### Portability needs an extra check

Canonical validation explicitly allows a local `producer-media:<UUID>` asset reference. It is valid on its originating installation, but a recipient cannot resolve that media UUID. A public export must reject unresolved references or explicitly embed the authorized bytes within package/asset limits. Uploading a structurally valid local package unchanged is insufficient.

Publish the portable package, not a room configuration, prepared native scene, saved-source binding, camera identity, integration connection ID, provider key or runtime snapshot. Integration **requirements** belong in the package as portable role/capability contracts; recipients bind their own connections locally. Embedded media remains part of the downloadable artifact. Validation must not fetch author-supplied URLs, resolve arbitrary filesystem paths, or start media capture.

Structural validity is not native readiness. Keep the existing distinction (`validation: package-structure`, native readiness not tested) unless a separate qualified renderer run supplies evidence.

## Proposed first slice

This beta slice uses Boomin as the identity/publication authority. It does not implement federation, a separate account system, arbitrary upstream servers, automatic local-library upload, or remote control of native output.

### 1. Explicit authenticated publication

Add a focused route family under the existing Producer API contract, for example:

* `POST /v1/app/producer/v1/sets/publications`: create a publication from an explicit portable package, requested Set slug/title and idempotency key.
* `PATCH /v1/app/producer/v1/sets/publications/:id`: publish a new immutable version or change visibility with an expected publication revision.

These names are proposed. The current native endpoint base is `/v1/app/producer`; its contract paths themselves begin `/v1/`, which explains the repeated version segment.

Resolve authenticated selected-brand context on the server and require brand editor/admin authority for every write. Never accept a body-supplied handle/brand ID as ownership. Recheck ownership when finalizing an uploaded artifact. Reject unknown metadata fields and bound title/description/slug input.

Validate the full canonical package and public portability policy before storage/activation. Keep a stable publication ID, stable owner brand ID, a per-brand slug, lifecycle/visibility, current version pointer and optimistic revision. Versions hold immutable artifact digest, byte count, schema, feature/requirements summaries and creation time. A retry with the same idempotency key must not mint duplicate publications or versions.

Reuse the existing R2 binding for bytes in a **non-public** namespace, addressed internally by publication/version/digest. A database visibility gate selects the object. Do not expose an unrestricted R2 key lookup or copy these artifacts into the current generic `/files/public/*` route: that route bypasses publication visibility and defaults to year-long immutable caching.

A dedicated small publication table/version table is clearer than widening workspace-template semantics implicitly. Any reuse of `resources` would require an explicit new kind, migration, serializer, importer and visibility rules.

### 2. Anonymous identity, landing page and download

Add allowlisted public metadata and download endpoints, for example:

* `GET /v1/public/producer/:handle`: public identity and listed Set summaries.
* `GET /v1/public/producer/:handle/sets/:slug`: publication metadata and available layouts/features.
* `GET|HEAD /v1/public/producer/:handle/sets/:slug/download`: exact validated `.set.json` bytes.

Require active/non-deleted brand and published, non-private artifact state for metadata and bytes alike. Private, withdrawn and nonexistent publications return the same public 404. Unlisted artifacts may be readable by their exact address while omitted from the profile index; only add that mode if needed.

Add explicit Producer site handlers **before** `ASSETS.fetch` for `/<handle>`, `/<handle>/set/<slug>` and its download child. Fetch only the fixed approved API origin and route shape; forward no browser authorization/cookies. Do not proxy a query-supplied URL. Keep installer, room/guest/audience and static assets working with their current precedence.

Render escaped, allowlisted title/author/description, an optional platform-served preview, supported orientations/features and a **Download Set** action. A static preview is sufficient for the first slice. Do not expose an arbitrary author-hosted image beacon or automatically execute a full Set in the public landing page.

Downloads use a sanitized attachment filename ending `.set.json`, `application/json`, `X-Content-Type-Options: nosniff`, a digest ETag, byte length and bodyless HEAD support. Mutable aliases/visibility decisions need short or revalidated caching and invalidation on withdrawal. Do not apply year-long public caching to revocable artifact bytes merely because their internal object is immutable; an already downloaded file cannot be recalled.

Anonymous viewing/downloading needs no Boomin account. Authenticated publishing does. Import continues through the existing local validation/prepare workflow and never silently replaces current output or starts camera/audio/streaming.

### 3. Canonical handle policy before a claim UI

Two existing behaviors prevent a promise of permanent identity URLs:

1. Migration 0133 expressly frees a soft-deleted brand's handle. It even documents that restoring after another claim can fail.
2. Renaming currently releases the old brand slug; no persistent redirect/tombstone registry was found in the inspected paths.

Choose and implement an explicit alias/tombstone/reclaim policy before advertising permanent links. Prefer stable brand ownership plus canonical redirects from retained old handles; never let an unrelated brand silently inherit another publisher's old public artifact address. Publication slugs should also remain reserved to their original publication after withdrawal rather than be reassigned silently.

Current `slugify` returns `brand` for an empty/non-Latin result, so `if (!handle)` in availability does not reliably identify invalid original input. There is no shared reserved-name check in the inspected claim/update helpers. Introduce a shared strict, bounded handle grammar and reserved top-level namespace policy across availability and every writer, with the database index as the final race gate. Inventory defaults/auto-provisioning (`createOrgWithDefaultBrand`) as well as direct brand POST/PATCH.

Producer reserved routes include `download`, `room-assets`, `connect`, `audience`, static asset names and future documented system paths. Coordinate with Boomin's explicit `login`, `signup`, `brand`, `auth`, `api`, `producer`, `portal`, `tools`, `e`, `c`, `t`, `l`, `o`, `r`, `s` and other router-owned names. Existing owners of conflicting handles need an explicit compatibility policy; do not silently rename live customers. The nested literal `set` keeps Set pages separate from a handle's existing `guest` and `audience` pages. Set slugs are unique case-insensitively within a stable brand, with any download/version child routes unambiguous.

## Implementation and verification boundaries

Producer changes would be limited initially to the fixed site routes/landing UI, an explicit authenticated publish action and reproducible full-validator export. Boomin changes would add publication storage/migration, authenticated write routes, public serializers/download route and shared handle policy. Native rendering, RTC and the Set runtime do not need a new implementation for distribution.

Before shipping, test:

* Actual fresh, returning, multi-brand, self-hosted-existing and workspace-less beta entry, with the real signup route confirmed. Current fake-IPC component tests exercise UI policy, not live account provisioning.
* Authenticated owner/editor writes, denied non-editor/cross-brand changes, idempotent retry, revision conflicts and simultaneous normalized slug claims.
* Complete-package validation, size/depth/reference limits, unresolved local media, malformed embedded assets, unsupported features and no URL/filesystem fetches during validation.
* Publish/download/reimport of a real DJ/3D Set with all orientations/effects preserved, plus local integration rebinding. A package-structure test must not be reported as a native visual/audio pass.
* Listed/unlisted/private/withdrawn states on metadata, GET, HEAD and cached responses; safe filename/MIME/escaping; no unauthorized storage-key lookup or cookie/bearer forwarding.
* Current and retained handle aliases, deletion/restoration/reclaim policy, reserved-name collisions, static files, installers, branded guest and audience routes.
* No implicit room/output/device action from page view, download or file import.

No public Set publication, route deployment, credential change or preferred-handle claim was performed for this audit.
