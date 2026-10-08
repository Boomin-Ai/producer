# Manager publishing in dev

## Room engine development

On macOS, run Vite (`npm run dev`) and then `npm run dev:room` for native room
checks. This launcher builds current Rust code and copies the installed engine
into `src-tauri/target/dev-room/Producer.app`, leaving `/Applications/Producer.app`
unchanged. The debug executable keeps Vite HMR. Close this dev app and rerun the
launcher after native changes. `PRODUCER_DEV_ENGINE_APP` can select another engine
app bundle. Never use this copied development bundle as a release artifact.

The bare `tauri dev` executable cannot initialize the required macOS browser
module. That makes `bootstrap_ok` false even when boot has finished. The room now
shows a failure message for that state instead of an indefinite warm-up message.
Bundled launch verified `ok: true`, no missing IDs, and no failed modules.

Idle room departure now calls `live_release_idle_room` on the engine thread.
It stops virtual-camera output, tears down Studio/room mixes, clears overlay and
camera/mic/screen/guest sources, and replaces thumbnail targets to release their
owned capture references. Running streams and recordings retain their sources.
No source-change event is emitted during unload, so saved room setup survives.
Restoration and release are serialized across mounts; stale listeners unsubscribe
even if subscription resolves after departure. Reopening restores the document.

Verification: native build and bundled boot, TypeScript/Vite build,
`node scripts/test-room-session.mjs`, preview lifecycle regression, and
`scripts/notice-hover-browser.html` in headless Chrome all pass. The notice pill
stays readable and stable on hover; full text lives in a wrapping portal, with a
native stage cutout marker. The physical camera indicator still needs the user's
open/leave check on the relaunched dev app.

## Publishing

Boomin New Post entry points in development now open the light Manager composer.
The global rail and Manager overview both use `PublishComposer`.

The composer uses the existing native `upload_media` and `submit_post` commands.
Submission enters the durable native outbox; acceptance does not mean the platform
has finished publishing. Channels are restricted to the active workspace and must
be selected explicitly. Local file paths remain in component state.

The existing quick-post contract supports one image or video, or a public HTTPS
media URL. It creates an unfiled unit for each channel submission. Existing-unit
publishing and grouping multiple destinations into one unit need the CMS action
contract; this change does not add that behavior.

The composer supports global captions, existing channel settings, and future
scheduling. It prevents duplicate clicks and locks after handoff, including an
uncertain result, so the user can inspect posting activity before trying again.

Verification: TypeScript/Vite build and the mocked native transport browser check
in `scripts/publish-composer-browser.html`. No real post was submitted by the test.
The user will test @kleveland in the running native dev app before release work.
Production routing, self-hosted routing, and Apple signing are unchanged.

## Existing draft edits

Hosted draft units now use the CMS `PATCH /v1/app/content/units/:id` writer.
Caption, collection assignment, destination selection and per-destination settings
are staged together and persisted by **Save draft**. The server response replaces
the unit in the workspace cache after stale reads are cancelled. Failed or denied
saves retain the editable draft and show an error rather than claiming success.
Published, scheduled, reviewing, processing and partially published units retain
their locks. Editing does not publish or schedule anything.

Custom caption editing preserves empty enabled fields and spaces while typing;
the CMS receives `caption_override` separately from destination presets. Unfiling
explicitly clears both collection aliases used by the existing CMS contract.
Workspace changes hide the previous session while the new cache opens.

Verification: `npm run build`, `npm run test:manager-cache`, and Chrome/WebKit
browser regressions for draft persistence, collection movement/unfiling, caption
overrides, destination presets, retry/permission failures, duplicate prevention,
stage locks, existing publishing composer and cached navigation. Run Vite, then
`npm run test:manager-ui` with Playwright installed (or `PLAYWRIGHT_MODULE` pointing
to its module). Browser tests mock the native transport and never post to social
accounts; the composer still uses its existing native outbox for real publishing.

Live verification on 2026-10-04: Kleveland’s empty Yo draft accepted a temporary
caption via PATCH; a fresh unit inventory GET returned that caption with its draft
stage and collection unchanged. The original empty caption was restored and
verified with another GET. No publish or schedule route was called.
