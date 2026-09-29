# Hosted post ingress — September 28, 2026

The user approved: incoming posts belong to units; existing links are preserved; Boomin publishing reuses originating units; unknown imports get unfiled units; repeat sync reuses both post and unit. No fuzzy grouping across channels, and collections remain optional.

API implementation is isolated in PR https://github.com/Boomin-Ai/api/pull/408 and mirrored into the sibling API workspace. Other sessions' dirty files are excluded from the PR.

Migration `0163_social_post_ingress_units.sql` supplies atomic AFTER-ingress assignment and a shared post-row lock for explicit assignment. Import/sync use conflict-safe upserts and hydrate AFTER-trigger links for their responses. Reimports preserve omitted fields and publication dates.

Rehearsal attached 598 unlinked posts while preserving all 632 original post fields other than unit_id and every known unit link. PostgreSQL smoke checks passed, including concurrency, lifecycle, brand isolation, shared units and deletion/reingress. API typecheck, 872 tests and Worker dry-run passed.

Release status: PR CI passed and #408 merged as `430a75716f855a987d99ed9b7879749196f0d11b`. [Production deployment 36469386462](https://github.com/Boomin-Ai/api/actions/runs/36469386462) passed, including migration/backfill, Worker deployment, route mount checks and deployed API smoke checks. Pre-release read audit: 632 posts, 598 unlinked, 34 linked, zero post/unit brand mismatches. Post-migration production read audit: migration applied, 632 posts, zero unlinked, 632 linked, zero brand mismatches. The temporary Neon rehearsal branch was deleted after verification.

Existing FK deletion semantics remain: explicitly deleting a unit retains historical posts with a null link. A subsequent ingress or assignment repairs the link; deletion itself does not recreate the deleted unit.

Full implementation and reproducible rehearsal notes are in sibling API `docs/POST-INGRESS-UNITS.md`. The next frontend package is the real draft editor and publishing on an existing unit ID; this ingress package does not remove the Manager's earlier blanket view-only setting.
