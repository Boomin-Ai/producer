/** Placement cycle — the ONE placement button (v0.4.38).
 *
 * Wherever the room used to draw four little squares (top / left / right /
 * bottom) it now draws one button that shows the CURRENT placement and, on
 * hover or with the arrow keys, previews the NEXT one; click or Enter
 * applies the preview. This is the pure half: the ring the button walks. */

export type Placement = "top" | "right" | "bottom" | "left";

/** Clockwise from the top — the order the button walks. */
export const PLACEMENTS: readonly Placement[] = ["top", "right", "bottom", "left"];

/** The placement after `cur` in `order` (wrapping). A `cur` outside the
 * ring lands on the first entry, so a stale value never strands the
 * button. Empty ring → `cur` unchanged. */
export function nextPlacement<T extends string>(cur: T, order: readonly T[], step = 1): T {
  if (order.length === 0) return cur;
  const i = order.indexOf(cur);
  if (i < 0) return order[0];
  const n = ((i + step) % order.length + order.length) % order.length;
  return order[n];
}

/** Walk the ring from `cur` to the first entry `ok` accepts (or `cur` when
 * nothing does) — a panel skips the dock it's already in. */
export function nextAllowed<T extends string>(cur: T, order: readonly T[], ok: (t: T) => boolean, step = 1): T {
  let p = cur;
  for (let k = 0; k < order.length; k++) {
    p = nextPlacement(p, order, step);
    if (ok(p)) return p;
  }
  return cur;
}

/** "Move to bottom" — the tooltip the button carries for a preview. */
export function placementLabel(p: string): string {
  return `Move to ${p}`;
}
