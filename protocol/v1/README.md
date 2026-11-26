# Producer Protocol v1

A production must travel as an editable work. A receiving studio can choose a cheaper decoder, bind its own cameras and render at its display size while preserving authored cuts, cue times, sound, composition and credits. The conformance vector is a six-second episode with a three-second collaborator placement. The package opens offline.

## Names and identity

| Term | Meaning and address |
| --- | --- |
| Production | One enduring work, identified by a UUID URN. Its human title and native document ID can travel across revisions. |
| Universe / entity | Reusable fiction, people, props, wardrobe, locations and look. Separate from the actor who authored or licensed them. |
| Show / segment | Native rundown and named segment. A segment binds landscape and vertical layouts and may play a sequence. |
| Sequence / instance | An editable clock and a timed use of another sequence. An alternate edit can have its own sequence. |
| Placement (cut) | One occurrence of a source. Its stable address is the production URN, sequence ID and placement ID. Its duration comes from the native range. A timecode or title alone cannot identify a cut. |
| Shot / take | Creative intent attached to a placement, and a particular realization of that intent. Several cuts can use the same take. |
| Actor / contribution | A person, entity or brand and its credit on a named cut. A brand placement names its contributor, featured entity, role and disclosure. |
| Asset / representation | The authored original and interchangeable encoded media. A source plays the asset. A live source declares a role the receiver binds locally. |
| Sound / route | A source is timed by a placement, routed to Program or Monitor and mixed with explicit units. Narration carries words, timing, speaker and performance direction. |

For example, *Field Notes → Episode One → Opening → main → sponsor-cut* leads to the authored interval [2 s, 5 s). Its actor is North Signal, its featured entity is the field recorder, and its disclosure is “Equipment supplied by North Signal.” A producer can rename the show, replace a proxy, or move that cut and its credit still resolves by ID.

## Wire format and conformance

A v1 package is a directory. Copying its files preserves the production. A transport may wrap the directory for download. The receiver stages a private copy before inspecting it. Only the following entries participate in a frozen revision.

| Entry | Content |
| --- | --- |
| `manifest.json` | UTF-8 JSON matching [the v1 manifest schema](bundle.schema.json). Contains the production identity, parent, entry point, workflow, creative records, mix, representation inventory and extensions. |
| `production.json` | The existing [Producer production document](production.schema.json). Contains editable sets, sources, components, shows, sequences, cues and timed properties. |
| `blobs/<sha256>` | Exact bytes of every original and every declared proxy, including reference images, sounds and fonts. Paths are derived from lowercase SHA-256 digests. |
| `manifest.json.sig` | Detached OpenSSH SSHSIG over the exact manifest bytes, namespace `producer.bundle.v1`. Ed25519 is the required interoperable signing key type. |

The manifest carries `protocol = producer.bundle/1`. The document carries `schema = producer.production/1`. A reader MUST check the versions, byte hashes, reference graph, and native timing invariants before treating a bundle as executable. JSON objects reject duplicate keys. Documents and manifests each have an 8 MiB ceiling. The native contract defines exact safe number, depth and work limits. Blob hashing streams independently of JSON parsing. A receiver applies its own disk and decoder budgets before staging large packages.

An implementation MUST report an unsupported major or unknown required extension. Fork-specific payloads belong under reverse-domain names in `extensions`. Optional extensions travel unchanged through unrelated edits. A reader MUST explicitly report an unsupported required playback feature or incompatible media. Native property, bus and source semantics are defined by the production contract. The JSON Schemas describe structure; the executable conformance gate exercises additional semantic rules.

## Exact cuts, local execution and sound

Time is a signed integer tick string divided by a positive integer rate. Ranges are half-open. At exactly 5 seconds the sponsor cut has ended. Nesting applies source-in, speed and looping through the native sequence evaluator. A segment selects its own horizontal and vertical layouts. Live slots identify roles such as host camera and guest. Bindings, microphone permissions, local file paths and credentials belong to the receiving studio.

The asset ID is stable across encodings. The native asset hash pins the original bytes. A video proxy MUST represent the same edit, source-time origin, framing, display aspect, duration, and synchronized stream content. Store display dimensions after rotation and pixel-aspect correction. V1 permits alternate video encodings. Other asset kinds travel as originals. A runtime MAY choose its decoder, render resolution and hardware acceleration. It MUST verify the representation digest and check decoded metadata, source coverage and supported stream semantics before playing. A hash authenticates bytes; equivalent editorial content across different encodes is an assertion by the issuer. The fixture checks both actual encodes.

