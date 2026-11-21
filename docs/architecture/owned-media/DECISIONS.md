# Follow-up architecture decisions

Recorded 19 November 2026 after the visual blueprint. This document preserves the subsequent discussion; capability proposals below are not claims that the native beta implements them. Read it with the [blueprint](producer-owned-media-plan.html) and [resume instructions](RESUME.md).

## Native engine, reusable dependencies

The selected target is GPUI for the desktop and a Producer-owned Rust production/media runtime. The target native beta does not depend on libOBS or a JavaScript/Three.js Set runtime. Production still uses its existing engine until a qualified cutover; do not remove its dependencies from a release because the prototype works.

Use mature transport, codec and platform libraries where useful. Owning the engine means owning scheduling, buffering policy, resource lifetime, composition, audio routing and recovery. It does not require writing WebRTC, a codec or every hardware driver.

Mac is the first complete application target. Keep Windows and Linux behind the same narrow media/GPU contracts, and investigate Windows interop early. Separate physical Intel, Windows and Linux qualification remains mandatory for any advertised support.

## One production foundation

- **Room:** production resources, live sources, output dimensions, routing, permissions and workspace context.
- **Scene:** a prepared composition using stable sources and explicit routes; switching pictures does not automatically disconnect guests or silence every off-camera microphone.
- **Set:** reusable visual components, layouts, theme tokens and designed controls; it works without a Show.
- **Show:** a rundown referencing layouts, sequences and supported cues, with run and segment-occurrence identities.
- **Timeline:** timed uses of sources, assets and components, including nested compositions and motion. It is not another device owner.
- **Workspace:** operator panel/dock arrangement, selection and navigation. Rearranging a panel does not recompile the production graph.

Live output time remains continuous. Editorial seek is a separate transport. Program recordings are flattened pictures/audio; selected original takes retain source material for editing. A live source is not an asset, and a recorded asset is not automatically an independently controlled player.

## Guests and participation across destinations

Creators should be able to author guest matchups, timed turns, votes, scores, reveals, games and reactive graphics as reusable production components and Shows. They can distribute the resulting program through supported broadcasting destinations.

The outgoing audiovisual experience travels with the program. Participation does not automatically travel backward from every destination: comments, votes, purchases and moderation require supported APIs, an authorized Boomin participation surface, or another explicitly integrated service.

Guest conversation, synchronized program audio/video, operator monitoring and private communication are separate routes. Visual layout membership does not implicitly decide whether an admitted onstage guest remains audible. Recipient self-return exclusion and physical acoustic echo cancellation are distinct requirements.

## Moderator control and authority

Existing host/moderator grants, scoped control seats and server interaction authority are a starting point. Preserve those semantics while wiring native execution. A control-only moderator seat must not silently gain camera/audio publication or private monitoring access.

UI, CLI, MCP, Assistant and moderator controls invoke the same typed operations. Validate authority, expected document/revision and run/occurrence epochs; the current host executes accepted commands. Expose pending/applied/failed/conflict receipts. Qualify concurrent moderators, revoked grants, host reopen and stale command rejection.

No network callback, render completion or media-health signal can restore revoked permissions or renew a host lease.

## Self-hosted LiveKit and later federation

Keep transport endpoint and session credentials behind a provider boundary so a qualified self-hosted LiveKit deployment can be supported later. Current `guest-session` validation admits the expected LiveKit Cloud endpoint only; self-hosting is not currently enabled by this plan.

Implement trusted endpoint policy, server-side credential issuance, TLS/connectivity/TURN and the same media/recovery qualification. Do not enable self-hosting by removing endpoint validation or exposing signing secrets on a client.

Boomin can remain the identity/collaboration/control authority while an owned LiveKit deployment carries media. Owned-server-to-Boomin and server-to-server federation require additional trust/identity rules; they are not equivalent to replacing an SFU URL. New beta users use Boomin sign-in while later independent-hosting boundaries remain possible.

## Native graphics, motion and live video textures

Live camera, screen, file and guest frames can be sampled as video textures by the compositor. This permits native crop/mask/alpha, transforms, shadows, motion and admitted material/effect families without a browser Set renderer. GPU handle interoperability and frame lifetime still need proof on each platform.

The current native specimen has a narrow 2D vocabulary: video, cached text, gradients, alpha, rounded boundaries, borders, grain and a textured veil. Richer blur, perspective, vector/effect families, particles, geometry and lighting require implementation, schemas, resource admission and quality tests. Do not describe the current renderer as a complete 3D/game engine.

Sets, Show transitions, timeline motion and Studio targets share the production clock/target/resource model. UI interaction animations can remain local to GPUI. Stateful simulations require bounded checkpoint/replay or explicit live-only scope. Reproducible music-reactive animation needs recorded audio or feature data.

There is no qualified triangle/object count, universal zero-copy result or 10x rendering claim. Measure fixed-quality workloads with actual guests, paired output, recording, GPU completion, frame age and memory.

## Documents and Serde

JSON remains portable authoring/interchange, not a per-frame scripting engine. Serde maps that document into typed Rust models; validation and compilation prepare bounded runtime plans off the media callbacks. Ordinary component authoring does not compile a new Rust executable.

Current core limits include an 8 MiB document, 4,096 nodes, 512 tracks, up to 256 keys per track, 4,096 expanded temporal instances and 256 KiB commands with up to 64 operations. Expanded graphs and effect resources have additional admission rules. These limits describe the current contract, not physical GPU capacity.

Line count is not the cost model. A 100,000-line document can fit a byte limit, but 100,000 authored nodes exceed current admission. Store bulk geometry/media in pinned assets; use reusable components and instancing. Raising limits requires stress/memory/compile and runtime qualification, not confidence in Serde alone.

A document can describe only implemented primitives and behaviors. Agent-authored interactive scenes are possible through that vocabulary; arbitrary JSON cannot invent physics, shader behavior or a new media backend. A future general gameplay layer is optional product scope, not a requirement for launching Producer.

## Headless Producer and Boomin iOS

Keep the Rust production engine usable independently of GPUI through a small, versioned native interface. The desktop, a headless worker and an embedded product can supply different controls while using the same production documents and validated operation catalog.

Two possible Boomin iOS integrations:

1. **Remote client:** control an authorized Producer host and receive its output.
2. **Embedded engine:** run the production engine inside Boomin iOS, with iOS capture, audio, Metal, encoder, lifecycle and permission adapters.

Boomin supplies identity, collaboration, grants and its own interface; Producer supplies production execution. GPUI must not own capabilities needed by these clients. This is an architectural boundary to preserve now, not an instruction to implement an iOS application or public SDK before the guest foundation. iOS needs a native binding and independent performance/lifecycle qualification.

## Licensing and scope

Removing libOBS does not automatically change the project's license. Current Producer/native manifests remain AGPL-3.0-only. Any future license decision requires an actual code provenance/contribution and dependency/build-configuration audit. No license change is made in this plan.

The next implementation is the protected media/guest path, followed by the reusable Set/Show engine. Do not drift into rewriting mature codecs, building a general game engine, adding a model-hosting business or porting the whole desktop to iOS before that foundation is working.
