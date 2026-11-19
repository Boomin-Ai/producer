# Resume after cleaning the Mac

Snapshot date: **19 November 2026**.

## Backup status

| Item | Location/status |
| --- | --- |
| Visual architecture, phases, follow-up decisions | This documentation directory, preserved in its GitHub plan branch/PR |
| Source inspection base | `f33fc0aa2635c1abab5e15bed35cd425d4cd88a7`; not sufficient alone to reconstruct the inspected working tree |
| Native/core prototype checkpoint | [`574acac4aef12f61b9ac27aa640b4c3f62a05e29`](https://github.com/Boomin-Ai/producer/commit/574acac4aef12f61b9ac27aa640b4c3f62a05e29), published branch `checkpoint/native-gpui-2026-11-19`; exact remote commit/tree verified |
| Checkpoint content | Four existing local core commits plus a snapshot of 186 modified/untracked native/core/workflow files; no application execution changes made while checkpointing |
| Recovery bundle | `native-gpui-checkpoint-2026-11-19.bundle`, created locally alongside the original HTML; requires main commit `667147951452931ebbc7f26db6dec02616aee74d` |
| Production baseline | `667147951452931ebbc7f26db6dec02616aee74d`, release 0.4.93; this plan does not alter it |
| Personal media/profiles/credentials/signing material | Excluded from public GitHub; separate private backup required |

The plan and native/core source checkpoint are now stored off-device on GitHub. Keep the checkpoint branch until the rebuild no longer needs it. Personal media, local libraries, profiles and credentials still need a separate private backup before a wipe.

The plan PR itself is documentation-only. It does not secretly include the prototype or publish a release.

## Recover the plan

Clone `https://github.com/Boomin-Ai/producer.git` and check out `docs/owned-media-engine-plan`. Open `docs/architecture/owned-media/producer-owned-media-plan.html`, or read its PDF, README and DECISIONS. If the PR has subsequently merged, those files are on main.

The HTML is self-contained and does not depend on the original `127.0.0.1` server, this Mac, installed Node modules or a signed-in application. Optional verification setup is in the README.

## Recover the prototype from GitHub

In a fresh clone:

```sh
git fetch origin checkpoint/native-gpui-2026-11-19
git switch -c dev/owned-media-foundation origin/checkpoint/native-gpui-2026-11-19
```

Verify HEAD equals `574acac4aef12f61b9ac27aa640b4c3f62a05e29`. The complete checkpoint tree is `12ddb6836cdfd6cbb4175b5a5855c7f21b7c1173`. The local checkout and its uncommitted files were left untouched when this snapshot was made.

The [source archive](https://github.com/Boomin-Ai/producer/archive/574acac4aef12f61b9ac27aa640b4c3f62a05e29.zip) is another way to retrieve the checkpoint, but a Git clone retains the history and is preferred for development.

## Alternative: recover from a copied bundle

Start with a normal clone of the Producer repository so the main prerequisite exists. In that clone:

```sh
git fetch origin main
git bundle verify /path/to/native-gpui-checkpoint-2026-11-19.bundle
git fetch /path/to/native-gpui-checkpoint-2026-11-19.bundle \
  refs/heads/checkpoint/native-gpui-2026-11-19:refs/heads/checkpoint/native-gpui-2026-11-19
git switch -c dev/owned-media-foundation checkpoint/native-gpui-2026-11-19
```

Verify HEAD equals `574acac4aef12f61b9ac27aa640b4c3f62a05e29`. Check the 26 source hashes in `source-audit.json` against this checkout before relying on the inspection. The bundle was verified locally. It preserves the same source as the published checkpoint branch.

The remote checkpoint commit and full Git tree were verified on GitHub after upload. The documentation PR and prototype branch can be deleted later if no longer needed; public Git copies and retained commits are not guaranteed erasable.

## Where to resume work

1. Read `AGENTS.md`, `docs/MACOS-BUILDS.md`, this plan, DECISIONS, and the checkpoint's `crates/production-runtime/{READINESS,GPUI-REFACTOR}.md` and `desktop/README.md`.
2. Keep current signed production and its profile separate. Create an isolated Native Dev profile. Do not copy credentials or private recordings into the repository or public issue artifacts.
3. Complete **P0**: name the reference workload/host/network, baseline the pinned native SDK, freeze identity/epoch/time/media/audio-route contracts and admission/retirement budgets. Audit pinned SDK/bridge capabilities. Start the narrow Windows interop/audio investigation early.
4. Implement **P1** using existing core/media code: one real LiveKit guest, native sinks, local camera/mic, shared playout owner, recipient self-return exclusion, synchronized paired recording and independent editorial preview. Host/guest reopen must recover with fresh authority and logical source rebinding.
5. Run deterministic tests, synthetic marker transport, then unlocked physical-device checks. Fully decode recordings and listen. Keep expected failures and unresolved memory gates visible.
6. Advance to four guests and recovery before deep Set styling. Classic eight paired layouts and Pilot then exercise the reusable renderer/control/Show contract.

Do not restart the project from an empty GPUI shell, redesign the document format from scratch or interpret a fast core evaluator as end-to-end media qualification. Conversely, do not preserve an old Set at the expense of the chosen fundamental engine design. User assets, identities and permissions still require protection.

## Rebuild inputs outside Git

Cargo/package dependencies are pinned in the source manifests/lockfiles. Native media SDK/build caches, downloaded public video fixtures, test-generated MOVs, app bundles, signing credentials and local profiles are not part of this backup. Recreate build dependencies from the source instructions and use synthetic/public fixtures for automation. Hardware permissions and stable development signing must be configured on the new installation.

Historical test receipts describe their exact source/hardware and are not fresh proof on the cleaned machine. Re-run the relevant gate after rebuilding.
