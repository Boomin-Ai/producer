# Producer v0.4.50

## Included

- Hosted Manager with real Boomin collections, units, posts, insights and comments.
- Native new-post publishing using the tested upload and durable outbox path.
- Series/featured unit creation, collection title editing and recording access.
- Workspace/session-scoped persistent cache and explicit refresh.
- Storage reporting for hosted media and local app data/recordings.
- Permanent imported-media previews and original restoration when Instagram
  omits historical originals; the supporting API fixes are already deployed.
- Room preview ordering, capture release on idle departure, and readable toast
  hover cards. Streams and recordings keep their capture while active.

Existing hosted inventory remains view-only where edit actions are not wired.
Publishing supports the current single image/video or public-media-URL contract.
Independent endpoints use their existing UI and publishing contract.

## Evidence

The user published to @kleveland successfully and confirmed room fixes worked.
Production archive audit: 72 posts linked to 72 units, 68 completed original
archives and four permanent preview-only posters. The 67 unaffected archives
match their baseline; all five targeted repairs completed.

Frontend build, cache/navigation/isolation tests, preview/room lifecycle tests,
browser composer/restoration/hover checks, native build and engine boot pass.
The exact release checkout is checked by CI on Linux, Windows and macOS.

## Release path

Use the existing release.yml workflow from the v0.4.49 successful release
run 36096056682. Consume the current obs.lock engine artifact by hash, assemble
and sign nested code, verify dependency closure and camera provisioning, submit
app and DMG to Apple, staple tickets and verify Gatekeeper, then publish the DMG
and signed updater manifest. Do not distribute the copied development bundle.
