# Head to Head — The Grand Arena

A layered showcase set with six show phases and twelve layouts: Face-off, Blue side, Amber side, Receipts, The crowd and The verdict, each in 1920×1080 and 1080×1920. The portrait background was composed separately. Authored 650 ms morphs move the camera rigs. The default canvas/whole-set preparation path is used; there is no special rendering backend or added universal transition.

The generated arena plate sits behind native camera sources. A generated transparent titanium bezel sits in front. Cameras use native rounded masks and editable source framing. Rig groups carry the camera, bezel and nameplate together when they move or resize. Names, topic, scores, case statements, source citation and verdict remain editable graphics rather than generated image text. Two restrained native light-sweep accents sit near the floor. Receipts includes a third native slot for an image, video or screen source.

The audience phase collects for 45 seconds. The verdict uses the existing reveal/privacy rules: no winner or vote total is rendered until reveal. Its blue/amber lanes identify the two sides; they are decorative, not live percentage bars. Practice voting is available in private editor rehearsal. The room still requires the eventual authorized audience/data transport for real incoming votes; this package does not add webhook ingestion or bypass that boundary. No votes, names or winners are baked into the background.

Use the set picker in Producer Sets v2 Dev and choose **Head to Head — The Grand Arena**. Assign Blue side and Amber side sources, optionally assign Receipts, and Show on output. Start the show for authored segment morphs; choosing layouts while stopped gives their static compositions. The isolated showcase smoke room uses labelled synthetic color sources and leaves the set open for inspection. Those are replaceable previews, not physical camera captures.

Source package: [head-to-head-grand-arena.json](head-to-head-grand-arena.json). It embeds its three artwork assets and is self-contained. Regenerate it with `node scripts/sets-v2/make-grand-arena.mjs`. The generator validates through the strict package codec. [Artwork and exact imagegen prompts](media/grand-arena/README.md) record provenance; assets were generated with the built-in tool and saved in the workspace.

Validation: all twelve layouts compile through the real room compiler, including both output orientations, with valid node counts and positive geometry. Browser runtime checks exercise bounded camera-rig morph tracks, receipts panel entry, and a practice vote/reveal. The separate native OBS host renders all twelve layouts plus six sampled camera/panel morph states, checks real CEF paint readiness, repeated retained activation, stale-plan rejection and full native-group cleanup. Its solid green moving test source intentionally demonstrates native video underneath the transparent frame. The full dev-room smoke reached 12/12 ready, then Next rendered blue focus, amber focus and receipts at 1080p. Preview stills are labelled synthetic-source compositions, not screenshots of physical cameras.

This set also exposed excessive graphics surfaces when entering panels faded each descendant individually. The shared morph planner now fades a newly entering absolute box once, retaining its subtree as a visual unit. This keeps mixed media panels within existing browser-surface budgets; no budget limits were raised. Retained browser batches also explicitly disable restart-on-activation: a focused native end-of-morph capture exposed a reload that could blank already-painted text. The final native check asserts title pixels and visible camera pixels after repeated cached takes. Old/removed panels still follow the existing destination-layout behavior; this does not implement arbitrary outgoing-node retention or a general 3D camera move.

Evidence: [browser preview](../sets-v2/native/grand-arena/faceoff-landscape-preview.png), [portrait](../sets-v2/native/grand-arena/faceoff-portrait-preview.png), [native assertions](../sets-v2/native/grand-arena/native-proof.json), [room report](../sets-v2/native/grand-arena/room-proof.json). These tests are local macOS/Metal checks; no stream or production deployment occurred.


Reproduce the showcase checks (Vite on port 1436):

```sh
node scripts/sets-v2/make-grand-arena.mjs
node scripts/test-grand-arena-browser.mjs
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 \
PRODUCER_PROBE_SHOWCASE_ONLY=1 \
PRODUCER_ROOM_FIXTURES=/private/tmp/producer-grand-arena/plans \
PRODUCER_PROBE_OUTPUT=/private/tmp/producer-grand-arena/native \
bash scripts/sets-v2/run-native-probe.sh
```
