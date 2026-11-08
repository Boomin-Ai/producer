# Shared Mac build contract

Every production Mac release must provide the live engine on both CPU targets.
The old Intel engine-less path is retired by the dedicated Intel release job.
Linux remains a separate engine-less platform. Do not infer support from the
frontend version or from an app opening successfully.

| Requirement | Apple Silicon | Intel |
| --- | --- | --- |
| Native runner/target | arm64 / aarch64-apple-darwin | x86_64 / x86_64-apple-darwin |
| Engine | Exact current source-built CI artifact | Checksum-pinned Intel OBS runtime plus Producer browser/camera builds |
| Graphics acceptance | Existing Metal qualification | Physical OpenGL/x264 camera and virtual-output check; Metal unqualified |
| Camera binaries | arm64 | x86_64 |
| Production native guests | guest-rtc-production | guest-rtc-production; production build must pass |
| Updater archive | Producer_VERSION_aarch64.app.tar.gz | Producer_x64.app.tar.gz (existing updater alias) |

Both paths require the same real `.app` topology, CEF/helper apps, plugin
allowlist, recording muxer, dependency closure, Developer ID identity,
camera provisioning profile, hardened runtime/capture/install entitlements,
camera UUID pairing, notarization and signed updater payloads. Preserve both
the active camera provider and the removal-only retired-provider helper.
Intel's minimum supported macOS in the new package is 13.0.

## Local setup

Install Bun >=1.3, stable Rust and Command Line Tools first. Run:

```sh
make setup
make check
make dev
```

Setup reuses only the exact lock/architecture artifact after component and
architecture validation. Silicon fetches the source-built CI artifact; Intel
uses `engine/macos-intel-fallback.json`, checked against `engine/obs.lock`.
No engine source rebuild is needed for ordinary frontend edits. If a sandbox
cannot mount the verified Intel DMG, mount it in Finder and pass
`PRODUCER_OBS_CONTENTS=/Volumes/<image>/OBS.app/Contents` to setup.
Compiler caches stay in the checkout. Keep one capture owner per profile;
do not run a production app and a development app against its profile at once.
For isolated Network frontend testing, preserve the existing Network dev
identity/profile and its separate frontend checkout instead of relaunching it.

`PRODUCER_REQUIRE_ENGINE=1` makes a missing engine a compile failure. The
preflight also checks CEF, all four helpers, the plugin allowlist, muxer and
camera-provider architecture before building. An ad-hoc local app can test
the engine but cannot install the system extension; use a properly signed
candidate for that acceptance step.

## Publication and concurrent work

Issue #131 is the shared owner/source log and #133 describes the bridge.
An explicit `[BRIDGE TO MAC]` or `[BRIDGE TO WINDOWS]` handoff has a bounded
task/source/file scope. Its ACK is a worker report, not permission to publish
or evidence that the interactive owner adopted a revision.

The Silicon owner started 0.4.89 at e5bba7e while Intel work was separate.
Do not modify that run's source, cancel it, replace its assets or retag it.
Integrate into current main, obtain exact-source green CI and qualified Mac
jobs, and coordinate a fresh version for the combined production release.
The single release publisher waits for Linux, Windows, Silicon **and Intel**
and verifies all updater bytes before changing the shared manifest.

Use `scripts/notarize-macos-artifact.sh` for accepted app/installer submissions.
It retries only known transient Apple ticket errors with fixed bounded
delays, and separately staples and validates unchanged accepted bytes.
Signature failures and unclassified errors fail closed. An Accepted result
alone does not prove that an offline ticket was attached. Preserve accepted
candidate bytes and sanitized status so a delivery outage does not require
recompiling the native app.

## Physical evidence

The caca7a9 Intel development candidate was signed/provisioned and Apple
notarization returned Accepted. The user confirmed camera input; enabling its
system extension through normal macOS settings let Photo Booth display live
Producer Virtual Camera video. Engine startup had no missing IDs or failed
modules, using OpenGL/x264. The Metal attempt fell back after 64.8 seconds.
That candidate lacked native guest RTC; audio, recording, streaming and Metal
were not qualified by this camera test. New production candidates must build
with the production native guest feature and report their own acceptance.
