# Native compressed takes — development slice

Implemented 2026-11-18 in **Producer Native Dev**, not the production desktop. This advances N1 and the first recording phase; it does not finish the N1/N2 platform, memory, device or live-editor gates.

## Ownership and time

Rust owns recording admission, explicit original selection, take identity, exact rational sample spans, immutable chunk identity, durable publication, inspection and recovery. AVFoundation owns H.264/AAC encoding behind a serial writer queue. GPUI and the same-user CLI submit the same `RoomCommand`; neither owns a second recording clock.

Both program outputs are always recorded at their configured room dimensions. Camera and screen originals are optional, before composition/Set transforms. The optional mic original is before its output gain/mute; the UI explicitly warns that it can contain audio muted in the program. All original selections default off on app launch and are locked while a take is recording/finalizing. Recovery never starts devices or resumes recording.

A take has one monotonic host origin. Encoded sample reports retain actual per-stream PTS and duration; startup A/V offsets are not flattened to zero. Camera/screen original video uses the provider sample timestamp, with a finite host-clock fallback. Editorial seek/trim can change the recorded program while originals retain their continuous capture clock. The imported MOV remains a content-hashed immutable asset reference rather than a newly encoded original.

The current header does **not** persist a complete room-revision/seek/cue history. These files therefore do not reconstruct the entire live composition automatically. [Committed-take editing](TAKE-EDITING.md) now maps one selected track's frozen checkpoint into an immutable player asset and ordinary placements. Reconstructing the original editable live composition is still a later slice. One shared clock and stored spans are prerequisites, not a lip-sync certification.

## Durable format and reader boundary

Each `recordings/take-<nanoseconds>` directory contains:

- `take.json`: version, room, host origin, source/incarnation/format descriptors and immutable asset hashes;
- `track-NN-IIIIIIII.mp4`: an initialization header plus one independently decodable H.264/AAC fragment;
- matching immutable JSON records: byte length, SHA-256, exact sample spans and per-stream gaps;
- `head.json`: revision, recording/saved/interrupted/failed state, and the latest committed chunk per track;
- `owner.lock`: exclusive live-writer/recovery ownership.

For every segment, the storage worker writes and syncs media and metadata, syncs their directory, writes/syncs an exclusive `head.pending`, then atomically replaces and syncs `head.json`. Only that published head exposes the new range. Saved requires every encoder to finish and every delivered segment to commit. Encoder completion alone cannot say Saved.

A reader freezes a head and cannot read later chunks through it. It can inspect a newer head explicitly. Inspection validates the latest chunk of each track; historical chunks are hash-verified when opened. Chunks describe actual spans and gaps, not an invented continuous recording. The common endpoint is conservative and does not promise coverage through a gap.

An encoder's final fragment can have samples for only one declared medium.
Zero-duration reports are omitted rather than inventing zero-time audio.
Positive spans must name declared media; per-medium cursors retain overlap/gap
validation across intervening fragments with no samples for that medium. Saved
still requires samples from every declared medium and completion of every track.

Recovery requires the writer lock to be free. It validates the published head, retains its exact track caps, preserves a torn pending head separately and marks the take Interrupted. It never scans orphan files into availability. A failed/removed/full destination cannot silently redirect footage elsewhere. OS sync/rename and process-crash tests are not a physical power-loss guarantee.

## Bounded work

| Boundary | Current local limit |
| --- | --- |
| Encoded handoff | 8 media messages, at most 16 MiB compressed bytes queued/reserved; one reserved payload-free completion notice per track |
| Single encoded fragment | 8 MiB; initialization at most 64 KiB per track |
| Tracks | 2 program plus camera, screen and mic originals: maximum 5 |
| Video ingress | At most 6 retained GPU buffers queued for the native writer |
| Audio ingress | At most 12 combined 10 ms mixed/original PCM tasks |
| Durable metadata | 32 KiB per record; 100,000 chunks per track |
| Catalog inspection | At most 1,000 directory entries, with explicit truncation |

The two-second fragment interval and approximately 30 fps video are the admitted test profile. The index count can represent over 24 hours at that cadence, but no 24-hour/native memory qualification is claimed. Large high-motion/custom-size encodes can exceed the fragment-byte bound and stop visibly; default 1080 outputs were tested. AVFoundation, Metal and filesystem internal allocations are outside the handoff quota.

Camera/audio callbacks do not write files. Encoded callbacks reserve capacity, copy compressed data and enqueue it; they do not sync disks. Only the storage worker hashes/syncs/publishes. The native serial writer owns all encoder mutation. Its video and audio admissions are separate; one PCM task carries both mixed and optional original samples. Capacity/encoder/format failures stop recording visibly and retain already committed footage.

Start admission is single-owner, including simultaneous callers and filesystem work that outlives the caller timeout. A rendezvous acknowledgement prevents a timed-out start from leaving an unowned live take. The storage worker still uses synchronous OS file IO: it cannot preempt a permanently hung filesystem call. The bounded handoff protects media/UI ownership but does not qualify hostile IO shutdown or a fixed process-RSS ceiling.