The baseline format tokens used here are `h264-mp4` (AVC in MP4), `pcm-wav` (integer PCM in WAVE), `png` and `woff2`. Format recognition requires decoder capability; forks can advertise additional tokens. A receiver can cache successful verification in an immutable, content-addressed store and plan several device profiles from the same verified state.

The reference plan accepts supported formats and a maximum video width and height. It selects a compatible original first, then the largest compatible proxy, with the last listed proxy winning equal widths. A host may implement another compatible selection policy. Missing media, absent fonts, unsupported formats and unresolved live slots are visible conditions. A prepared offline show can be inspected with unbound live slots.

A recorded take can describe the microphone make/model, polar pattern, placement, distance, sample rate and ordered channels. A cloned entity or Universe may pin its originating production, revision and local ID. Characters can declare a provider-qualified voice.

An audio placement supplies the source trim and active range. Its native audio route names Program or Monitor. A mix record addresses the sequence and route IDs. The sound role distinguishes dialogue, narration, music, effects and ambience. Apply mute first. Gain is amplitude multiplied by `10^(gainMillidb/20000)` within −96 to +24 dB. Stereo balance ranges from −1000 (left) to +1000 (right). Attenuate the opposite channel linearly to zero, preserving the near channel. Centered mono feeds both channels equally. An omitted mix record uses unity gain, centered balance and audible state. A fork MUST preserve the native routing through sequence reuse. Monitor-only material stays off Program. Advanced processing needs a declared extension or an authored rendered stem.

## Creative depth and reference sheets

The same shot can exist during development or in the final edit. Supply a positive `plannedDuration` while storyboarding. Once placed, supply its `cut` and derive duration from that placement. A production may start with an empty native document, a brief and a task list. A completed production requires a playable show/segment entry.

Camera defaults resolve field by field in this order: production setup, the shot's named Universe setup, sequence setup, shot direction, then timed beat. Each supplied non-null field overrides the inherited value. Presence of a cast member from another Universe does not change the active setup. A beat at [0,2) can retain the inherited 50 mm lens and a later beat can ask for 55 mm. Overlapping beats describe simultaneous instructions; producers should give incompatible camera moves distinct shots. Camera orientation uses horizon-relative pitch (positive up), yaw (positive right) and roll (clockwise from camera view), in degrees. Dimensions, exposure and focus use the units in their field names. Unknown readings can be omitted.

| Depth | What travels |
| --- | --- |
| Universe and entity | Lore, palette/style, entity kind, traits, prompt scaffold, ordered reference media and optional link to the credited actor. |
| Shot | Intended subject and action, location, lighting, framing, angle, camera movement, camera body/model, sensor, lens, focal length, focus distance, aperture, shutter angle, ISO and white balance. |
| Beat | An exact range relative to the cut, action, camera overrides and timed narration with speaker, language, exact words, delivery, pronunciation and optional recorded audio asset. |
| Reference | An asset, its use, a specific instruction, and optionally a range in that source. Roles include composition, subject, camera motion, wardrobe, first/last frame, voice and sound. |
| Prompt | Authored text and ordered entity mentions. Mention offsets count UTF-16 code units, use half-open ranges, and must land on code-point boundaries. |
| Take | Actual output asset, origin, observed camera and optional model receipt. Generated takes require provider/model, the submitted prompt, a direction snapshot and the digest of the frozen recipe revision. Model versions, seeds and other parameters can be recorded when supplied. Archive the cited recipe to retain the full input graph. |
| Credit | Separate person, entity and brand actors. Each brand-placement credit names one sequence placement, its featured entity and disclosure. Credit metadata carries attribution. Billing, permission to use a likeness, and permission to publish require their own authority. |

