# Camera filter persistence

Confirmed in v0.4.68: the filter editor only called the native filter command. Room source documents carried source specs and scene geometry but no filter chain. Leaving an idle room releases its sources; recreating a camera therefore discarded its filters.

The fix stores each successful filter edit in the room's source entry, including settings, enabled state and chain order. Rapid edits run in order through native mutation and database saving. The room lifecycle waits for an active edit/save before releasing capture. Lists do not overwrite the saved chain; explicit removal saves an empty list. Save errors appear in the filter editor.

Native room restoration attaches the saved chain while its source is hidden, before the opening scene becomes visible. Replacing a device/source also preserves its current user chain. Internal transition filters are excluded. A filter restoration failure warns and keeps the affected source off output rather than exposing an unfiltered camera. Older rooms without saved chains still load.

Validation: 18 targeted document/race/migration tests, native source/filter recreation through an isolated SQLite round-trip, source replacement and unsupported-filter handling, existing scene restoration and room lifecycle checks, frontend build and native build. The native fixture uses a color source instead of a real camera; it uses the actual libobs filter chain and does not modify user room data. Released in Producer v0.4.69. The Apple Silicon app and installer passed Developer ID signature, Apple notarization and staple checks.

Native reproduction check:

```sh
PRODUCER_ENGINE_DIR=/Applications/Producer.app/Contents \
PRODUCER_ENGINE_PLUGINS=/Applications/Producer.app/Contents/PlugIns \
DYLD_LIBRARY_PATH=/Applications/Producer.app/Contents/Frameworks \
DYLD_FRAMEWORK_PATH=/Applications/Producer.app/Contents/Frameworks \
cargo test --manifest-path src-tauri/Cargo.toml \
  native_source_filters_survive_room_reopen_and_device_replace \
  -- --ignored --test-threads=1 --nocapture
```
