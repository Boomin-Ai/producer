# Independent implementation review closure

Reviewed 2026-11-15 by the independent adversarial review agent requested by the user. The reviewer inspected source and regression cases; the parent ran the tests. This follows the earlier plan/specification review and does not replace native or cross-platform qualification.

| Finding | Resolution | Reproduction retained in `core/tests/review_regressions.rs` |
| --- | --- | --- |
| P1: stop could be followed by activation of an old preparation or uncertain swap | Stop advances the runtime generation, supersedes preparations, retires active plans and prevents reconciliation from reactivating the stopped generation. | `stop_fences_old_preparations_and_unknown_reconciliation` |
| P1: replacing only one output could retire resources used by another | First profile explicitly requires full active-output replacement; configuration changes require stop. Rejection precedes swap/retirement. | `partial_output_take_cannot_retire_an_unreplaced_output` |
| P1: renderer updates could grow an unbounded target map | Both sender and receiver require a bounded typed parameter manifest; unknown, duplicate, incomplete-full and incompatible updates reject atomically. | `renderer_rejects_unknown_duplicate_and_wrong_type_targets_atomically` |
| P2: stale release could clear a newer override | Every acquisition has a new token; release checks owner, target and token. | `stale_override_release_cannot_clear_a_newer_acquisition` |
| P2: repeated undo toggled state instead of traversing history | Restore names a specific history entry, validates it at admission, advances revision and consumes history only after a saved result. | `repeated_undo_traverses_history_and_failed_save_does_not_consume_it` |
| P2: reused oversized scratch retained samples from a previous sequence | Evaluation clears the entire caller-provided output slice before writing active samples. | `reusable_scratch_does_not_leak_drivers_from_a_longer_sequence` |
| Follow-up P1: unchanged source aliases could preserve state for different media/resources | Incarnation identity includes resolved immutable file, geometry and material identities. Mutable analytic initial values do not unnecessarily reset resource identity. Runtime is document-scoped. | `resolved_file_identity_resets_player_even_when_asset_alias_is_unchanged` |

Two additional parent counterexamples have regressions: feasible mixed min/max weighted allocation, and finite-source loop mapping from a negative preroll interval.

The reviewer's final closure found no remaining **concrete blocker in the reviewed implementation** after these fixes. This means the corrected isolated slice is reviewable; it does not certify the unimplemented portions of Phase 1. `READINESS.md` records those gaps explicitly. No review promises an absence of future bugs.

## Subsequent nested timeline slice

The independent closure above applies to the first-slice commit `a1e0f16`, not automatically to later code. The nested slice has parent-authored regression/CLI/benchmark qualification in `NESTED-TIMELINES.md` and `READINESS.md`; it has not received a new independent implementation review. Counterexamples addressed here include rewind cue replay, lost root loop identity across pause/resume, rebinding conflicts, canceling speed ratios, preflight fuel bypass through binding scans and oversized simulation responses. No desktop adoption is authorized by this ledger.
