# Producer Storage

Settings → Storage replaces the former Virtual camera placeholder. The active workspace determines hosted usage; local usage covers this Mac across all workspaces. These are separate storage locations and are not added into a misleading single unique-content total.

## Hosted media

`GET /v1/app/files/storage` returns registered R2 media bytes, unique object count, category breakdown, unknown-size objects, external reference count and measurement time. Brand and folder permissions are enforced by `activeBrandContext`; restricted users see only their accessible folders and the UI names that scope accordingly. SQL sums each storage key once, using its largest recorded size, and excludes deleted files/folders, external URLs and local-only recordings.

This is an inventory total, not the R2 billing total: orphaned objects and preview derivatives that lack their own size record are not included. Instagram archival registers actual original and thumbnail sizes; those objects appear in this total.

The endpoint and archival jobs shipped in [API PR #409](https://github.com/Boomin-Ai/api/pull/409), merged as `114405cfa3ce183e071b1e21e8ca4f961a1122f9`. [Deployment 36493040737](https://github.com/Boomin-Ai/api/actions/runs/36493040737) passed migration `0164`, Worker deployment and both production smoke checks. Older endpoints show unavailable reporting rather than a fabricated zero.

The query uses the same credential-scoped native SQLite Manager cache, with a 60-second freshness interval and manual Refresh. Failed reads preserve the last measurement; explicit access denial hides it.

## This Mac

`producer_storage_usage` measures the app-data directory and existing tracked recording files plus every file in the default Movies/Producer (Videos/Producer on Windows) output folder, including legacy and renamed recordings. File paths stay native. The folder scan also finds recordings created before database tracking existed. Duplicate recording paths are counted once; recordings inside app data are not added again to the total. Missing recordings and unreadable entries are reported; directory symlinks are not followed. The filesystem scan runs on a blocking worker, not the UI thread. Measurements are read-only; this page offers no file deletion.

## Verification

- Producer build and API typecheck passed.
- Native test confirms inside/outside recordings, duplicate references and missing files.
- `scripts/storage-browser.html` verifies hosted/local rendering, warm cache reuse, refresh failure recovery, brand switch isolation and a missing API response.
- Read-only Neon audit validated SQL totals against an independent aggregate on three brands, category sums, empty folder scopes and an absent brand.

## Instagram archival and fresh pull

Instagram ingress now enqueues a durable media archive in Boomin. Images, original videos, carousel children, and supplied posters are saved to R2 and registered with actual sizes in Neon. Permanent URLs survive later pulls. Other providers retain their existing behavior. See the API `docs/SOCIAL-MEDIA-ARCHIVE.md` contract.

Use Settings → Integrations → the connected Instagram channel → **Pull posts**. The control queues discovery and polls completion; Manager inventory is invalidated as work advances. Downloads continue if you leave Settings. This does not publish anything.

## Kleveland fresh-test checkpoint — September 28, 2026

Authorized reset completed on main for brand `56092328-4abf-4132-b491-d17480b2ddf3` (`kleveland`): 82 posts, 287 units, 31 collections, 378 Instagram comment/DM events and 14 DM threads removed. All corresponding remaining counts verified zero. Dependent files, content folders, post metrics, publishing and sync jobs were removed through scoped deletes/cascades. R2 objects were retained for recovery.

Before/after fingerprints verified unchanged users, organizations, memberships, brands, integrations, credentials, connections/grants, universe entities and contacts. Other brands’ posts, units, collections, events, threads/messages, files/folders and sync jobs were unchanged.

Recovery branch `producer-kleveland-before-reset-20260928` (`br-odd-art-akzhz6kn`) was created from main before deletion and is ready, without compute. Do not delete it until the user accepts fresh ingress and publishing. The separate `producer-kleveland-reset-20260928` branch is disposable rehearsal data, not the recovery snapshot.

Kleveland’s two local Manager query/navigation cache entries were cleared and dev cache reload requested. There were no local submission targets for this endpoint. No real Instagram pull or publish was triggered by the agent.

Verification: API 878 tests, Producer build, disposable Neon archival/reset rehearsals and mocked pull-control browser regression all passed. The user will pull @kleveland from Settings → Integrations, verify ordered media, posters, unit links, comments and storage, then test a new post before DMG release. A production room startup/rendering issue reported during this task cleared on relaunch and remains unresolved for follow-up.

## User-triggered pull and publishing verification — September 28 evening

User reported posting through Producer. Read-only production audit confirmed Instagram post `18094075823536941` at https://www.instagram.com/p/Dd2em-emSW6/ is published, its publishing job is completed, and it retains originating unit `65080050-4bfd-4c0c-993e-0bd27b2a3146` (also published). Exactly one post exists for its integration/provider media identity. Comments sync and R2 archival completed. The archived 87,725-byte JPEG and permanent thumbnail URL return HTTP 200 with matching content type/size.

Fresh ingress contains 72 posts and 72 units, zero unlinked posts, and zero collections. Of these, 67 media archives completed. Five older videos remain unarchived: four Instagram discovery responses omit media_url while supplying thumbnail_url; one archive job exhausted attempts with its original error replaced by the claim-attempt exhaustion message. These are remaining ingress issues; do not describe all imported originals as archived or the release as fully verified. Preserve provider-missing-original visibility and archive supplied posters, and investigate/fix retry/lease behavior before treating these cases as complete. Do not trigger another bulk pull or publish as part of a read-only verification.

Production room startup/rendering issue reported earlier also remains unresolved. No Apple release was initiated in this verification turn.

## Historical-original recovery and preview lifecycle (2026-09-28)

API PR #410: https://github.com/Boomin-Ai/api/pull/410
Merged commit: `f819cee540175fce41ba3223c39e35b5f01cb209`.
Deployment: https://github.com/Boomin-Ai/api/actions/runs/36514097719

Four historical Instagram video responses omit the original URL but provide a
thumbnail. Producer now shows the permanently saved thumbnail and “Original
media unavailable from Instagram.” An explicit “Add original” action uses the
native upload contract and the new scoped original-restoration endpoint; it
attaches to the same post/unit, without publishing again. API/file availability
fields are whitelisted into the existing cache. Failed attach requests reuse the
uploaded file. Carousels do not offer a whole-post original replacement.

Fixed the final-attempt sync lease race and preserved actual download errors.
A targeted five-post repair is tracked by `/tmp/producer-archive-five-repair.ts`;
its baseline verifies the other 67 posts and registered assets are unchanged.
No additional bulk pull or Instagram publication is part of this repair.

Room preview: serialized attach/move/detach across mounts, unconditional teardown
on close (including in-flight attach), timed retry after attach failure, and
bounds recorded only after successful move. Repeated native attach updates the
existing preview's rectangle. The exact production glitch has not been reproduced;
these fixes address observed lifecycle and stale-frame defects.

Verification: API typecheck and 879 tests; disposable Neon poster/import/restore
and job-lease rehearsal; Producer build; cache suite; mocked browser restoration
and retry; delayed-preview lifecycle regression; native cargo check using the
installed engine. Development Tauri watcher rebuilt the process. Apple release
has not been dispatched.

Production PR #410 deployment passed both smoke gates. All four provider-missing
originals completed as `preview_only` on their first repair attempt, with R2
thumbnail HEAD 200 (541,539; 593,247; 42,796; 63,520 bytes). The unaffected 67
posts and 123 file records exactly match the repair baseline fingerprint.

The fifth video still held stale leases despite reachable existing CDN URLs
(38,048-byte MP4 and 43,342-byte JPEG). PR #411 adds deadlines to provider refresh,
R2 lookup, multipart creation/parts/completion and stream cleanup, plus a
lease-owned stage marker. Commit `b26784be2b690c217b8a27457ace60f7f76c7305`;
deployment https://github.com/Boomin-Ai/api/actions/runs/36516448245.
API verification now includes 880 tests. Production key/runtime log access is
not available locally; diagnostics avoid exposing credentials or signed URLs.

The fifth job's stage marker identified `ensure_folders`. Its 81 UTF-16-unit
caption ends in an emoji crossing the old 80-unit truncation limit. PostgreSQL
rejected the resulting lone surrogate; persisting the error also failed because
it contained the malformed folder title. PR #412 preserves code points in folder
and file names and makes sync errors valid Unicode. Typecheck, 885 tests, and the
Neon boundary-caption/error-persistence rehearsal pass.

The dev room's indefinite warm-up was a separate launch issue: the bare debug
executable lacked `browser_source`. `npm run dev:room` now runs current native
code in an installed-engine app bundle with Vite HMR; its boot report passes all
required modules. Completed failed boot now displays a failure message.

PR #412 merged as `80173e7fd77f79d722074370da9d7d0636b7c6bb` and production
deployment https://github.com/Boomin-Ai/api/actions/runs/36519204135 passed both
smoke gates. Only the fifth job was retired and replaced by
`4bf1acd2-3919-4828-abe8-eb4fc6cc9415`; it completed on attempt 1. Its permanent
MP4 (38,048 bytes) and JPEG (43,342 bytes) both return HEAD 200. All five repair
targets are complete, including four preview-only posters. The unaffected 67
posts and 123 file records exactly match the original repair baseline. No bulk
pull, new publication, or Apple release was triggered.
