import type { StudioSpotlightRect } from "../../lib/ipc";

export const STUDIO_MOTION_DURATION_MS = 8000;
export const STUDIO_MOTION_MAX_MS = 60_000;
export const studioSequenceDuration = (sequence: StudioMotionSequence): number => sequence.durationMs ?? STUDIO_MOTION_DURATION_MS;
export const STUDIO_MOTION_MIN_MS = 800;
export const STUDIO_MOTION_LABELS = {
  window: "Producer window",
  canvas: "Canvas",
  setControls: "Set Controls",
  assistant: "Room Assistant",
} as const;

export type StudioMotionTarget = keyof typeof STUDIO_MOTION_LABELS;
export type StudioPanelTarget = Exclude<StudioMotionTarget, "window" | "canvas">;
export const isStudioPanelTarget = (target: StudioMotionTarget): target is StudioPanelTarget =>
  target === "setControls" || target === "assistant";
export interface StudioMotionClip {
  id: string;
  target: StudioMotionTarget;
  startMs: number;
  durationMs: number;
  transitionMs: number;
  lift: number;
  zoom: number;
  angle: number;
  ending: "return" | "flow";
}
export interface StudioMotionSequence { clips: StudioMotionClip[]; durationMs?: number }
export interface StudioMotionPose {
  panel: StudioSpotlightRect | null;
  lift: number;
  floating: number;
  canvasMix: number;
  zoom: number;
  panX: number;
  panY: number;
  yaw: number;
  pitch: number;
  roll: number;
}
export type StudioMotionKeyframe = StudioMotionPose & { atMs: number };
export type StudioMotionBounds = Partial<Record<StudioPanelTarget, StudioSpotlightRect>>;
export interface StudioMotionDraft {
  revision: number;
  sequence: StudioMotionSequence;
}

export function createStudioMotionClip(target: StudioMotionTarget, startMs: number, durationMs: number): StudioMotionClip {
  return { id: crypto.randomUUID(), target, startMs, durationMs, transitionMs: 650, lift: .72, zoom: 1.85, angle: -16, ending: "return" };
}

export function sampleStudioMotion(targets: readonly StudioMotionTarget[]): StudioMotionSequence {
  const intro = targets.includes("setControls") ? createStudioMotionClip("setControls", 350, 1450) : null;
  const sweep = createStudioMotionClip("window", intro ? 1800 : 650, 3500);
  const outroTarget = targets.includes("assistant") ? "assistant" : null;
  const outro = outroTarget ? createStudioMotionClip(outroTarget, sweep.startMs + sweep.durationMs, 1700) : null;
  if (intro) intro.ending = "flow";
  if (outro) sweep.ending = "flow";
  return { clips: [...(intro ? [intro] : []), sweep, ...(outro ? [outro] : [])] };
}

