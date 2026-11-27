# Producer owned media engine plan

Planning snapshot: **19 November 2026**. This directory preserves the next architecture and delivery plan independently of one developer's Mac. It does not change or release the application.

Start with [the interactive HTML blueprint](producer-owned-media-plan.html). Download it and open it in a browser; GitHub's source viewer does not execute HTML. It has no external runtime dependencies and works offline. For reading without browser scripting, use [the PDF](producer-owned-media-plan.pdf).

Other entry points:

- [Follow-up decisions](DECISIONS.md): moderator control, self-hosted LiveKit, native graphics, documents and headless/embedded Boomin integrations.
- [Resume on a clean machine](RESUME.md): exact source checkpoint, scope, recovery and the first implementation steps.
- [Source fingerprints](source-audit.json): 26 inspected files, their hashes and the original source base.
- [HTML verification](verification.json): interactions, dark/light mode, responsive widths and print coverage.
- Screenshots: [dark](plan-dark.png), [light](plan-light.png), [architecture](plan-architecture.png), [mobile](plan-mobile.png).

## Direction

Producer is a live media production and distribution harness. The target is a Rust-owned media/production engine with a GPUI desktop client, independent of libOBS and browser-based Set rendering. Boomin remains the collaborative brand network and authorization service, not a model provider or the local production clock.

Keep the existing typed production document, exact time, components, commands, resource ownership and incremental compilation. Complete native media boundaries before building the next full Set/Show experience. Reuse LiveKit/libwebrtc, operating-system capture, codec libraries and hardware encoders through qualified adapters.

The product goal is protected low-latency guest conversation while expressive Sets, audience interactions, recording, distribution and editing of committed footage operate alongside it. Native access is an implementation opportunity, not an established end-to-end speedup.

## Delivery sequence

| Phase | Deliverable | Exit evidence |
| --- | --- | --- |
| P0 | Freeze media identity, clock, audio routing, permission and lifetime contracts; baseline pinned native SDK | Named reference workload, reproducible measurements, declared budgets, early Windows interop result |
| P1 | One real guest with owned audio/video sinks | Two-way audio, local camera/mic, paired recording, independent editorial seek, host/guest recovery |
| P2 | Four guests and adversarial recovery | Device/network churn, speakerphone/AEC, fresh authority, no stale media or duplicate playback |
| P3 | Reusable native Set/Show engine and controls | Classic's eight paired layouts, then Pilot, real component actions and interaction projections |
| P4 | Complete output and footage services | Streaming, Clips, virtual camera, durable takes, export and Studio, qualified separately |
| P5 | Complete native room and authoring workflows | Sources, Scenes, mixer, People, chat, Assistant, Clips and timeline using the public command contract |
| P6 | Qualified beta and distribution | Endurance, actual supported-platform matrix, migration, signed/notarized installers, updater and rollback |

Output research and platform interop spikes can overlap earlier phases. These are dependency gates, not calendar estimates. Mac is first for a complete end-to-end experience; Windows, Intel and Linux do not inherit qualification from a Mac result.

## What is preserved, and what is not

This plan PR contains documentation, a self-contained visual artifact, its PDF/screenshots and verification. Its source base is `f33fc0aa2635c1abab5e15bed35cd425d4cd88a7`, but the reviewed native prototype also had modified and untracked files. HEAD alone cannot reproduce that prototype.

The native/core prototype is backed up separately at **[`574acac4aef12f61b9ac27aa640b4c3f62a05e29`](https://github.com/Boomin-Ai/producer/commit/574acac4aef12f61b9ac27aa640b4c3f62a05e29)** on [checkpoint/native-gpui-2026-11-19](https://github.com/Boomin-Ai/producer/tree/checkpoint/native-gpui-2026-11-19). Its remote commit and complete Git tree were verified. The checkpoint is not merged or released. See [recovery instructions](RESUME.md).

Production remains at its existing release; this plan does not merge the prototype, change the license, deploy a backend, publish installers or demonstrate cross-platform media readiness. Historical measurements retain their original scope. No fresh media benchmark was run for the plan.

Credentials, personal recordings, user profiles, signing keys and local application libraries are not included. They need a separate private backup before a device wipe.

## Run or verify the plan

No build is needed to read the HTML. To serve it locally from this directory:

```sh
python3 -m http.server 8747 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8747/producer-owned-media-plan.html`.

The optional verification script requires Node.js 22+, `playwright-core` 1.56.1 and an installed Chrome. It does not run or modify Producer. Install the test dependency in a temporary directory rather than the application:

```sh
npm install --prefix /tmp/producer-plan-qa --no-audit --no-fund playwright-core@1.56.1
PLAYWRIGHT_MODULE=/tmp/producer-plan-qa/node_modules/playwright-core \
  PLAN_OUTPUT_DIR=/tmp/producer-plan-artifacts \
  node verify-plan.cjs
```

Set `CHROME_PATH` if Chrome is not in its standard installation. Generated screenshots/PDF/verification go to `PLAN_OUTPUT_DIR`; the checked-in HTML is read-only during this check.
