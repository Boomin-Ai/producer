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
