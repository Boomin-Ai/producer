# Native control authority reuse prototype

Built and tested in isolation; not live. Release behavior is unchanged.

The native host previously fetched authority before every Admit/Stage mutation, then fetched it again afterward. The candidate reuses a currently valid snapshot from the independent permission reader before the mutation. It validates room, brand, run, host process and participant, lease epoch, endpoint, transport, active state, revision and deadlines. Missing, expired or mismatched snapshots fall back to the existing fetch. Serialized commands, server-side concurrency checks and the post-command authority fetch remain intact, including ambiguous failures. Reuse never extends a permission deadline.

Enable only in debug builds with `PRODUCER_RTC_REUSE_AUTHORITY_PROOF=1`.

## Results

Combined actual native Admit and Stage elapsed time: baseline 6.883 seconds; candidates 4.723, 3.915 and 4.139 seconds. The baseline spent 1.771 seconds on pre-reads; all six candidate commands reused valid authority with zero pre-read time. Mutation latency also varied, so the entire observed reduction cannot be attributed to this change.

The first three preview observations came from the proof control loop, which waits for commands. They are observation upper bounds. The fourth run stamps actual decoder, output submission and graphics callbacks. Its Admit-start-to-preview was 8.537 seconds: command completion to first decode 3.201 seconds, decode to submission 1.035 seconds, submission to visible colored thumbnail 0.162 seconds. Removing redundant control calls does not solve intermittent media delivery delays.

The fourth recording matched nine numbered pairs at 26.667 ms absolute p95, but missed three audio-associated video markers and failed the full coverage gate. One earlier candidate passed coverage; the others did not. No production startup or media reliability guarantee follows from this batch.

## Verification

43 runtime tests and five native control tests passed before the callback instrumentation; diagnostic desktop build passed with callback instrumentation. Runtime tests are rerun afterward. Tests cover expired snapshots, closed connections, stale revisions, ownership mismatch and missing receipts. Detailed sanitized numeric results are in `evidence/native-control-authority-reuse-2026-10-15.json`. Private recordings and capability-bearing journals remain outside the repository. Owned temporary test rooms were deleted (three removed, zero failures).
