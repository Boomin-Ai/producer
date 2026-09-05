// Render load: the number behind the stats panel's area chart.
//
// The engine reports a mean render time per frame (libobs's
// obs_get_average_frame_time_ns). Against the frame budget — 1e6/fps µs —
// that is RENDER PRESSURE in 0–100%: how close the graphics thread is to
// missing frames. It moves on an idle engine (per-frame jitter is real) and
// only sits still when the engine is stopped, which is what a health chart
// should do. Process CPU (what the chart plotted before) sat at ~2% and
// drew a flat line.
//
// Pure functions, no DOM: the server suite tests them.

export interface RenderLoadSample {
  /** Mean render time per frame, µs. 0 / absent = not reported. */
  render_time_us?: number | null;
  /** Canvas frame rate; the budget is 1e6/fps µs. */
  video_fps?: number | null;
  /** Frames the renderer skipped, cumulative. */
  skipped_frames?: number | null;
  /** Frames the renderer produced, cumulative. */
  total_frames?: number | null;
  /** Process CPU share, %. */
  cpu?: number | null;
}

export type RenderTone = "mint" | "amber" | "red";

/** Window of 1 Hz samples the chart keeps. */
export const RENDER_WINDOW = 60;
export const RENDER_AMBER_AT = 70;
export const RENDER_RED_AT = 90;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);

/**
 * Render pressure for one status tick, 0–100.
 *
 * Preferred: `render_time_us / frame_budget_us`. Fallback (no frame time,
 * e.g. an older engine): the share of frames skipped since the previous
 * sample, combined with process CPU — the larger of the two, so a machine
 * that is behind reads as behind even when CPU looks fine.
 */
export function renderPressure(
  now: RenderLoadSample | null | undefined,
  prev?: RenderLoadSample | null,
): number {
  if (!now) return 0;
  const fps = now.video_fps ?? 0;
  const rt = now.render_time_us ?? 0;
  if (rt > 0 && fps > 0) {
    const budget = 1e6 / fps;
    return clamp01((100 * rt) / budget);
  }
  const cpu = clamp01(now.cpu ?? 0);
  const dSkipped = (now.skipped_frames ?? 0) - (prev?.skipped_frames ?? 0);
  const dTotal = (now.total_frames ?? 0) - (prev?.total_frames ?? 0);
  // Expected = produced + skipped over the interval; no interval, no ratio.
  const expected = dTotal + dSkipped;
  const skipShare = expected > 0 && dSkipped > 0 ? clamp01((100 * dSkipped) / expected) : 0;
  return Math.max(cpu, skipShare);
}

/** Colour band for a pressure value. */
export function renderTone(pct: number): RenderTone {
  if (pct > RENDER_RED_AT) return "red";
  if (pct > RENDER_AMBER_AT) return "amber";
  return "mint";
}

/** Append a sample to a rolling window (returns a new array). */
export function pushSample(hist: readonly number[], v: number, window = RENDER_WINDOW): number[] {
  const next = hist.length >= window ? hist.slice(hist.length - window + 1) : hist.slice();
  next.push(clamp01(v));
  return next;
}

/**
 * The chart's vertical ceiling. The axis is nominally 0–100, but an idle
 * engine lives under 5% and a fixed 100% axis would flatten the very jitter
 * the chart exists to show: the ceiling follows the window's peak with
 * headroom, never below 5% and never above 100%.
 */
export function renderScale(hist: readonly number[]): number {
  let peak = 0;
  for (const v of hist) if (v > peak) peak = v;
  return Math.min(100, Math.max(5, Math.ceil((peak * 1.4) / 5) * 5));
}

/**
 * Monotone cubic (Fritsch–Carlson) interpolation through the window's
 * points, as SVG path data. `line` is the stroke; `area` closes it to the
 * baseline for the fill. The window is anchored right: the newest sample
 * sits at x = w, an unfilled window starts partway across.
 */
export function areaPath(
  hist: readonly number[],
  w: number,
  h: number,
  scale: number,
  window = RENDER_WINDOW,
): { line: string; area: string } {
  const n = hist.length;
  if (n === 0 || w <= 0 || h <= 0) return { line: "", area: "" };
  const inset = 1;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < n; k++) {
    xs.push(((window - n + k) / (window - 1)) * w);
    ys.push(h - inset - (Math.min(scale, hist[k]) / scale) * (h - 2 * inset));
  }
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  if (n === 1) {
    const line = `M${f(xs[0])},${f(ys[0])}`;
    return { line, area: `${line} L${f(xs[0])},${f(h)} Z` };
  }
  // Tangents.
  const d: number[] = [];
  for (let k = 0; k < n - 1; k++) d.push((ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]));
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
      continue;
    }
    const a = m[k] / d[k];
    const b = m[k + 1] / d[k];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[k] = t * a * d[k];
      m[k + 1] = t * b * d[k];
    }
  }
  let line = `M${f(xs[0])},${f(ys[0])}`;
  for (let k = 0; k < n - 1; k++) {
    const dx = xs[k + 1] - xs[k];
    line += ` C${f(xs[k] + dx / 3)},${f(ys[k] + (m[k] * dx) / 3)} ${f(xs[k + 1] - dx / 3)},${f(
      ys[k + 1] - (m[k + 1] * dx) / 3,
    )} ${f(xs[k + 1])},${f(ys[k + 1])}`;
  }
  const area = `${line} L${f(xs[n - 1])},${f(h)} L${f(xs[0])},${f(h)} Z`;
  return { line, area };
}