## CLI and local checks

`recordOriginals`, `record`, `takeList`, `takeInspect` and `takeRecover` are typed local room commands. Originals require explicit selection; take inspect/recover names are rooted local identifiers, not arbitrary paths. These are usable by the local CLI foundation. The actual ChatGPT/MCP adapter is not connected to the new GPUI room yet.

```sh
target/native-room/debug/producer-native-room --request '{"op":"recordOriginals","camera":true,"screen":true,"microphone":true}'
target/native-room/debug/producer-native-room --request '{"op":"record","enabled":true}'
target/native-room/debug/producer-native-room --request '{"op":"takeInspect","name":"take-REPLACE_WITH_LOCAL_DIGITS"}'
```

`desktop/scripts/check-room.py --record --originals camera screen microphone` opts into the full physical recording test. `desktop/scripts/check-take.py --take <local-take> --ffprobe <binary> --evidence <local-json>` hash-checks and fully decodes every chunk allowed by a frozen head, checks stream types/dimensions and rejects decoder errors. Keep camera/screens/audio and detailed local paths out of public artifacts.

## Local evidence and remaining gates

The corrected 30-second run saved both 1080 program orientations plus physical FaceTime HD camera and mic originals while playing/seeking/trimming the H.264 MOV. All **61 committed fragments** hash-checked and fully decoded: 894 program video frames per orientation, 895 camera-original frames. No new mic rejections, mixer underflow, audio-clock skips/discontinuities or GPU submission refusals occurred in the interval. No inter-fragment media gaps were reported. Peak compressed handoff reservation was **6,932,224 bytes**, below its 16 MiB cap. These observations do not measure total RSS, GPU duration or subjective A/V sync.

With both program audio sources muted, the first program fragments decoded to exact silence while the mic-original fragment contained physical input. After unmuting, program and mic-original fragments contained matching mic audio. This proves pre-fader retention, not subjective listening/lip sync.

The first originals attempt **failed** at the old shared audio/video queue. Separate admissions and combining mixed/original PCM in one task corrected it; the failed take/log remains local. Tests were not made to pass by increasing the mic ring or mixer delay.

An actual SIGKILL of only Native Dev after committed fragments, followed by same-bundle restart/recovery, retained the exact post-kill published caps. All four recovered fragments fully decoded; capture and original selection stayed off. An exclusive torn-checkpoint injection stopped recording with a visible error, left the prior head byte-for-byte unchanged, and recovered only its two committed fragments; those fully decoded too. Unit tests additionally exercise unavailable destinations, corruption, ownership locks, torn/orphan records, frozen ranges, timestamp validation, abandoned starts and simultaneous starts.

The first full-five-track run exposed another bounded-admission failure on stop: final fragments and five encoder completion notices competed for eight message slots. Completion notices now have one reserved, payload-free slot per track in the same FIFO. Media admission remains eight messages and 16 MiB; completion cannot jump ahead of committed media. Two focused tests reproduce a full media queue plus five completions and verify that a ninth media message is still refused. All **11 desktop unit tests pass**.

After renewing only Native Dev's Screen Recording entry through System Settings, the final installed candidate passed a full five-track physical run. The 30-second measured seek/trim interval produced about 32.1 seconds of recorded media including encoder warm-up. All **85 committed fragments** hash-checked and fully decoded: **962 video frames in each 1080 program output**, **963 camera-original frames** at 1280×720 and **934 screen-original frames** at 1920×1080, plus the mic original. No inter-fragment gaps were reported. All counted mic rejections, mixer missing frames, audio clock skips/discontinuities and GPU submission refusals had **zero delta** during the test. Peak compressed reservation was **8,479,190 bytes** of 16 MiB. Sampled CPU evaluation/build/submission p99 ranged **2.96–5.33 ms**; that excludes GPU execution and end-to-end latency. Recorded program frames were inspected locally with screen, camera and the synthetic MOV visible in both orientations. The camera was pointed into a dark scene; no face-quality or lip-sync claim follows from that inspection.

The [sanitized source/qualification record](evidence/native-durable-takes-proof.json) records this exact installed candidate and retains the earlier four-track run and the finalization counterexample. The check script now waits for new, recent frames after camera restart instead of trusting historical frame counts. Capture permission renewal is not a permanent signing fix: ad-hoc executable changes can still require a new macOS grant.

The subsequent [reader/editing slice](TAKE-EDITING.md) has a separate source and qualification record. Its results do not retroactively extend the five-track hardware pass above to a newer executable.

**Open:** real drive removal/full/power loss, hung IO/codec isolation, long-duration/memory plateau, static-screen timestamp/heartbeat behavior, disconnect/reconnect/format changes, listening/lip sync, continuous growing-take playback qualification, full recording provenance and Windows/Linux/Intel physical checks. Production remains unchanged.
