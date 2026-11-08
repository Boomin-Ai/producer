# Boomin network beta qualification

The first delivery is Boomin workspace to Boomin workspace. New beta installations enter through Boomin sign-in; existing self-hosted connections remain usable. Persistent local studios, federation and device-only hosting are later milestones in `PRODUCER-CONNECTION-ARCHITECTURE.md`.

## Launch focus: measured media latency and reliable recovery

The launch priority is sustained Boomin-to-Boomin polish. Keep the currently working pair stable while preparing changes in a separate checkout. Optimize for responsive conversation, clean audio, synchronized video and reliable Set recovery together. LiveKit supplies the media transport; it does not remove Producer's capture, scheduling, conversion, rendering or playback delays.

Measure these separately:

| Timing | Start and end | Required distinction |
| --- | --- | --- |
| Entry | User's room/Join action to usable media | Separate room authorization, native device readiness, Set preparation, capture, SDK loading, connection and publication. |
| Steady media | Source audio/video event to receiver speaker/presented frame | Receiver counters and RTT are partial observations. A valid one-way result needs an actual matched source/output observation and a clock-alignment bound or one common recording clock. |
| Recovery | Host availability restored to fresh media on the retained guest | Report host downtime separately. A reconnect span ending or a track becoming available does not prove the first decoded/presented frame. |

Current code audit identifies tuning candidates, not measured end-to-end results:

