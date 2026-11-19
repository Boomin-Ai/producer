# N1 native media prototype

This is an isolated native codec/storage slice, not a GPUI build or a production replacement. `media` is outside `contract` and `core`; its FFmpeg feature is off by default. The document, schemas, core evaluator, production app, user profiles, native engine lock, captures, streams and installed production binaries are unchanged.

## Implemented boundary

- `media/src/player.rs`: two process-admitted persistent workers. Each owns construction, decoding and destruction of its decoder. The decoder need not be `Send`. A third worker rejects until an earlier worker actually exits. A panicking Rust worker marks the handle closed instead of silently accepting requests forever.
- `request`/`poll` use `try_lock`, bounded one-request/one-reply slots and latest-request generations. They perform no decode or filesystem IO. Replaced scrub requests coalesce; older completions cannot overwrite the current request. A close rejects pending/publication work. Explicit close/join is control-executor work, not a callback or UI-frame operation.
- `media/src/native.rs`: independently positioned local MOV players, exact rational source PTS/coverage, decoder drain, backward seeks, and bounded earlier-anchor preroll for DTS-indexed B-frame files. VFR coverage comes from adjacent displayed PTS, never guessed constant FPS. Sequential playback retains the current and one lookahead decoded frame, and reuses scaling scratch instead of seeking/recreating the process for every frame.
- A process-wide 64 MiB quota charges owned RGBA replies until their consumer releases them, even after closing the player. Decoder references and FFmpeg's own allocations are **not** covered by this quota. This does not close the existing RSS qualification gate.
- `media/src/take.rs`: one process-admitted raw-video/PCM writer pair. Program and original packets share validated clocks but have independent image bytes and files. Custom MOV fragments are flushed and both files synced before publishing a synced/renamed manifest. Readers snapshot the last committed range; appending more data cannot silently extend that reader. The writer faults after a failed write/checkpoint and retains the preceding in-memory committed range. Finalization checks the native error code and AVIO state.

The proof profile accepts local regular files up to 128 MiB, at most eight streams, decoded dimensions up to 1920 on either axis, one decoder thread per player, at most 50,000 packets / 4,096 decoded frames per request, and cooperative two-second request cancellation. The take proof accepts exactly RAWVIDEO + PCM_S16LE with contiguous, non-reordered packets and at most 32 MiB of paired packet payload. These are lab limits, not the final 24-hour recording profile or limits advertised to users.

`LocalAsset` is a trusted-control API, not a new path-bearing document field or a sandbox. JSON cannot resolve a path through the existing production document service. Filesystem capability/identity pinning, hostile-file isolation, interruptible open/read/codec calls and safe drive-loss shutdown still need implementation and qualification before desktop adoption. The cooperative deadline cannot preempt a blocked filesystem or codec call. Returned frame bytes are CPU RGBA; no GPU surface or zero-copy claim is made.

## Reproduction

Use the installed Rust toolchain and a C compiler. On macOS, Command Line Tools supplies Clang/libclang. The SDK script builds a small separately pinned LGPL FFmpeg 8.0.3 under the repo's ignored `target/native-media-sdk`; it does not use or modify the app's FFmpeg or OBS build. The downloaded archive is SHA-256 pinned; this records reproducibility, not independent publisher-signature verification.

```sh
sh crates/production-runtime/scripts/build-media-sdk.sh
export CARGO_TARGET_DIR="$PWD/target/production-core"
export FFMPEG_DIR="$PWD/target/native-media-sdk/install"
export LIBCLANG_PATH=/Library/Developer/CommandLineTools/usr/lib
python3 crates/production-runtime/scripts/prove-media.py
```

Normal workspace tests run without this SDK because the native feature is optional. `prove-media.py` uses FFmpeg CLI only for synthetic fixtures and external reference extraction. The actual per-request implementation uses the persistent in-process Rust/FFmpeg decoders. The CLI reference uses the same codec library; an additional independent Python raw-RGB oracle checks all 24 uncompressed frames.

## Evidence and observed limits

[Source-linked native evidence](evidence/native-media-proof.json) retains raw source times, image hashes, cold request-to-reply measurements, worker timings, version/hash provenance and named remaining gates. The 64×48 CFR, MPEG4 B-frame and VFR fixtures and a 1920×1080 B-frame fixture each run 72 image/interval checks, including every final frame, midpoint and reverse/forward traversal. Each also floods 500 seek requests and checks final generation, zero retained reply bytes and complete worker shutdown. Forward traversal adds zero seeks after the first positioned frame.

Four growing-take checkpoints are decoded while the writer remains open. Program pixels differ from the original; final PCM samples/hash match the source in both files. A frozen reader cannot seek into a later committed range. An occupied pending manifest injects a checkpoint failure and verifies the previous manifest/range remains and further writes reject. This is not a power-loss, full-disk or physical drive-removal test.

The first 1080p CPU-only run observed roughly **24 ms median / 25 ms p99 sequential worker time** and **37 ms median / 48 ms p99 random-seek worker time**. These small runs are diagnostic observations, not sustained 60 fps qualification or an improvement claim over production. Cold request-to-reply includes async opening/queueing; worker time does not. The next GPU work must avoid software RGBA conversion/copy/upload as the normal production path and qualify hardware decode/native texture/fence interop. An allocation-free core evaluator does not make these media costs disappear.

## Remaining N1 and next integration

1. Interruptible IO/open and malformed-media isolation; native file identity/grant lifetime; truly bounded native allocations and failure/retirement acknowledgement.
2. Audio decode/resample/playback, shared-clock A/V scheduling and explicit voice ownership; current PCM checks prove stored audio preservation, not audible device output.
3. Compressed growing takes, crash/recovery and disk-removal/full tests, bounded writer ingress, and persistent-reader refresh without closing/reopening. Negative DTS is exercised by B-frames; negative display-PTS origin remains a distinct gate. Large/24-hour media needs a qualified large-file/index profile.
4. Bind runtime execution/epoch/source-incarnation fences to these players and take references. The existing document/Assistant service is not wired to native file IO by this proof.
5. GPUI + native GPU integration: real output textures and timeline, hardware/native pixel handling, live capture/encode and physical four-platform results. Keep all UI/codec/IO dependencies out of the pure contract/evaluator.

The earlier core RSS gate remains open. This slice can be developed and tested in isolation without treating that failure as resolved or shipping unqualified native integration.


## Later GPUI compressed recorder

The 2026-11-18 [durable compressed-take slice](DURABLE-TAKES.md) implements the separate AVFoundation/Rust storage path in Producer Native Dev: paired program output plus selected originals, independently decodable chunks, exact reported sample spans, frozen committed heads and process-crash/checkpoint-failure recovery. It does not replace this earlier raw/PCM FFmpeg proof or clear its remaining N1 gates. A final-candidate five-track physical run now hash-checks and fully decodes all 85 committed fragments with no counted mic/mixer/GPU refusals in its measurement interval. Hostile IO, real drive/full/power-loss, long-duration memory, static-screen heartbeat, capture reconnect, take-backed live editing and other physical platforms remain explicitly open.
