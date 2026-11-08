# Boomin network beta qualification

The first delivery is Boomin workspace to Boomin workspace. New beta installations enter through Boomin sign-in; existing self-hosted connections remain usable. Persistent local studios, federation and device-only hosting are later milestones in `PRODUCER-CONNECTION-ARCHITECTURE.md`.

## Two owners, one agreed application revision

Use issue [#131](https://github.com/Boomin-Ai/producer/issues/131) for the human-readable test ledger and [#133](https://github.com/Boomin-Ai/producer/issues/133) for agent-bridge setup. The relay wakes a separate restricted worker only for explicit handoff markers; ordinary comments and acknowledgments do not recursively start agents. The interactive owners retain control of apps, profiles, media, builds and releases.

Before a measured run, each owner records:

* Exact native source SHA, executable SHA-256, features, optimization profile, engine lock/artifact, app identifier and path. A checkout SHA alone does not identify an already installed executable.
* Exact frontend SHA and whether the working tree is clean. A live Vite frontend and a native binary may come from different commits; record both. Do not silently mix uncommitted changes into a frozen baseline.
* Selected workspace/room, orientation, resolution/FPS, Set and layout, active sources, network workload and output state. Source dimensions and admission/ON state are not fresh-media evidence.
* The current physical camera, moving pixels, microphone and speaker route. Keep unrelated recording, streaming and virtual-camera output off unless the named stage measures them.

Private CI artifacts are candidates, not native-runtime acceptance. A signed/notarized artifact still needs actual camera/audio/RTC verification. Reuse the existing isolated application identifier and profile; a signing/executable change can still cause macOS permission or Keychain prompts.

## Requested measurements and their limits

| Measurement | Actual evidence | Does not establish |
| --- | --- | --- |
| Existing SDK receiver | Whitelisted inbound RTC counters, decode progress, dimensions, track state, audio duration/energy and concealment deltas | Native OBS ingestion, selected Set binding, presented pixels, a known sound or physical speaker playback |
| Native engine snapshot | Render/FPS/CPU counters and source counts/dimensions | A camera producing new pixels or a guest making it into the audience mix |
| Passive OS sampler | Explicit PID and current descendants, per-platform CPU semantics, RSS sum, median/p95 and coverage | Unique physical memory, reparented WebKit services, cross-platform raw-CPU equivalence or end-to-end latency |
| Known-tone analyzer | A supplied, aligned, bounded PCM pattern matches its expected frequencies and silence | Playback/capture, network timing or audibility; the analyzer performs none of those actions |

Missing observations remain `null`, distinct from an observed zero. Counter resets, stale reports, replaced seats, expired authority and cancellation fence late results. Measurements stop on session replacement instead of silently following another participant. No observer drains the native program PCM queue, which belongs to the publisher.

## Opt-in developer tools

The receiver/engine driver is compiled away in production and installs only with `VITE_PRODUCER_NETWORK_DIAGNOSTICS=1` in exactly `ai.boomin.producer.sets-v2-dev` or `ai.boomin.producer.windows-network-dev`. Installation performs no join, capture, tone, recording, mixer change, export or measurement.

An explicit `window.__producerNetworkDiagnostics.run()` waits up to 15 seconds for an already live modern guest seat, then records at most 60 samples over 60 seconds. `cancel()` ends observation without leaving the actual seat. The existing local UI log stores sanitized samples. On the Mac, the existing dev report also stores the summary and last eight samples; Windows has no Mac-specific persistence call. This explicit local developer run does not enable fleet telemetry or change a user's sharing setting.

The Mac-only normal-UI pair driver additionally requires `VITE_PRODUCER_NATIVE_PAIR_PROOF=1`. Its `run()` accepts one bounded fixture:

```ts
{
  version: 1,
  workspace: {endpointId: '<local endpoint UUID>', brandSlug: 'kleveland'},
  localRoomId: '<existing local SQLite room UUID>',
  remoteRoomId: '<Windows Boomin room UUID>'
}
```

It verifies the active official Boomin workspace, local room ownership and idle stream/recording state, then clicks the normal visible Network Enter action once. It chooses the existing room and Set through the normal join form. Existing room-access checks, admission and capture authority remain in force. It waits for the live seat and delegates one passive run. It does not create a room, directly call a privileged join API or bypass the Windows host's admission.

For a specifically coordinated CLI-driven run, `VITE_PRODUCER_NATIVE_PAIR_RUN` may contain JSON `{version:1,runId:'<new UUID>',fixture:{...}}` alongside both flags. The separate launcher waits at most 30 seconds for the real visible UI. It consumes the nonce before any action and persists a bounded replay ledger. Reload, HMR, reopening, cancellation and failed starts cannot reuse an old nonce; a full/corrupt ledger fails closed. A new nonce is an intentional new attempt, not an automatic recovery strategy. Never leave a run fixture enabled for ordinary development or content creation.

Tests do not enable these flags or operate the installed apps:

```sh
bun run test:producer-network
bun run test:producer-network-diagnostics
bun run test:beta-onboarding-browser
```

The OS sampler is separate and never discovers or controls an app by name:

```sh
node scripts/network-performance-sample.mjs \
  --pid <verified-PID> --duration 60 --interval 2000 \
  --out <new-local-output.jsonl> --stage program-1080p60
```

It refuses to overwrite either trace or summary. Use a new stage/path per run. Keep these local unless the user explicitly chooses to share a sanitized trace.

## Real paired sequence still required

1. Both owners confirm responsive hosts, exact provenance, workload and no active stream/recording. Agree one appearance; Windows admits the Mac through normal controls.
2. Establish moving composed Set video and both audio directions. Separate decoder progress, native mix and actual playback checks. A pre-fader meter may move even when the audience mix is muted.
3. Measure the settled workload with the same inputs and no recording load. Use matched stages within each platform; do not claim a CPU improvement from an output-stopped sample versus an active room.
4. Keep the Mac guest open while Windows returns to cards and reopens the same room. Measure first fresh video/audio and automatic Set-source rebinding. Another knock, browser refresh or manual source replacement invalidates an automatic-recovery pass.
5. Run short, explicitly authorized known-tone/mute tests separately. Verify the pattern at a qualified PCM/mix or test-recording observation point, verify its absence during mute, then restore prior gain/mute state on success, failure or cancellation. Physical speaker audibility remains a separate check. A pure pattern unit test or SDK energy counter cannot substitute for this run.

At this implementation stage the passive/UI tooling exists and is tested. Full native ingest/presentation/mixer probes and actual paired tone/recovery/performance results must be recorded independently; their coverage must not be inferred from these controlled tests.
