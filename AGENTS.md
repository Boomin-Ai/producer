# Shared Producer build requirements

Read `docs/MACOS-BUILDS.md` before changing Mac setup, native features,
packaging, signing, installers or releases. These requirements apply to both
Intel and Apple Silicon. Use `make setup`, then `make check` and `make dev` for
the bundled native development path. `bun run dev` is frontend-only;
`tauri dev` without an engine is not a live/camera qualification build.

- Supported production Mac builds must include a matching native live engine,
  browser/CEF helpers, recording muxer, and Producer's camera plugin/provider.
  Set `PRODUCER_REQUIRE_ENGINE=1` before Rust compilation and run the engine
  preflight. Do not silently ship an engine-less Intel replacement.
- Keep `guest-rtc-production` in production Mac builds. The initial Intel
  camera-only candidate did not qualify native guest RTC, audio, recording,
  streaming, Metal, or performance. A compile pass is not physical media proof.
- Keep the existing engine lock and all architecture-specific checksums.
  Do not substitute arm64 binaries into an x86_64 bundle or change the global
  lock simply to rename a local engine. Respect the current Silicon source path.
- A new virtual-camera installation needs Developer ID signing, the matching
  provisioning profile, camera/install entitlements, notarization Accepted,
  and normal macOS extension approval from an app in `/Applications`.
  Never bypass OS protections or claim ad-hoc signing can install it.
- Gate installer/updater publication on complete dependency closure, no Qt,
  native architecture, deep/strict signatures, camera UUID/profile pairing,
  accepted notarization, stapled/validated tickets and updater signatures.
  Use the shared bounded transient Apple-ticket retry functions; fail on
  signature/policy errors. Preserve accepted artifacts if delivery fails.
- Read GitHub issue #131 and recent comments before shared release/native
  changes. Explicit bridge markers wake separate restricted workers, not the
  interactive owner. Coordinate file ownership and source/version adoption.
  Do not cancel a parallel release, overwrite a published version, change an
  active app/profile, or merge shared work based only on a bridge ACK.
  A combined production release must use one agreed source and one publisher.
- Record source SHA, engine lock/hash, architecture, native features,
  optimization profile and actual media checks separately. Keep secrets,
  customer profiles and private recordings out of commits, issues and artifacts.
