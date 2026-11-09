# Producer handles and downloadable Sets

Producer uses the selected **Boomin brand workspace’s handle**, backed by `brands.id` and the existing globally unique, case-insensitive `brands.slug` index. It does not create a separate identity registry. The same workspace on Mac and Windows owns the same publications.

## Public addresses

| Address | Result |
| --- | --- |
| `producer.dev/<handle>` | Creator identity and public Sets |
| `producer.dev/<handle>/sets` | The creator’s public Set collection |
| `producer.dev/<handle>/set/<slug>` | Set details, artwork and download |
| `producer.dev/<handle>/set/<slug>/download` | Validated `.set.json` attachment |
| `producer.dev/<handle>/og.png` | Dynamic 1200×630 creator share image |
| `producer.dev/<handle>/set/<slug>/og.png` | Dynamic 1200×630 Set share image |

Plural `/sets/<slug>` links redirect to canonical singular `/set/<slug>`. Unknown/private/withdrawn publications return 404 instead of the landing-page fallback. Existing guest, audience, static asset and installer routes keep their precedence.

Boomin’s existing account/workspace setup claims the handle. Its settings remain the place to manage it. New claims and renames share the reserved-route policy. Existing conflicting legacy handles are not silently renamed. **Changing a handle changes its public URLs**; old-handle redirects/tombstones are not implemented. This release does not promise permanent handle aliases.

## Publishing from Producer

In a room’s Set editor, choose **Files → Publish to producer.dev**. This is separate from **Show on output**. Publishing uses a snapshot of the configured package and the selected workspace’s existing native authentication. It does not start devices, change a room, or put anything on output.

- Private is the default. Public and unlisted publishing require explicit confirmation.
- Public Sets appear on the handle page; unlisted Sets resolve only by their exact address.
- New packages create immutable versions. Updates and visibility changes require the current revision.
- An ambiguous request retains its exact body and idempotency key for retry. A different body cannot reuse that key.
- Withdraw blocks public metadata, downloads, previews and share images. It cannot recall files someone already downloaded.
- A preview image is optional. Without it, the page/share card uses a metadata illustration rather than claiming a screenshot of the live room.

The complete authored package—including configured values and embedded assets—is downloadable. Review it before publishing. Saved account connections, room bindings, source/device IDs, stream keys and live account feeds are outside this package. The portable validator rejects known local-media references and credential-bearing links; it is not a general secret detector.

## CLI and MCP

Use an existing Boomin CLI login (`~/.boomin/config.json`); passwords/tokens never go into a Set or command argument.

```sh
node scripts/publish-set.mjs --brand kleveland --list
node scripts/publish-set.mjs --brand kleveland --file my-show.set.json --slug my-show
node scripts/publish-set.mjs --brand kleveland --file my-show.set.json --slug my-show --visibility public --confirm-public --thumbnail poster.jpg
```

Supply `--publication-id` and `--expected-revision` to upload another version. Supply `--idempotency-key` to retry an exact command after an uncertain network result.

MCP file authoring stays local by default. Opt into publishing with `PRODUCER_ENABLE_PUBLISH=1`; optionally set `PRODUCER_PUBLISH_CONFIG` to an existing CLI credential file. This enables `producer_list_publications`, `producer_publish_set` and `producer_withdraw_set`. Each call names its workspace; public/unlisted pushes require `confirmPublic:true`. Request `exportThumbnail:true` on `producer_preview_set` to render a bounded JPEG poster with placeholder cameras, then pass its returned `thumbnail` filename to `producer_publish_set`. An installed Chromium browser renders the poster with external network requests blocked. It never captures a real camera or opens a native room.

## Neon, storage and API

API migration `0188_producer_set_publications.sql` adds brand-owned `producer_set_publications` and immutable `producer_set_versions`. Publication slugs remain allocated after withdrawal. An atomic PostgreSQL acceptance function serializes idempotency keys/revisions, persists the accepted result in `producer_submissions`, and advances a publication with its complete version record. This works through Neon’s noninteractive HTTP connection.

Bytes live under the private `producer-sets/` namespace in the existing `MEDIA_BUCKET`. Uploading an object does not publish it; database acceptance controls visibility. Rejected uploads may leave unreachable objects for later garbage collection. Publication bytes never use `/files/public/*`.

Authenticated API base: `/v1/app/producer/v1`.

| Method/path | Purpose |
| --- | --- |
| `GET /profile` | Selected workspace’s current public identity |
| `GET /sets/publications` | Owned publications and hosting limits |
| `POST /sets/publications` | Create a private/public/unlisted package |
| `POST /sets/publications/:id/versions` | Accept an updated package at an exact revision |
| `PATCH /sets/publications/:id` | Publish, withdraw or adjust visibility/metadata |

Writes require workspace-admin authority and an `Idempotency-Key` header or matching `idempotency_key` body field. Native uses the body field. Ownership comes from the authenticated selected workspace, never from package-supplied brand IDs or handles.

Anonymous API base: `/v1/connect/producer/:handle`, with `/sets/:slug`, `/sets/:slug/download`, `/sets/:slug/preview`, `/og.png`, and `/sets/:slug/og.png`. Every request checks current active workspace/publication visibility before storage or rendering, including HEAD and old `?v=` requests. Initial public responses use `no-store`. The public website forwards no cookies/bearer tokens and never accepts an arbitrary proxy target.

Public packages are limited to **8 MiB**, optional PNG/JPEG previews to **512 KiB**, and JSON envelopes to 12 MiB. Local imports retain the existing 40 MiB limit. The full canonical codec—including 3D, effects, runtime controls and integration requirements—is exported reproducibly with `scripts/export-set-publication.mjs`; the API commits source/artifact hashes. This is separate from the restricted hosted AI authoring profile.

Preview uploads are decoded, dimension-bounded and re-encoded with the existing Images binding. Share images reuse Boomin’s Satori/Yoga/resvg renderer and bundled fonts; they accept bounded metadata and owned raster previews. They do not fetch author URLs or execute Set runtime code.

## Verification and deployment

Producer: `npm run test:set-publication`, `npm run test:mcp`, and `node tools/producer-mcp/test-publication.mjs` (installed Chromium required for visual tests).

API: typecheck, focused publication/handle route tests, disposable PostgreSQL concurrency proof, and `node scripts/test-producer-og.mjs` for actual offline PNG rendering. Deployment qualification additionally checks real handle pages, content types, download digest/re-import, visibility/listing rules and withdrawal denial through both API and producer.dev.

Website/API deployment and a desktop release are separate operations. A desktop release does not automatically deploy `site/_worker.js`; its Pages project is `producer-site`. Deployment receipts must identify the shipped API/Pages versions rather than infer live routes from source or a 200 static fallback.
