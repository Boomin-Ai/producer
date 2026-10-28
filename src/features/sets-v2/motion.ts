import { finite, safeKey } from "./data";
export type MotionProperty =
  "x" | "y" | "width" | "height" | "opacity" | "rotation" | "scale" | "mask.progress";
export interface MotionTrack {
  target: string;
  property: MotionProperty;
  frames: Array<{ atMs: number; value: number }>;
  easing: "linear" | "easeInOut" | "easeOut";
  loop?: "repeat" | "pingpong";
}
export interface MotionClip {
  id: string;
  tracks: MotionTrack[];
}
const properties = [
  "x",
  "y",
  "width",
  "height",
  "opacity",
  "rotation",
  "scale",
  "mask.progress",
];
export function validateClip(clip: MotionClip): void {
  if (!safeKey(clip.id) || clip.tracks.length > 256)
    throw Error("Invalid motion clip");
  const keys = new Set<string>();
  for (const t of clip.tracks) {
    const key = t.target + ":" + t.property;
    if (
      !safeKey(t.target) ||
      !properties.includes(t.property) ||
      keys.has(key) ||
      !["linear", "easeInOut", "easeOut"].includes(t.easing) ||
      (t.loop !== undefined && !["repeat", "pingpong"].includes(t.loop)) ||
      t.frames.length < 2 ||
      t.frames.length > 64
    )
      throw Error("Invalid motion track");
    keys.add(key);
    let last = -1;
    for (const f of t.frames) {
      finite(f.atMs, 0, 60000);
      finite(f.value, -16384, 16384);
      if (f.atMs <= last || (last === -1 && f.atMs !== 0))
        throw Error("Keyframes must have increasing time starting at zero");
      if (t.property === "opacity" || t.property === "mask.progress") finite(f.value, 0, 1);
      if (["width", "height", "scale"].includes(t.property))
        finite(f.value, 0, 16384);
      last = f.atMs;
    }
  }
}
/** Time is supplied by the presentation clock; never driven by a UI interval. */
export function sampleTrack(track: MotionTrack, elapsedMs: number): number {
  finite(elapsedMs, 0, Number.MAX_SAFE_INTEGER);
  const duration = track.frames[track.frames.length - 1].atMs;
  let time = elapsedMs;
  if (track.loop === "repeat") time %= duration;
  if (track.loop === "pingpong") {
    time %= duration * 2;
    if (time > duration) time = duration * 2 - time;
  }
  if (time >= duration) return track.frames[track.frames.length - 1].value;
  const index = track.frames.findIndex((f, i) => i > 0 && f.atMs >= time);
  const a = track.frames[index - 1],
    b = track.frames[index];
  let p = (time - a.atMs) / (b.atMs - a.atMs);
  if (track.easing === "easeInOut") p = p * p * (3 - 2 * p);
  if (track.easing === "easeOut") p = 1 - (1 - p) * (1 - p);
  return a.value + (b.value - a.value) * p;
}
export function retarget(
  track: MotionTrack,
  elapsedMs: number,
  to: number,
  durationMs: number,
): MotionTrack {
  finite(durationMs, 1, 60000);
  const next: MotionTrack = {
    target: track.target,
    property: track.property,
    frames: [
      { atMs: 0, value: sampleTrack(track, elapsedMs) },
      { atMs: durationMs, value: to },
    ],
    easing: track.easing,
  };
  validateClip({ id: "retarget", tracks: [next] });
  return next;
}
export class PresentationClock {
  private position = 0;
  private anchor: number;
  private playing = false;
  constructor(private monotonicNow: () => number) {
    this.anchor = monotonicNow();
  }
  time(): number {
    return (
      this.position +
      (this.playing ? Math.max(0, this.monotonicNow() - this.anchor) : 0)
    );
  }
  play(): void {
    if (this.playing) return;
    this.anchor = this.monotonicNow();
    this.playing = true;
  }
  pause(): void {
    this.position = this.time();
    this.playing = false;
  }
  seek(ms: number): void {
    finite(ms, 0, Number.MAX_SAFE_INTEGER);
    this.position = ms;
    this.anchor = this.monotonicNow();
  }
}
