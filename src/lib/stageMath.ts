/** Pure geometry for the stage editor's resize handles.
 *
 * The engine fits every item with OBS bounds SCALE_INNER: the picture is
 * scaled by min(w/cw, h/ch) and centred inside the box. That means a box
 * whose width grows ALONE does not grow the picture — the picture keeps the
 * scale the height allows and merely recentres, so an east/west drag reads
 * as the source SLIDING by half the travel. Every handle therefore scales
 * the box uniformly (aspect of the cropped source), and side handles keep
 * the box centred on the axis they don't drag. */

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResizeSource extends Box {
  src_w: number;
  src_h: number;
  crop_left: number;
  crop_top: number;
  crop_right: number;
  crop_bottom: number;
}

export const MIN_SIDE = 32;

/** Aspect (w/h) of the picture the box is fitted around, or null when the
 * source hasn't reported a size yet. */
export function contentAspect(o: ResizeSource): number | null {
  if (o.src_w <= 0 || o.src_h <= 0) return null;
  const cw = Math.max(1, o.src_w - o.crop_left - o.crop_right);
  const ch = Math.max(1, o.src_h - o.crop_top - o.crop_bottom);
  return cw / ch;
}

/** Box after dragging `k` by (dx, dy) canvas units from the original `o`.
 * Deltas are measured from the gesture START, never from the last tick, so
 * a long drag can never compound. */
export function resizeBox(o: ResizeSource, k: ResizeHandle, dx: number, dy: number): Box {
  let { x, y, w, h } = o;
  const ar = contentAspect(o);

  if (k.includes("e")) w = Math.max(MIN_SIDE, o.w + dx);
  if (k.includes("s")) h = Math.max(MIN_SIDE, o.h + dy);
  if (k.includes("w")) {
    w = Math.max(MIN_SIDE, o.w - dx);
    x = o.x + (o.w - w);
  }
  if (k.includes("n")) {
    h = Math.max(MIN_SIDE, o.h - dy);
    y = o.y + (o.h - h);
  }
  if (ar === null) return { x, y, w, h };

  if (k.length === 2) {
    // Corner: width leads, height follows; the opposite corner stays put.
    h = w / ar;
    if (k.includes("n")) y = o.y + (o.h - h);
  } else if (k === "e" || k === "w") {
    // Side: the dragged edge moves, the opposite edge stays, height follows
    // and stays centred on the box's original vertical middle.
    h = w / ar;
    y = o.y + (o.h - h) / 2;
  } else {
    w = h * ar;
    x = o.x + (o.w - w) / 2;
  }
  return { x, y, w, h };
}