* Native host program publication schedules audio and video against captured timestamps plus a 400 ms lead (`rtc_program.rs`). The actual remaining wait depends on callback age. OBS's configured 200 ms fixed mixer buffering consumes part of that timestamp-relative budget; adding 200 and 400 as independent delays would double-count it. This protects scheduling and synchronization; reducing it requires measured capture age, queue occupancy, audio underruns/concealment, dropped video and lip-sync under load.
* Native guest receive uses a 120 ms presentation schedule (`crates/guest-runtime/src/media.rs`) and the OBS ingest source has a local render-clock offset of approximately 60 ms (`guest_ingest.c`). Validate these against the SDK pull timeline and OBS output/monitor clocks before assigning a combined physical-speaker delay. Async OBS video caching is another timestamp-aware stage; cache capacity is not its occupied delay.
* The guest program bridge redraws a 960×540 canvas at a nominal 20 fps, swapping dimensions for portrait (`programCapture.ts`). Each loop does draw/IPC work and then waits 50 ms, so its actual cadence also includes that work; this is not a measured fixed added delay. Portrait also has a JPEG read/decode stage. Higher FPS can increase CPU, GPU and bandwidth; measure the whole path.
* The browser audio worklet has a 9,600-frame high-water bound at 48 kHz, approximately 200 ms. That is a backlog/drop limit, not a deliberate 200 ms prefill or an observed steady delay. Preserve the single native PCM-drain owner.
* Receiver jitter-buffer, target/minimum-buffer, video decode and video processing statistics are optional browser observations. Derive interval averages from matching counter deltas with positive denominators; unsupported or stale observations remain unknown. Their summary distributions describe sampled interval averages, not per-frame/packet latency percentiles. Processing includes some other stages, so these metrics must not be added together as independent latency components. See the [W3C statistics definitions](https://www.w3.org/TR/webrtc-stats/).

Use the existing general LiveKit Cloud endpoint while verifying actual routing; do not assume region pinning lowers latency. LiveKit normally chooses the closest available edge. Playout/jitter changes require client-version support and a loss/jitter test, rather than globally removing buffering. See [regions](https://docs.livekit.io/deploy/admin/regions/) and [low-latency trade-offs](https://docs.livekit.io/robotics/media/performance/low-latency/).

The next comparison needs agreed native/frontend provenance on both machines, both appearance directions, fixed resolution/FPS/Set/source/device routes, and separate cold/warm and steady stages. Establish median/p95 with repeat counts and missing coverage, then change one measured bottleneck at a time. Include a complex Set, multiple guests, muted/unmuted audio, foreground/background behavior and host reopen. Reduced delay is acceptable only alongside preserved audio continuity, source framing/binding, synchronization and recovery. Preserve the current known-good configuration for comparison.

## Two owners, one agreed application revision

Use issue [#131](https://github.com/Boomin-Ai/producer/issues/131) for the human-readable test ledger and [#133](https://github.com/Boomin-Ai/producer/issues/133) for agent-bridge setup. The relay wakes a separate restricted worker only for explicit handoff markers; ordinary comments and acknowledgments do not recursively start agents. The interactive owners retain control of apps, profiles, media, builds and releases.

Before a measured run, each owner records:

* Exact native source SHA, executable SHA-256, features, optimization profile, engine lock/artifact, app identifier and path. A checkout SHA alone does not identify an already installed executable.
* Exact frontend SHA and whether the working tree is clean. A live Vite frontend and a native binary may come from different commits; record both. Do not silently mix uncommitted changes into a frozen baseline.
* Selected workspace/room, orientation, resolution/FPS, Set and layout, active sources, network workload and output state. Source dimensions and admission/ON state are not fresh-media evidence.
* The current physical camera, moving pixels, microphone and speaker route. Keep unrelated recording, streaming and virtual-camera output off unless the named stage measures them.

Unreleased CI artifacts are candidates, not native-runtime acceptance. On this public repository, Actions artifacts are not collaborator-private; include no customer profiles or credentials. A signed/notarized artifact still needs actual camera/audio/RTC verification. Reuse the existing isolated application identifier and profile; a signing/executable change can still cause macOS permission or Keychain prompts.

## Requested measurements and their limits

| Measurement | Actual evidence | Does not establish |
| --- | --- | --- |
| Existing SDK receiver | Whitelisted inbound RTC counters, decode progress, optional interval jitter-buffer/target/minimum/video-processing averages, dimensions, track state, audio duration/energy and concealment deltas | End-to-end latency, native OBS ingestion, selected Set binding, presented pixels, a known sound or physical speaker playback |
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

The offline sound verifier can prepare a deterministic 1.3-second, ramped, low-level three-tone fixture and later inspect a supplied completed PCM16 WAV. Neither command plays, records or controls an app:

```sh
node scripts/network-tone-proof.mjs generate /absolute/new-test-tone.wav
node scripts/network-tone-proof.mjs probe /absolute/completed-recording-copy.wav
```

Generation refuses overwrite. Probe accepts bounded mono/stereo PCM16 WAVs, searches their initial offset, and reports `matched`, `no_match`, `insufficient` or `unsupported`. Compressed/float containers need a separate local PCM16 copy; keep the original recording. Search work, file size and duration are bounded. A match proves only that the supplied samples contain the expected tone/silence sequence. The recording-relative offset is not network latency. This tool does not perform the actual tone transmission, native mute check or speaker check.

## Real paired acceptance sequence

1. Both owners confirm responsive hosts, exact provenance, workload and no active stream/recording. Agree one appearance; Windows admits the Mac through normal controls.
2. Establish moving composed Set video and both audio directions. Separate decoder progress, native mix and actual playback checks. A pre-fader meter may move even when the audience mix is muted.
3. Measure the settled workload with the same inputs and no recording load. Use matched stages within each platform; do not claim a CPU improvement from an output-stopped sample versus an active room.
4. Keep the Mac guest open while Windows returns to cards and reopens the same room. Measure first fresh video/audio and automatic Set-source rebinding. Another knock, browser refresh or manual source replacement invalidates an automatic-recovery pass.
5. Run short, explicitly authorized known-tone/mute tests separately. Verify the pattern at a qualified PCM/mix or test-recording observation point, verify its absence during mute, then restore prior gain/mute state on success, failure or cancellation. Physical speaker audibility remains a separate check. A pure pattern unit test or SDK energy counter cannot substitute for this run.

At this implementation stage the passive/UI tooling exists and is tested. Full native ingest/presentation/mixer probes and actual paired tone/recovery/performance results must be recorded independently; their coverage must not be inferred from these controlled tests.