`bundle-sheet` resolves camera defaults, beats, assets, entities, Universes and credits into one JSON reference sheet. The example names Seedance 2.0 as the intended model and explicitly records a synthetic fixture take. The sheet includes ordered, digest-pinned reference aliases such as `@Image1`, `@Video1` and `@Audio1`. Adapters can map the ordered image/video/audio inputs to a provider's reference slots and check the provider's own limits. Replaying a frozen production uses its saved take. A generation request is a separate operation and can produce a new take. [Seedance multimodal reference model](https://seed.bytedance.com/en/seedance2_0)

## Production stages, history and freezing

`workflow.state` is planned, active, completed or cancelled. `phase` describes development, preproduction, production, postproduction, review or delivery. Tasks have their own phase and owner, may address an individual shot, and can be to do, in progress, blocked with a reason, or done. Work in different phases can overlap. A planned item has no start or end. An active production has a start. A completed item has both endpoints. A cancelled item has an end and can have been cancelled before starting. Timestamps are UTC epoch seconds supplied by the author. End must follow or equal start and cannot exceed revision time.

There are three distinct identifiers.

1. **Production identity** is a canonical, non-nil UUID URN. Renaming, transferring and revising a work preserve it. Creating an independent derivative with a new identity requires a separate genesis.
2. **Revision** is lowercase SHA-256 over the exact bytes of `manifest.json`. The signed manifest binds the exact native document and every declared blob. Editing workflow, credits, camera direction, or even the manifest's serialized whitespace changes its revision. A child stores its parent's revision digest. A fork can branch twice from the same parent. Recipients compare the expected base before adopting a child and retain divergent heads for explicit reconciliation. V1 has one direct parent per revision.
3. **Reviewed work** is SHA-256 over the RFC 8785 canonical JSON of the *as-supplied manifest* after removing the top-level fields `author`, `authoredAt`, `parent` and `workflow`. It includes the exact native document hash, representation inventory, creative work, contributions and extensions. A workflow-only update can retain its review. A changed cut or shot direction invalidates approval for completion.

An unfinished production can be frozen and signed. Check it out to a fresh directory before editing. Completion requires every required task done, a current approved work digest, and the reviewer's attestation as author of that completed snapshot. `startedAt`, `endedAt` and review decisions are signed assertions. Verification authenticates the signer and bytes. A timestamp service, review-role authority, key recovery and revocation policy belong to the recipient or network. A signature grants no implicit access to an account, private studio, payment rail or output. Reopening a completed production creates a new active child revision with its own recorded state. Its signed ancestor remains retrievable in its original state.

The signing namespace separates production signatures from other uses of the same key. Resolve the manifest author through `actors[author].identity` and verify using a **receiver-controlled** allowed-signers file. A bundled public key cannot establish trust in its own issuer. The sample public signer file is a pin for this test vector. It contains no private keys. A verifying client may accept an individual snapshot without its ancestors. To claim a verified line of descent, verify signatures, production UUID, parent hashes and nondecreasing authored times for every edge.

## Show execution

[Explore the Listening Room in the offline show monitor](index.html). The corresponding signed [example document](listening-room/production.json) and [manifest](listening-room/manifest.json) can be opened directly by an implementation.

A **show** specifies an ordered rundown and its **set**. The set supplies spatial layouts, render graphs, and participant input requirements. Each **segment** is an editorial occurrence with a starting landscape and vertical layout and an optional sequence. A **sequence** is an independently addressable timeline with rational timing, placements, nested sequences, automation, cues, and program routes. Multiple segments can refer to one layout or sequence. A segment can switch layouts repeatedly without changing its identity or resetting transport.

Entries in `layoutChanges` take effect at their exact sequence timestamp. The incoming layout owns the boundary. Each output resolves its layout through the set’s `outputGraphs`. A graph orders the composition, fragment, or geometry passes and names their inputs. A receiver may implement an identity composite directly in its existing compositor. Seeking evaluates current layouts and continuous controls without dispatching historical cues. The native harness is responsible for device bindings, media decoding, GPU allocation and permissions.

A set may require a particular actor’s guest audio track and make their video optional. Availability is observed by the receiving harness. Each observation must match the source, actor, and track. `bundle-readiness DIR SET LAYOUT OBSERVATIONS_FILE` evaluates these preconditions. `bundle-show DIR SHOW EVENTS_JSON` evaluates segment progression, selected output graphs, player positions and automation. Verify the signature before trusting either result.

## Sound, picture and setting

A music session binds a content-addressed DAWproject 1.0 score to a PCM stem placement, its sample rate and a named picture cue. The DAW exchanges the intact arrangement archive, including editable MIDI and instrument state. The rendered stem permits playback on devices without the original instruments. A score revision and its rendered stem travel in the same signed manifest. Timing inside the arrangement may be beat-based while a picture marker uses seconds. A score edit produces a new revision with the original parent. Third-party plug-ins and their licenses are resolved by the receiving host.

A cut may author gain, opacity, saturation and RGB gains as step, linear or eased envelopes on elapsed placement time. Keys start at zero and increase strictly. Gain and RGB values are linear multipliers, opacity ranges from zero to one, and saturation is a multiplier about luminance. Color processing uses the source working space. A location entity, WGS84 coordinates, setting, day part, weather, ambience and civil time can describe the intended setting. A take can record its observed capture environment independently.

Use `adapters/daw.py export` to hand off the score and stem, then `import` to validate and stage a returned edit for signing. The Listening Room test uses an independent headless DAW to change tempo and instrument, reopens the eight notes and compares the returned PCM with a second render. Use the test script with Python 3.12, NumPy and DawDreamer 0.9.0.

## Revision comparison

After receiving an edited package, run `snapshot.py compare CHILD --parent BASE --trust FILE` before summarizing the edit. It verifies both signatures and their parent relationship, compares objects by stable ID, and reports retained placement ranges and cue times. Music comparisons include the declared tempo, instruments, note count and a fingerprint of the note attributes. The report is derived locally from the two revisions and can be reproduced by another harness. Release notes describe changes to the protocol implementation itself.

## Agent operations

Agents can discover the native vocabulary through `producer-core schema`, `command-schema` and `tool-schema`. They can propose transactions through the existing production service, including sequence replacement, and evaluate an edit using native compile/simulate. Changes to a checked-out production become portable when frozen into a child snapshot. A bundle contains data and references. Loading one must never execute a shell command, upload a clip, bind hardware or publish a show as a side effect.

## Run the vector

Build from the repository root with stable Rust and the workspace lockfile.

```sh
cargo build --locked --manifest-path crates/production-runtime/Cargo.toml -p producer-production-cli
export PRODUCER_CORE="$PWD/crates/production-runtime/target/debug/producer-core"
python3 protocol/v1/snapshot.py verify protocol/v1/field-notes --trust protocol/v1/conformance/fixture-signers
"$PRODUCER_CORE" bundle-sheet protocol/v1/field-notes reveal
```

Use `bundle-run DIR DEVICE_JSON SEQUENCE EVENTS_JSON` to evaluate a verified package with its local media plan. `bundle-edit DIR EXPECTED_REVISION COMMAND_JSON` applies a native typed edit and emits a replacement production document for a draft. A stale revision fails before editing. Use `bundle-check DIR` for structural validation and integrity. Use `snapshot.py verify` for signer verification and `--parent DIR` to check the direct ancestor. Use `checkout SOURCE DRAFT --trust FILE` to create a writable child and `freeze DRAFT NEW --parent SOURCE --key KEY --trust FILE` to sign it into a fresh directory. Supply at least one trusted principal for each signer in a collaboration. Anyone with the trusted public keys can verify archived snapshots offline.

For a full gate, install Node, Google Chrome, OpenSSH, Python 3.9+ and the test-only Playwright Core driver. Set `CHROME_BIN` to the Chrome executable. Use a temporary dependency directory or an existing Playwright installation.

```sh
npm install --prefix "$TMPDIR/producer-peer" --no-save playwright-core@1.65.1
export NODE_PATH="$TMPDIR/producer-peer/node_modules"
python3 protocol/v1/conformance/check.py
```

The gate verifies the published fixture signature, copies it to an independent JavaScript reader, decodes the original and proxy, draws landscape and vertical layouts with the packaged font, mixes six seconds of audio, and slips the source of the three-second cut. A distinct signer freezes the returned cut, and the Rust timeline evaluates both the main sequence and a nested excerpt. It also exercises work with no footage, completion, outdated approvals, altered documents, media and signatures, unsupported capabilities and broken creative references. `--evidence NEW_DIRECTORY` retains the signed results, public keys, reference sheet and rendered frames. The browser peer exercises the fixture's feature subset. Desktop import UI, network discovery, hosted generation and store-and-forward transport are independent integration points.

The full cross-implementation check uses Python 3, OpenSSH, Node 24, Playwright Core 1.65.1 and an H.264-capable Chrome. In a shell with `node` on PATH, set `CHROME_BIN` to the Chrome executable and `NODE_PATH` to the directory containing the installed `playwright-core` package. From the repository root run:

```sh
python3 protocol/v1/conformance/check.py --core "$PRODUCER_CORE"
```

The [fork CI workflow](../../.github/workflows/producer-protocol.yml) runs the same check on changes to the protocol or production runtime.
