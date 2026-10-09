# Recording finalization and recovery — October 8, 2026

The two 19:48:05 recordings contained `ftyp`, `free`, and an open-ended `mdat`, but no `moov`. Their media writes stopped after about 47 seconds even though the recording rows were marked ready several minutes later. Production stdout/stderr went to `/dev/null`, so the historical helper error is unavailable. Disk pressure was observed, but the exact trigger is not proven.

## Changes

- Use FFmpeg fragmented MP4 (`frag_keyframe+empty_moov+default_base_moof`) with the existing H.264/AAC encoders. The initial movie index and completed fragments can reach disk during capture; an interrupted last fragment may still need repair.
- Wait up to five seconds for graceful stopping. libobs owns the remaining output teardown and helper close.
- Observe the native output stop signal. Unexpected helper stops produce an engine error once and append the reason and file path to the native live configuration directory's `recording-errors.log`.
- Before marking a recording ready, check the MP4 top-level box boundaries, format, nonempty movie index and media. This checks container completion, not every compressed frame.
- Mark incomplete containers interrupted and preserve the file. Check both output files even when the first fails.

## Validation

- Three recording database/container tests pass, including rejection of an open-ended media-only file that previously became ready.
- Native libobs test passes for simultaneous 1920×1080 and 1080×1920 recording. Both files contain their movie index before Stop, and completed containers pass validation.
- macOS AVFoundation reports both native outputs playable and decodes sample frames.
- The same native test kills only its own muxer helper and verifies a single unexpected-stop error.
- Native application build and `git diff --check` pass.

## Recovery

No recovery operation modifies the original 19:48:05 files. Separate `Recovered.mp4` copies were created using the external anthwlock/untrunc utility and working local references. Portrait needed its 1080×1920 AVC configuration restored from a matching native reference, including corrected chunk offsets and display dimensions. macOS AVFoundation reports both recovered copies playable and decodes beginning, middle and end frames. Recovered video durations are 46.833 seconds landscape and 46.866 seconds portrait. Footage never written into the originals cannot be reconstructed.

The change is built locally. It is not installed over the running production app or deployed as a release. Historical database rows and remote Manager posts have not been rewritten.

During final verification, both original 19:48:05 files and their recovered copies disappeared from Movies/Producer through an external change. Spotlight did not find the names elsewhere, and macOS denies terminal access to Trash. The user has been asked for the new location. The earlier playback evidence is retained, but no recovered copy is currently available in the recovery folder.
