# Producer Manager cache

Implemented September 28, 2026. Boomin remains authoritative; the local cache is disposable. Drafts, posting intents, credentials and local recording files remain in their existing stores.

## Data flow

`HostedManager` verifies a local native session scope, opens the shared query client and restores its SQLite snapshot before rendering. Collections, units, posts, recording provenance, channels and per-unit media file lists are independent queries. Overview, Stages, collection views and unit details derive their presentation from these records. Query clients survive Manager unmounts.

Cold starts display restored data and reconcile it with Boomin in the background, including changes made by native outbox replay or Boomin web. Warm returns reuse fresh memory data without inventory requests. Stale returns retain visible content during revalidation. Refresh leaves the shell, metadata bar, selected tab and scroll position mounted.

## Policy

| Resource | Freshness |
| --- | --- |
| Collections, units, posts, recording provenance | 2 minutes |
| Connected channels | 5 minutes |
| Unit media file lists | 1 minute |
| Published post comments | 30 seconds; refresh every minute while the Comments tab is open |
| Processing units | Poll every 15 seconds while active/focused |
| Local recording catalog | Read on mount/focus and every 10 seconds while active |

Publishing-state changes invalidate posts. Create/rename callbacks cancel older reads and update the acknowledged records immediately. Accepted submissions, disconnects and successful content/file/series writes mark relevant session data stale. Desktop focus and network reconnect revalidate stale active queries. No polling runs for unmounted Manager queries.

Navigation saves location, Overview selection, stage filters, up to 100 unit tab selections and up to 100 scroll routes. Explicit recording opens override the saved location. Missing restored resources return to Overview. Temporary menus and unsaved forms are not treated as server cache records.

## Native storage and isolation

`producer.db.manager_cache` holds query snapshots and navigation separately. Query data expires after 24 hours; navigation after 30 days. Entries are limited to 8 MiB each and the whole table to 64 MiB. Memory retains at most eight workspace sessions, with inactive queries collected after 24 hours.

Rust derives an opaque scope from endpoint ID, host, brand and current vault credential. Each native cache read/write verifies it. The token never enters the frontend or the cache table. Credential rotation starts a new scope and discards old persisted rows. Endpoint deletion cascades to its cache; frontend disconnect/sign-out clears the corresponding query client. Explicit HTTP 401/403 responses hide cached private content, stop queries and remove the Manager snapshot.

Only UI fields are cached; arbitrary post/provider metadata is excluded. Local recording paths never enter the persisted remote query cache. Media entries contain ordered file metadata and URLs, not downloaded images or videos. Media bytes continue to use the webview and existing recording/file infrastructure. This is not an offline publishing queue.

Writes are serialized, debounced for 400 ms and flushed on blur/pagehide. Local catalog polls and unchanged fetch-state notifications do not rewrite the remote inventory. Cache storage failures do not erase last-known data or block live reads after initialization. Corrupt/expired/version-incompatible snapshots are discarded. Transient background errors keep known data across restarts; errors themselves are not restored as permanent UI errors.

## Verification

- `npm run build`: TypeScript and production bundle passed. Updated `bun.lock` also passed Bun's frozen lockfile check used by CI/releases.
- `npm run test:manager-cache`: real query-client/observer checks with mocked native IPC passed: duplicate reads, fresh return, stale content retention, cancelled-response races, offline persistence, navigation restore, workspace/credential isolation and expiry.
- `cargo test --lib cache::tests` in `src-tauri`: five SQLite tests passed: scope isolation, disconnect cascading, corruption/expiry, oversized-write preservation and database reopen.
- `scripts/manager-cache-browser.html` on the Vite dev server: browser regression passed with mocked API responses, checking warm return, scroll restoration, unit tabs, media reuse, refresh failure/recovery without shell replacement, access revocation/recovery and an explicit room recording target. No screenshots required.
- Read-only inspection of the running native preview confirmed both query and navigation rows in SQLite, including the five inventory resources.

The browser harness uses mock data and cannot publish. The native preview uses the real Rust cache commands and hosted API.

## Existing API limits

Current inventory routes still return complete arrays. This cache avoids repeated reads; a first uncached workspace load still retrieves the inventory. Cursor pagination and independent server totals would be a separate compatible API change. Comments load lazily from `/content/post/comments?social_post_id=…` for each published destination and render inside the unit tab. Each post has a separate persisted query key; a failed refresh retains its last known comments. The unit-comments endpoint currently returns only the first post's comments, so Producer uses the per-post endpoint to cover all destinations. Only comment display fields are cached; raw event payloads are excluded. This displays comments already held by Boomin; it does not trigger a platform import. Insights still derive from existing post information; additional metrics reads should use independent query keys.

## References

- [TanStack Query defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults)
- [Query persistence](https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient)
- [Tauri state management](https://v2.tauri.app/develop/state-management/)

Producer reuses its Rust `rusqlite` connection rather than adding a second database plugin.
