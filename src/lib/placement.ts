/** Placement menu — the ONE placement button (v0.4.40).
 *
 * Wherever the room used to draw four little squares (top / left / right /
 * bottom) it draws one button. The button is STATIC: it shows where the
 * panel IS (a 4-cell mini layout, the active edge filled) and carries the
 * tooltip "In the <dock> dock". Clicking it opens a small glass menu with
 * every placement in the ring; choosing one moves the panel explicitly.
 * Nothing cycles on hover any more (v0.4.38's hover preview read as the
 * button randomly picking a placement). This is the pure half: labels, the
 * option list, and the menu's keyboard reducer. */

export type Placement = "top" | "right" | "bottom" | "left";

/** Clockwise from the top — the order the menu lists. */
export const PLACEMENTS: readonly Placement[] = ["top", "right", "bottom", "left"];

/** "In the bottom dock" / "Hidden" — the static tooltip on the button. */
export function placementLabel(p: string): string {
  return p === "hidden" ? "Hidden" : `In the ${p} dock`;
}

/** "Top" / "Hidden" — one menu row. */
export function placementOptionLabel(p: string): string {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export interface PlacementOption<T extends string> {
  value: T;
  label: string;
  /** The row that matches the current value (mint dot). */
  active: boolean;
}

/** The menu rows for a ring. `value` need not be in the ring (nothing is
 * active then). */
export function placementOptions<T extends string>(
  value: T,
  order: readonly T[],
  label: (p: T) => string = placementOptionLabel,
): PlacementOption<T>[] {
  return order.map((p) => ({ value: p, label: label(p), active: p === value }));
}

/** Where the highlight starts when the menu opens: on the current value, or
 * the first row when the value is outside the ring. */
export function placementMenuStart<T extends string>(value: T, order: readonly T[]): number {
  const i = order.indexOf(value);
  return i < 0 ? (order.length ? 0 : -1) : i;
}

/** The menu's keyboard: arrows move the highlight (wrapping), Home / End
 * jump, Enter / Space commit the highlighted row, Escape closes. Returns the
 * new highlight plus what to do; `handled` is false for keys the menu
 * ignores so the event can bubble. */
export function placementMenuKey(
  highlight: number,
  key: string,
  count: number,
): { highlight: number; commit: boolean; close: boolean; handled: boolean } {
  const none = { highlight, commit: false, close: false, handled: false };
  if (count === 0) return key === "Escape" ? { ...none, close: true, handled: true } : none;
  const step = (d: number) => {
    const base = highlight < 0 ? (d > 0 ? -1 : 0) : highlight;
    return { highlight: ((base + d) % count + count) % count, commit: false, close: false, handled: true };
  };
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return step(1);
    case "ArrowUp":
    case "ArrowLeft":
      return step(-1);
    case "Home":
      return { highlight: 0, commit: false, close: false, handled: true };
    case "End":
      return { highlight: count - 1, commit: false, close: false, handled: true };
    case "Enter":
    case " ":
      return { highlight, commit: highlight >= 0, close: true, handled: true };
    case "Escape":
    case "Tab":
      return { highlight, commit: false, close: true, handled: key === "Escape" };
    default:
      return none;
  }
}
