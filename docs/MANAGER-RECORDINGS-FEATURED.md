# Room recordings and featured units — September 28, 2026

## Product behavior

- The bottom sidebar `+` offers New series and New featured unit. No collection-kind badges or labels appear in the sidebar.
- A featured entry creates one unit and opens it directly. The database prevents a second unit, including concurrent writers.
- Finishing a room recording opens a playback panel. Last take reopens it; Show file reveals the original.
- A durable local catalog captures the room and workspace when recording starts. Completed captures appear in Manager, grouped by room, even before registration succeeds.
- Registration sends provenance only. Files stay on the recording device; this work does not upload, publish, or transcribe them.
- Recording units start at `studio` (In production), use `long-video`, and do not populate Drafts automatically.
- Existing carousel distribution files remain separate from unit parts. Clips remain hidden.

## Hosted schema and endpoints

Boomin API migration `drizzle/0162_manager_capture_and_featured.sql` adds featured/recordings collection kinds, retry keys, the featured singleton guard, and `content_recordings`.

Migration 0162 was applied to the main database in project `flat-recipe-24914469` and recorded in `schema_migrations`. Existing collection counts were checked unchanged. The rehearsal branch was removed after SQL checks.

API PR: https://github.com/Boomin-Ai/api/pull/407

- `POST /v1/app/content/library`: editor-only, creates a series or featured entry with a stable request UUID.
- `POST /v1/app/content/recordings`: editor-only, retry-safe metadata registration.
- `GET /v1/app/content/recordings`: brand and folder visibility scoped.

The PR contains only this work and its generated infrastructure map. The unrelated local `src/routes/app/producer.ts` edit is excluded. The user approved merging #407 and deploying production. PR CI passed; the merge is `774cb6494147a1b3c774a2ab7258c39c86805824`. Deployment run https://github.com/Boomin-Ai/api/actions/runs/36448022288 completed successfully, including migrations, Worker deployment, fixture seeding, route-mount smoke, and deployed API smoke. Hosted endpoints are live. Direct unauthenticated probes returned 401 for recording reads and 400 for invalid empty creation requests. A 404 on the new read route still leaves older independent hosts' existing Manager inventory usable.

## Verification

- Producer frontend build passed.
- Rust catalog tests: 2 passed (finished capture identity and interrupted-capture recovery).
- Rust check and native preview build passed using the installed Producer recording engine.
- Native preview started at localhost:1420 with libobs and the recording encoders loaded. Browser-source CEF is unavailable in this development layout; recording/FFmpeg modules loaded.
- API typecheck and Worker dry-run passed.
- API test suite: 77 files, 872 tests passed. Infrastructure map regenerated for CI.
- Rehearsal SQL checked retries, mismatched requests, second-unit rejection, kind conversion, concurrent insertion, and duplicate capture registration.
- A real camera recording and authenticated hosted creation have not been exercised by the agent.

## Boundaries

The new Manager is still enabled through the existing dev preview. The room playback panel is available in the regular room code. Independent endpoints keep their local recordings without redirecting to Boomin. Existing content remains view-only in the Manager integration; legacy quick-post publishing remains intact.
