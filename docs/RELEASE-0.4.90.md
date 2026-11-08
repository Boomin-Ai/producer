# Producer 0.4.90

Intel Mac builds now include the live engine, browser runtime, recording
helper and matching Producer virtual-camera components. They use the same
Developer ID signing, camera provisioning, notarization and updater
verification gates as Apple Silicon. New camera installations still require
normal approval in macOS settings. The Intel package requires macOS 13 or later.

The combined source retains 0.4.89's Network, onboarding, Threads and Windows
changes. Apple Silicon continues to use its pinned source-built engine.
Both production Mac targets compile the native guest runtime; the shared
updater is published only after all platform jobs and exact-source CI pass.

Build setup is documented and enforced through `make setup`, architecture
and component preflight, and a required-engine compilation guard. Accepted
notarization tickets use bounded retries for transient Apple delivery and
validation failures. Signature and policy errors still fail publication.

Earlier physical Intel acceptance verified live camera input and Producer
Virtual Camera video in Photo Booth using OpenGL/x264. It did not qualify
Metal, native guest calls, audio, recording, streaming or performance. Final
release artifacts must pass their own build, signing, notarization, native
runtime and updater checks; those checks do not imply a completed physical
Mac/Windows media or latency benchmark. Existing beta qualification limits
recorded for 0.4.89 remain.