function bounded(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

export function validateStudioMotion(value: unknown): StudioMotionSequence {
  const raw = value as Partial<StudioMotionSequence> | null;
  const duration = bounded(raw?.durationMs ?? STUDIO_MOTION_DURATION_MS, STUDIO_MOTION_MIN_MS, STUDIO_MOTION_MAX_MS, "Source duration");
  if (!Number.isInteger(duration)) throw new Error("Use whole milliseconds.");
  const clips = raw?.clips;
  if (!Array.isArray(clips) || clips.length > STUDIO_MOTION_DURATION_MS / STUDIO_MOTION_MIN_MS) {
    throw new Error("Expected a motion sequence with up to ten clips.");
  }
  const ids = new Set<string>();
  const sorted = clips.map((clip): StudioMotionClip => {
    if (!clip || typeof clip !== "object" || !Object.prototype.hasOwnProperty.call(STUDIO_MOTION_LABELS, clip.target)) {
      throw new Error("Choose a Window, Canvas or available Panel target.");
    }
    if (typeof clip.id !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(clip.id) || ids.has(clip.id)) {
      throw new Error("Each motion clip needs a unique ID.");
    }
    ids.add(clip.id);
    if (clip.ending !== "return" && clip.ending !== "flow") throw new Error("Choose Return or Flow.");
    const startMs = bounded(clip.startMs, 0, duration - STUDIO_MOTION_MIN_MS, "Clip start");
    const durationMs = bounded(clip.durationMs, STUDIO_MOTION_MIN_MS, duration - startMs, "Clip duration");
    const transitionMs = bounded(clip.transitionMs, 200, 1400, "Transition");
    if (![startMs, durationMs, transitionMs].every(Number.isInteger)) throw new Error("Use whole milliseconds.");
    return {
      id: clip.id, target: clip.target, startMs, durationMs, transitionMs, ending: clip.ending,
      lift: bounded(clip.lift, 0, 1, "Lift"), zoom: bounded(clip.zoom, 1.25, 2.15, "Close-up"), angle: bounded(clip.angle, -22, 22, "Angle"),
    };
  }).sort((a, b) => a.startMs - b.startMs);
  if (sorted.some((clip, i) => i > 0 && endOf(sorted[i - 1]) > clip.startMs)) throw new Error("Motion clips cannot overlap.");
  return { clips: sorted, ...(raw?.durationMs !== undefined ? { durationMs: duration } : {}) };
}

const endOf = (clip: StudioMotionClip) => clip.startMs + clip.durationMs;
const rampFor = (clip: StudioMotionClip) => Math.min(clip.transitionMs, clip.durationMs * .42);
const smooth = (ratio: number) => {
  const t = Math.max(0, Math.min(1, ratio));
  return t * t * (3 - 2 * t);
};
const neutral = (): StudioMotionPose => ({
  panel: null, lift: 0, floating: 0, canvasMix: 0, zoom: 1, panX: 0, panY: 0, yaw: 0, pitch: 0, roll: 0,
});

function addPose(pose: StudioMotionPose, clip: StudioMotionClip, bounds: StudioMotionBounds, weight: number, progress: number) {
  if (!isStudioPanelTarget(clip.target)) {
    const pan = 2 * smooth(progress) - 1;
    if (clip.target === "canvas") pose.canvasMix += weight;
    pose.floating += weight;
    pose.zoom += weight * (clip.zoom - 1);
    pose.panX += weight * clip.zoom * .19 * pan;
    pose.panY += weight * .07 * pan;
    pose.yaw -= weight * .14 * pan;
    pose.pitch += weight * (.17 + .045 * pan);
    pose.roll += weight * (clip.angle * Math.PI / 180 + .015 * pan);
  } else if (bounds[clip.target] && weight > 0) {
    pose.panel = bounds[clip.target]!;
    pose.lift = weight * clip.lift;
  }
}

export function studioMotionPose(sequence: StudioMotionSequence, timeMs: number, bounds: StudioMotionBounds): StudioMotionPose {
  const pose = neutral();
  const index = sequence.clips.findIndex(clip => timeMs >= clip.startMs && timeMs < endOf(clip));
  if (index < 0) return pose;
  const clip = sequence.clips[index];
  const previous = sequence.clips[index - 1];
  const incoming = previous?.ending === "flow" && endOf(previous) === clip.startMs;
  const outgoing = clip.ending === "flow" && sequence.clips[index + 1]?.startMs === endOf(clip);
  const elapsed = timeMs - clip.startMs;
  const progress = elapsed / clip.durationMs;
  const ramp = rampFor(clip);
  const rise = smooth(elapsed / ramp);
  const fall = outgoing ? 1 : smooth((clip.durationMs - elapsed) / ramp);
  const distinctPanels = incoming && isStudioPanelTarget(previous.target)
    && isStudioPanelTarget(clip.target) && previous.target !== clip.target;
  if (distinctPanels && elapsed < ramp) {
    // The native frame carries one crop. Lower the old panel, then lift the new one.
    if (elapsed < ramp / 2) addPose(pose, previous, bounds, 1 - smooth(elapsed / (ramp / 2)), 1);
    else addPose(pose, clip, bounds, smooth((elapsed - ramp / 2) / (ramp / 2)) * fall, progress);
  } else if (incoming && previous.target === clip.target && isStudioPanelTarget(clip.target)) {
    const panel = bounds[clip.target];
    if (panel) {
      pose.panel = panel;
      pose.lift = (1 - rise) * previous.lift + rise * fall * clip.lift;
    }
  } else {
    if (incoming) addPose(pose, previous, bounds, 1 - rise, 1);
    addPose(pose, clip, bounds, rise * fall, progress);
  }
  return pose;
}

export function studioMotionKeyframes(sequence: StudioMotionSequence, fromMs: number, bounds: StudioMotionBounds): StudioMotionKeyframe[] {
  const duration = studioSequenceDuration(sequence);
  const start = Math.max(0, Math.min(Math.round(fromMs), duration - 1));
  const samples = new Set([start, duration]);
  for (let time = start + 56; time < duration; time += 56) samples.add(time);
  for (const clip of sequence.clips) {
    // Keep discontinuities in panel identity on neutral, sampled boundaries.
    for (const boundary of [clip.startMs, endOf(clip), clip.startMs + Math.round(rampFor(clip) / 2)]) {
      if (boundary > start) samples.add(boundary);
    }
  }
  return [...samples].sort((a, b) => a - b).map(time => ({
    atMs: time - start,
    ...studioMotionPose(sequence, time, bounds),
  }));
}
