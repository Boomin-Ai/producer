# Deterministic production geometry

The isolated Rust core resolves production geometry before frame evaluation. GPUI may lay out the application, but cannot silently change a Set's output geometry. This slice adds anchors, pivots, explicit aspect constraints and source-aware row/column reflow. It opens no devices, captures no frames and is not wired into the current desktop.

## Authoring contract

A node can declare an optional `placement`. Legacy nodes omit it, preserving their canonical document/pin hashes and explicit frame behavior. An anchor is a normalized point in the parent; a pivot is a normalized point in the node. Frame `x/y` are offsets from anchor to pivot:

`left = parent.left + parent.width × anchor.x + frame.x − resolved.width × pivot.x`

The same rule applies vertically. Both points must be finite and within `[0,1]`. Default points are top-left. A bottom-right anchored fixed box uses both points `(1,1)` and negative offsets. This is point anchoring, not a stretch-anchor or general constraint solver. Flow cells provide responsive available size.

An optional aspect constraint contains a fixed integer ratio or a source ID with a required portable fallback ratio. Each ratio dimension is in `[1,65536]`. Modes are:

| Mode | Result |
| --- | --- |
| `width` | Preserve allocated width, derive height. |
| `height` | Preserve allocated height, derive width. |
| `contain` | Fit inside the box; sibling allocation stays unchanged. Set anchor/pivot to `(0.5,0.5)` to center it. |

For a column, `sizes: [{"kind":"aspect"}, …]` requires the corresponding child's `width` mode. A row requires `height` mode. Intrinsic main-axis sizes resolve first, then fixed/weighted allocation and min/max redistribution. Changing screen ratio therefore moves later siblings instead of drawing over them. Grid and other non-intrinsic flow items require `contain`. A new flow placement cannot also specify an ignored explicit frame. Existing unplaced flow nodes retain their earlier frame-ignored behavior.

Component instances inherit their allocated box; their definition root's authored frame is ignored as before. Placement on the definition root resolves within that inherited box. For an intrinsic component cell, declare the aspect on the instance itself. Transitive component aspect references participate in cache invalidation and resource dependencies, including references on group nodes that do not directly display that source.

Source `fit` (`contain`, `cover`, `stretch`) remains distinct from the geometry constraint. It controls the eventual pixels inside the resolved box, not sibling allocation. The compiler now retains that intent in `NodePlan`; no native pixel sampling is implemented here.

## Observed dimensions and identity

`LayoutInputs` is a separate immutable compile input, not a document edit or per-frame probe. It identifies the document and at most 256 visual sources. An entry contains the source-definition identity and integer display dimensions. The source adapter must normalize pixel aspect and rotation before supplying these dimensions. Audio-only players cannot provide visual aspect.

The identity hashes document ID, logical source definition and resolved asset definition. Missing inputs use the authored fallback and mark `usedFallback`; stale definition/asset identities reject with `LAYOUT_INPUT`. This hash is not a device grant, real capture-incarnation fence, or proof of first media. The future native adapter must additionally qualify source/capture generation, format generation and authority before submitting inputs. The existing preparation token and frame receipt fences still apply.

Document digest/revision identifies authored content. `geometryDigest` additionally identifies the supplied compile inputs, including unused entries; equivalent ratios can conservatively produce different input digests. A geometry change gets a fresh preparation token even at the same document revision. Old preparation frame receipts cannot activate it. Active output remains intact if the new geometry fails. Native font measurement, source discovery and automatic physical format-change observation are separate adapter work.

## Determinism, budgets and failure

Layout uses continuous coordinates until final raster admission. Each left/top/right/bottom edge rounds ties to even independently, so adjacent shared edges snap identically. Aspect is exact before snapping; final dimensions can differ by one pixel. An allocated positive box that snaps to zero width/height rejects explicitly. Derived nonfinite geometry, coordinates/dimensions beyond an absolute one billion, impossible gaps/min/max and intrinsic sizes exceeding available space reject with `LAYOUT`. No last-minute frame callback fallback is attempted.

The normal document/expansion/resource budgets still apply. Geometry inputs are byte-charged to worker/cache reservations in the two-document workspace. Compilation and hashing allocate on the control lane; this slice does not claim allocation-free layout compilation. Numerical track evaluation remains the separately measured allocation-free path. No new renderer, UI dependency or background source polling was added.

The compiler reuses only layouts whose definitions, transitive components and consumed aspect inputs are unchanged. Sequence fragments remain reusable when only geometry inputs change. Failed or cancelled candidates do not publish a partial cache. Prepared/active/retiring allocations stay charged until the matching disposal acknowledgment; dimension changes do not bypass that budget.

## Assistant and CLI

The public `setPlacement` transaction edits one node using Set/layout/path plus a placement object, or `null` to clear it when semantically valid. It uses normal expected revisions, native tickets, atomic validation and durable retry. The agent does not need to replace an entire Set to change geometry.

The authenticated stdio `layout` request rehearses geometry without changing the document or live output:

```json
{"method":"layout","session":"native-issued-session","set":"teaching","layout":"tall","offset":0,"limit":128}
```

Replies include authored/geometry digests, canvas dimensions, resolved node frames/pivots/aspect/fit and definition identities for aspect sources referenced by the returned page. Use those identities in optional `inputs`. Pages are limited to 128 nodes and 256 KiB including metadata. Unknown keys, wrong sessions and invalid inputs reject. There is no listening network socket or connection to the production Room Assistant.

`producer-core layout FILE SET LAYOUT [INPUTS_JSON]` exposes the same rehearsal for a document file. `layout-fixture` emits the synthetic paired teaching composition; `generated/responsive-layout.json` is Rust-generated. Its vertical screen is 1080×608 with the 16:9 fallback; supplying 4:3 changes it to 1080×810 and moves the host's top to y=826, without editing the document.

## Evidence and remaining gate

`core/tests/layout.rs` covers independent quarter-pixel anchoring oracles, grid rounding, intrinsic/fixed/weighted allocation, paired reflow, component expansion/ownership, selective reuse, invalid dimensions/identities, finite bounds and atomic minimal commands. The workspace regression uses real compile workers and tests preparation/frame/disposal fencing. `scripts/prove-layout.py` authors through the CLI, tests paginated read-only rehearsal and invalid input/session rejection, then checkpoints/restarts and replays its saved command once.

See [current readiness](READINESS.md) and the source-linked layout evidence there. Local core tests are not native camera, font, GPU, GPUI, recording or four-platform qualification. The next core work is global service admission and deterministic effects reconstruction; native interop remains gated by those and the broader Phase 1 ledger.
