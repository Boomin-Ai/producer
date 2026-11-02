# Fresh agent-authored Set acceptance — 2026-11-01

Three new designs were authored from recorded prompts and generated through the
actual MCP SDK stdio transport. These are fresh plans, rather than round trips of
existing Sets. MCP compiled, validated, checked and previewed every package. The
agent authored the plans; MCP did not make another paid model call. This is a
small acceptance sample, not a measured natural-language success rate.

| Set | Logical views | Layouts | Browser review | Isolated native output |
| --- | ---: | ---: | --- | --- |
| Prompt proof · Five AI offers | 5 | 10 | Passed | Passed |
| Prompt proof · Weather desk | 1 | 2 | Passed | Passed |
| Prompt proof · Reactive 3D studio | 1 | 2 | Passed | Passed |

All packages have explicit landscape/portrait pairs, a shared Host source slot,
editable content and consolidated host layout controls. The CTA Set offers five
compositions; its PDF offer does not generate an actual PDF. Weather uses a
portable `data.weather@1` requirement and an explicit unconfigured state. The
studio combines a managed 3D world, moving portals, a voice ring, blur and an
authored opacity animation. No embedded media or private connection is required.

## Evidence

- All 14 MCP visual checks returned no findings. All 14 actual browser previews
  rendered without page errors; both 3D previews obtained a ready WebGL canvas.
  Screenshots were reviewed in both orientations.
- All 14 lowered plans rendered through the app's Rust RoomProgram, libobs,
  Metal and CEF paths with a synthetic live source. Each layout prepared two
  retained entries, survived repeated cached takes, rejected a stale modified
  plan and released native group/source ownership.
- Both native 3D orientations loaded consecutively after the startup fix.
  Observed first readiness was approximately 791 ms landscape / 912 ms portrait
  in this single diagnostic run; these are not latency guarantees.
- The 3D native probe verifies changing scenery, then pauses its clock to isolate
  synthetic audio. Loud input changed over 100,000 pixels per orientation;
  silence returned to the reference with zero remaining changed pixels. No
  physical microphone was captured.
- The new weather package passed recipient setup with simulated provider IPC:
  import without a connection, add/test/bind an owned connection, no connection
  ID in the export, stale revision refusal and reconnection.
- Browser routing/recovery tests exercised the new CTA document's first two
  offers, explicit opaque layout IDs, content edits, portrait failure retaining
  both outputs, retry and landscape-only mode. The separate native paired-take
  primitive passed ready/stale gates, repeated transitions and cleanup. This is
  not a simultaneous resource-budget test of both full 3D compositions.

Local evidence is under `target/prompt-acceptance/`: `results.json` records MCP
revisions and paths; `staged.json` records dev library copies; `browser-review.json`
records preview results; each `native-*` directory contains native receipts and
pixel captures. The generated `.set.json` files and HTML previews are in
`~/Documents/Producer Sets`. The three named Sets were also copied into the
Sets v2 dev library without changing existing Sets or taking the user's output.

## Bugs found by this exercise

**Truncated native 3D renderer download.** CEF reported
`ERR_CONTENT_LENGTH_MISMATCH` for `renderer.js`; a subsequent orientation never
reached its first frame. On macOS an accepted socket could inherit the listener's
nonblocking flag. `write_all` then stopped when its send buffer filled, while the
response advertised the complete script size. Connection workers now explicitly
use blocking IO with the existing timeouts and connection bounds. A socket-level
regression forces nonblocking mode and delayed client reads; it failed with the
old code and passed with the fix. Both authored 3D orientations then passed in
one native process. The test harness now observes the runtime's existing 60-second
cold-3D deadline rather than applying its 14-second media wait to WebGL.

**Compact text preview/output disagreement.** Compact plans omitted whitespace
and line-height defaults, so browser previews collapsed explicit newlines while
native graphics preserved them. Compiled text now declares `pre-wrap` and `1.15`
line height. A two-line clipping case verifies both orientations. The CTA package
was regenerated through MCP and checked again after this correction.

## Boundaries and remaining gates

The native startup patch was compiled into the isolated acceptance executable.
After this exercise, native dev was rebuilt from `fdf4e9e`, signed and relaunched
under `ai.boomin.producer.sets-v2-dev`. The pinned Metal backend was included and
the local workspace refreshed. Signature, process and visible-window checks
passed; the receipt is `target/native-rebuild/receipt.json`. The existing test
camera still reports no ready frame. Production was not rebuilt or deployed.

These three packages have not been recorded with physical camera/microphone
devices. The existing dev room's acceptance camera had no ready frame. The native
authoring harness strips the projection timeline, so this run does not certify
the glass opacity track, arbitrary animation states, simultaneous retained 3D
budgets, all renderer features, real weather delivery or a saved-Claude provider
request. No recording, stream, provider charge or production output was started.

Next gate: run physical capture and paired recording acceptance for these exact
package revisions in the refreshed dev app. Expand the prompt corpus and repair evaluation before
claiming broad generation reliability.
