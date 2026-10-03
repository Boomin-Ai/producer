# Producer live status on brand profiles

The Stream button supplies its connected Boomin endpoint and server room ID to the native `live_go_live` command. After enqueueing the engine start, a native reporter tracks the engine snapshot independently of the room screen.

A show becomes live only when the session is streaming and at least one destination is live, active, and has sent bytes. Failed starts, recording alone, an open studio, and all-destination reconnecting states do not count. This confirms RTMP transport, not the destination platform's public broadcast approval.

The reporter renews a session-scoped backend lease about every ten seconds. Stop ends it; the next healthy reconnect creates a fresh interval. Losing the app or API connection expires the lease within 45 seconds. Backend host authorization, room visibility, session tombstones and conditional updates protect tenant isolation and delayed/reordered requests. The existing web-studio broadcast path remains supported.

Backend PR: https://github.com/Boomin-Ai/api/pull/425
API checkout: `.codex-work/boomin-api-live-status` (isolated from unrelated API work).
Desktop preview: `src-tauri/target/live-status-preview/Producer.app` — standalone debug build with embedded frontend, installed engine frameworks and verified local signing. This includes the current workspace's existing desktop work and is not a new public Producer release.

Validation: API typecheck and 933 unit tests; 15 real isolated database/HTTP checks; Producer frontend build, native engine compile, and engine-backed reporter state tests. The desktop preview's signature and libobs linkage are verified. No public stream is started by these checks. Actual destination broadcasting and iPhone profile observation still require a live stream from the updated desktop build.

API merge: `09fe6d76f3abc545874347821f40b5ad07f44dc4`.
Release: https://github.com/Boomin-Ai/api/actions/runs/37031826296

The preview uses the available Apple Development certificate. Its local signing entitlements include camera/audio access and development library loading; distribution-only system-extension installation and app-group entitlements are omitted from the preview bundle. Production signing configuration is unchanged. The original installed app is retained.
