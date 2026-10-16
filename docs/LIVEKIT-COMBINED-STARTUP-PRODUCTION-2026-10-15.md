# Combined startup production release

Live: API PR #438 and web PR #545. API eada625 and web f1d99d3 deployed through successful main-branch workflows. No desktop package or native media candidate shipped in this release.

The production guest page and API were tested with an owned temporary room, synthetic camera/audio, and the diagnostic native receiver. Startup returned 201 through the new endpoint; host return recorded at 1280x720; stage and removal checks passed. Three owned fixture rooms were removed with zero cleanup failures. The live website version matched f1d99d3.

One production Admit-start-to-preview observation was 7.006 seconds: 5.568 seconds before first positive outbound-video stats, 290 ms to native decode, 1.148 seconds to colored preview. The successful combined endpoint took approximately 375 ms; a preceding 409 retry remains in the trace. This is not evidence of a consistent 4–5-second experience, and it uses unreleased diagnostic native timing flags, not the stable installed desktop.

Recording matched 11 markers at 86.667 ms p95 and failed the full marker gate. Functional startup/removal success is separate from continuous AV qualification. No broad media reliability improvement is claimed. Sanitized details are in evidence/combined-startup-production-2026-10-15.json; private media and capability journals remain outside the repository.
