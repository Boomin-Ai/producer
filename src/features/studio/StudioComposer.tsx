import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import {
  createStudioMotionClip,
  STUDIO_MOTION_MAX_MS,
  studioSequenceDuration,
  STUDIO_MOTION_LABELS,
  STUDIO_MOTION_MIN_MS,
  type StudioMotionClip,
  type StudioMotionSequence,
  type StudioMotionTarget,
} from "./motion";
import "./StudioComposer.css";

export type StudioSubject = "window" | "canvas";
type MotionSubject = StudioSubject | "panel";

type StudioTimelineProps = {
  sequence: StudioMotionSequence;
  onChange: (sequence: StudioMotionSequence) => void;
  onPreview: (timeMs: number) => void;
  onPlay: (fromMs: number) => void | Promise<void>;
  onPause: (timeMs: number) => void;
  onClose?: () => void;
  bar?: boolean;
  onBarChange?: (bar: boolean) => void;
  error?: string;
  availableTargets: StudioMotionTarget[];
  initialTimeMs?: number;
  onTimeChange?: (timeMs: number) => void;
  playDisabled?: boolean;
  subject?: StudioSubject;
};

type ClipDrag = {
  mode: "move" | "start" | "end";
  pointerId: number;
  startX: number;
  laneWidth: number;
  clip: StudioMotionClip;
  playheadMs: number;
};


const minimumMs = STUDIO_MOTION_MIN_MS;
const trimStepMs = 50;
const snapDistanceMs = 100;

const subjects = ["window", "canvas"] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clipEnd(clip: StudioMotionClip): number {
  return clip.startMs + clip.durationMs;
}

function timeLabel(ms: number): string {
  const tenths = Math.round(ms / 100);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}

function clipCenter(clip: StudioMotionClip): number {
  return clip.startMs + Math.round(clip.durationMs / 2);
}

function motionName(target: StudioMotionTarget): string {
  if (target === "window") return "Window sweep";
  if (target === "canvas") return "Canvas sweep";
  return `${STUDIO_MOTION_LABELS[target]} lift`;
}

function subjectFor(target: StudioMotionTarget): MotionSubject {
  return target === "window" || target === "canvas" ? target : "panel";
}

function clipBounds(clips: StudioMotionClip[], index: number, durationMs: number): [number, number] {
  return [index === 0 ? 0 : clipEnd(clips[index - 1]), clips[index + 1]?.startMs ?? durationMs];
}

function insertionAt(clips: StudioMotionClip[], timeMs: number, durationMs: number): [number, number] | null {
  let previousEnd = 0;
  return [...clips.map(clip => ({ start: clip.startMs, end: clipEnd(clip) })), { start: durationMs, end: durationMs }]
    .map(({ start, end }): [number, number] => {
      const gap = [previousEnd, start] as [number, number];
      previousEnd = end;
      return gap;
    })
    .filter(([left, right]) => right - left >= minimumMs)
    .map(([left, right]): [number, number] => {
      const length = Math.min(1800, right - left);
      return [clamp(Math.round(timeMs / trimStepMs) * trimStepMs, left, right - length), length];
    })
    .sort((a, b) => Math.abs(a[0] - timeMs) - Math.abs(b[0] - timeMs))[0] ?? null;
}

function adjustedClip(original: StudioMotionClip, mode: ClipDrag["mode"], delta: number, bounds: [number, number], snap = false): StudioMotionClip {
  const finish = clipEnd(original);
  const [left, right] = bounds;
  const position = (value: number, min: number, max: number) => {
    if (snap && Math.abs(value - min) < snapDistanceMs) return min;
    if (snap && Math.abs(value - max) < snapDistanceMs) return max;
    return clamp(value, min, max);
  };
  if (mode === "move") {
    return { ...original, startMs: position(original.startMs + delta, left, right - original.durationMs) };
  }
  const startMs = mode === "start" ? position(original.startMs + delta, left, finish - minimumMs) : original.startMs;
  const endMs = mode === "end" ? position(finish + delta, startMs + minimumMs, right) : finish;
  return { ...original, startMs, durationMs: endMs - startMs };
}

function Icon({ name }: { name: MotionSubject | "play" | "pause" | "start" | "add" | "remove" }) {
  const paths = {
    window: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/></>,
    panel: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M14 5v14m3-9h1m-1 4h1"/></>,
    canvas: <><path d="M9 4H4v5m11-5h5v5m0 6v5h-5m-6 0H4v-5"/><rect x="8" y="8" width="8" height="8" rx="1"/></>,
    play: <path d="M8 5.5v13l11-6.5Z" fill="currentColor" stroke="none"/>,
    pause: <path d="M9 5.5v13m6-13v13" strokeWidth="2.5"/>,
    start: <><path d="M6 6v12"/><path d="m18 6-9 6 9 6Z" fill="currentColor" stroke="none"/></>,
    add: <path d="M12 5v14M5 12h14"/>,
    remove: <><path d="M4 7h16m-13 0 1 13h8l1-13M9 7V4h6v3m-4 4v5m2-5v5"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function MotionSlider({ label, min, max, step, value, valueText, onChange }: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  valueText: string;
  onChange: (value: number) => void;
}) {
  return <label className="studio-composer-slider">
    <span>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} aria-valuetext={valueText}
      style={{ "--slider-fill": `${(value - min) / (max - min) * 100}%` } as CSSProperties}
      onChange={event => onChange(event.currentTarget.valueAsNumber)}/>
  </label>;
}

export function StudioTimeline({
  sequence, onChange, onPreview, onPlay, onPause, onClose, error,
  availableTargets, initialTimeMs = 0, onTimeChange, playDisabled, subject, bar, onBarChange,
}: StudioTimelineProps) {
  const durationMs = studioSequenceDuration(sequence);
  const rulerMarks = Array.from({ length: 9 }, (_, index) => index * durationMs / 8);
  const sourceDrag = useRef<{x:number; width:number; right:number; pointer:number; requested:number; tick:number; timer:ReturnType<typeof setInterval>} | null>(null);
  useEffect(() => () => { if(sourceDrag.current) clearInterval(sourceDrag.current.timer); }, []);
  const inspectorId = useId();
  const addMenuId = useId();
  const [timeMs, setTimeMs] = useState(() => clamp(Math.round(initialTimeMs), 0, durationMs));
  const [selectedId, setSelectedId] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const currentTime = useRef(timeMs);
  const playback = useRef<symbol | null>(null);
  const animation = useRef<number | null>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const addMenu = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<ClipDrag | null>(null);
  const clips = [...sequence.clips].sort((a, b) => a.startMs - b.startMs);
  const selected = clips.find(clip => clip.id === selectedId);
  const canAdd = clips.length < 10 && clips.length * minimumMs < durationMs && insertionAt(clips, 0, durationMs) !== null && availableTargets.length > 0;
  const panelTargets = availableTargets.filter(target => subjectFor(target) === "panel");

  useEffect(() => () => {
    playback.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
  }, []);

  useEffect(() => {
    if (!addOpen) return;
    addMenu.current?.querySelector<HTMLButtonElement>(".studio-composer-add-options button")?.focus();
    const dismiss = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !addMenu.current?.contains(event.target)) setAddOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [addOpen]);

  function updatePlayhead(next: number) {
    currentTime.current = next;
    setTimeMs(next);
    onTimeChange?.(next);
  }

  function pauseAt(next: number) {
    playback.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    setPlaying(false);
    updatePlayhead(next);
    onPause(next);
  }

  function seek(next: number) {
    if (playback.current !== null) {
      pauseAt(next);
      return;
    }
    updatePlayhead(next);
    onPreview(next);
  }

  async function togglePlay() {
    if (playback.current !== null) {
      pauseAt(currentTime.current);
      return;
    }
    const start = currentTime.current >= durationMs ? 0 : currentTime.current;
    const run = Symbol();
    playback.current = run;
    updatePlayhead(start);
    setPlaying(true);
    try {
      await onPlay(start);
    } catch {
      if (playback.current === run) {
        playback.current = null;
        setPlaying(false);
      }
      return;
    }
    if (playback.current !== run) return;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const next = Math.min(durationMs, Math.round(start + now - startedAt));
      if (next >= durationMs) {
        pauseAt(durationMs);
        return;
      }
      if (next - currentTime.current >= 30) updatePlayhead(next);
      animation.current = requestAnimationFrame(tick);
    };
    animation.current = requestAnimationFrame(tick);
  }

  function selectClip(clip: StudioMotionClip) {
    setSelectedId(clip.id);
    const playhead = currentTime.current;
    if (playhead <= clip.startMs || playhead >= clipEnd(clip)) seek(clipCenter(clip));
  }

  function updateClip(clip: StudioMotionClip, at: number) {
    onChange({ ...sequence, clips: clips.map(item => item.id === clip.id ? clip : item) });
    seek(at);
  }

  function editClip(clip: StudioMotionClip, changes: Partial<StudioMotionClip>) {
    const next = { ...clip, ...changes };
    updateClip(next, clipCenter(next));
  }

  function addClip(target: StudioMotionTarget) {
    const gap = insertionAt(clips, currentTime.current, durationMs);
    if (!gap) return;
    const [start, length] = gap;
    const clip = createStudioMotionClip(target, start, length);
    setAddOpen(false);
    setSelectedId(clip.id);
    onChange({ ...sequence, clips: [...clips, clip].sort((a, b) => a.startMs - b.startMs) });
    seek(clipCenter(clip));
    addButton.current?.focus();
  }

  function removeClip(clip: StudioMotionClip) {
    onChange({ ...sequence, clips: clips.filter(item => item.id !== clip.id) });
    setSelectedId(undefined);
    seek(currentTime.current);
    addButton.current?.focus();
  }

  function beginDrag(event: PointerEvent<HTMLButtonElement>, clip: StudioMotionClip, mode: ClipDrag["mode"]) {
    if (event.button !== 0 || !event.isPrimary || drag.current || !timeline.current) return;
    const laneWidth = timeline.current.getBoundingClientRect().width;
    if (laneWidth <= 0) return;
    if (playback.current !== null) pauseAt(currentTime.current);
    drag.current = { clip, mode, laneWidth, pointerId: event.pointerId, startX: event.clientX, playheadMs: currentTime.current };
    setSelectedId(clip.id);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>, clip: StudioMotionClip) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = Math.round((event.clientX - active.startX) / active.laneWidth * durationMs / trimStepMs) * trimStepMs;
    const next = adjustedClip(active.clip, active.mode, delta, clipBounds(clips, clips.indexOf(clip), durationMs), delta !== 0);
    if (next.startMs === clip.startMs && next.durationMs === clip.durationMs) return;
    updateClip(next, active.mode === "move" ? clipCenter(next) : active.mode === "start" ? next.startMs : clipEnd(next));
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>, canceled = false) {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (canceled) updateClip(active.clip, active.playheadMs);
  }

  function clipKey(event: KeyboardEvent<HTMLButtonElement>, clip: StudioMotionClip, mode: ClipDrag["mode"]) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = (event.shiftKey ? 5 : 1) * trimStepMs * (event.key === "ArrowLeft" ? -1 : 1);
      const next = adjustedClip(clip, mode, step, clipBounds(clips, clips.indexOf(clip), durationMs));
      setSelectedId(clip.id);
      if (next.startMs === clip.startMs && next.durationMs === clip.durationMs) return;
      updateClip(next, mode === "move" ? clipCenter(next) : mode === "start" ? next.startMs : clipEnd(next));
    } else if ((event.key === "Delete" || event.key === "Backspace") && mode === "move") {
      event.preventDefault();
      removeClip(clip);
    }
  }

  function handleEscape(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    if (!drag.current && !addOpen && !selected && playback.current === null && !onClose) return;
    event.stopPropagation();
    if (drag.current) {
      const active = drag.current;
      drag.current = null;
      if (event.target instanceof HTMLElement && event.target.hasPointerCapture(active.pointerId)) event.target.releasePointerCapture(active.pointerId);
      updateClip(active.clip, active.playheadMs);
    } else if (addOpen) {
      setAddOpen(false);
      addButton.current?.focus();
    } else if (selected) {
      selectedButton.current?.focus();
      setSelectedId(undefined);
    } else {
      if (playback.current !== null) pauseAt(currentTime.current);
      onClose?.();
    }
  }

  function resizeSource(requested: number) {
    const minimum = Math.max(minimumMs, ...clips.map(clipEnd));
    const next = clamp(Math.round(requested / 100) * 100, minimum, STUDIO_MOTION_MAX_MS);
    if (playback.current !== null) pauseAt(Math.min(currentTime.current, next));
    if (currentTime.current > next) seek(next);
    onChange({ ...sequence, durationMs: next });
  }

  const playheadPosition = `${timeMs / durationMs * 100}%`;
  const sourceLabel = subject === "canvas" ? "Program canvas" : "Producer window";

  return <section className="studio-composer" aria-label="Motion timeline" onKeyDown={handleEscape}>
    {error && <p className="studio-composer-error" role="alert" title={error}>{error}</p>}
    <div className="studio-composer-timeline">
      <div className="studio-composer-toolbar">
        <div className="studio-composer-playback" role="group" aria-label="Preview playback">
          <button type="button" className="studio-composer-icon-button" title="Go to start" aria-label="Go to start" onClick={() => seek(0)}><Icon name="start"/></button>
          <button type="button" className="studio-composer-play" disabled={playDisabled && !playing}
            onClick={togglePlay}><Icon name={playing ? "pause" : "play"}/>{playing ? "Pause" : "Play"}</button>
          {onBarChange && <button type="button" role="switch" aria-label="Studio timeline bar" aria-checked={!!bar} title={bar ? "Return Timeline to its dock" : "Move Timeline to its own Studio bar"} className="studio-composer-placement" onClick={() => { if (playback.current !== null) pauseAt(currentTime.current); onBarChange(!bar); }}>{bar ? "Studio bar" : "Docked"}<span aria-hidden="true">{bar ? "▰" : "▤"}</span></button>}
          <span className="studio-composer-clock"><strong>{timeLabel(timeMs)}</strong> / {timeLabel(durationMs)}</span>
        </div>
        {selected && <section className="studio-composer-inspector" aria-labelledby={inspectorId}>
          <h2 id={inspectorId} className="studio-composer-selection">
            <span className="studio-composer-target-icon"><Icon name={subjectFor(selected.target)}/></span>
            <span title={motionName(selected.target)}>{motionName(selected.target)}</span>
          </h2>
          <label className="studio-composer-target"><span>Target</span>
            <select value={selected.target} onChange={event => editClip(selected, { target: event.currentTarget.value as StudioMotionTarget })}>
              {!availableTargets.includes(selected.target) && <option disabled value={selected.target}>{STUDIO_MOTION_LABELS[selected.target]} unavailable</option>}
              {subjects.filter(target => availableTargets.includes(target)).map(target =>
                <option key={target} value={target}>{STUDIO_MOTION_LABELS[target]}</option>
              )}
              {panelTargets.length > 0 && <optgroup label="Panel">
                {panelTargets.map(target => <option key={target} value={target}>{STUDIO_MOTION_LABELS[target]}</option>)}
              </optgroup>}
            </select>
          </label>
          <div className="studio-composer-sliders">
            {subjectFor(selected.target) !== "panel" ? <>
              <MotionSlider label="Close-up" min={1.25} max={2.15} step={0.01} value={selected.zoom} valueText={`${Math.round(selected.zoom * 100)} percent`}
                onChange={zoom => editClip(selected, { zoom })}/>
              <MotionSlider label="Angle" min={-22} max={22} step={1} value={selected.angle} valueText={`${selected.angle} degrees`}
                onChange={angle => editClip(selected, { angle })}/>
            </> : <MotionSlider label="Lift" min={0} max={1} step={0.01} value={selected.lift} valueText={`${Math.round(selected.lift * 100)} percent`}
              onChange={lift => editClip(selected, { lift })}/>}
            <MotionSlider label="Transition" min={200} max={1400} step={50} value={selected.transitionMs}
              valueText={`${selected.transitionMs / 1000} seconds`} onChange={transitionMs => editClip(selected, { transitionMs })}/>
          </div>
          <div className="studio-composer-ending">
            <span>Ends with</span>
            <div className="studio-composer-segmented" role="group" aria-label="Motion ending">
              <button type="button" aria-pressed={selected.ending === "return"} title="Ease back to the original framing"
                onClick={() => editClip(selected, { ending: "return" })}>Return</button>
              <button type="button" aria-pressed={selected.ending === "flow"} title="Blend into the next touching clip"
                onClick={() => editClip(selected, { ending: "flow" })}>Flow into next</button>
            </div>
          </div>
          <button type="button" className="studio-composer-icon-button studio-composer-remove" title="Remove motion" aria-label="Remove selected motion"
            onClick={() => removeClip(selected)}><Icon name="remove"/></button>
        </section>}
        <div className="studio-composer-add" ref={addMenu}>
          <button ref={addButton} type="button" aria-expanded={addOpen} aria-controls={addOpen ? addMenuId : undefined} disabled={!canAdd}
            onClick={() => setAddOpen(open => !open)}><Icon name="add"/> Motion</button>
          {addOpen && <div className="studio-composer-add-options" id={addMenuId} role="group" aria-label="Add a motion">
            {availableTargets.map(target => <button type="button" key={target} onClick={() => addClip(target)}>
              <Icon name={subjectFor(target)}/>{motionName(target)}
            </button>)}
          </div>}
        </div>
      </div>

      <div className="studio-composer-track-grid">
        <div className="studio-composer-track-names" aria-hidden="true"><span/><span>Motion</span><span>Source</span></div>
        <div className="studio-composer-tracks" style={{ "--playhead-position": playheadPosition } as CSSProperties}>
          <div className="studio-composer-ruler">
            <div className="studio-composer-ruler-labels" aria-hidden="true">{rulerMarks.map(ms => <span key={ms}>{Number((ms / 1000).toFixed(1))}s</span>)}</div>
            <input type="range" min={0} max={durationMs} step={1} value={timeMs} aria-label="Timeline playhead"
              aria-valuetext={`${(timeMs / 1000).toFixed(2)} seconds`} onChange={event => seek(event.currentTarget.valueAsNumber)}/>
          </div>
          <div className="studio-composer-motion-lane" role="group" aria-label="Motion clips" ref={timeline}
            onClick={event => { if (event.target === event.currentTarget) setSelectedId(undefined); }}>
            {clips.map((clip, index) => {
              const isSelected = clip.id === selected?.id;
              const touchesNext = clip.ending === "flow" && clips[index + 1]?.startMs === clipEnd(clip);
              const label = motionName(clip.target);
              const pointerHandlers = (mode: ClipDrag["mode"]) => ({
                onPointerDown: (event: PointerEvent<HTMLButtonElement>) => beginDrag(event, clip, mode),
                onPointerMove: (event: PointerEvent<HTMLButtonElement>) => moveDrag(event, clip),
                onPointerUp: finishDrag,
                onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => finishDrag(event, true),
                onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => clipKey(event, clip, mode),
              });
              const clipSubject = subjectFor(clip.target);
              return <div className="studio-composer-clip" key={clip.id} data-selected={isSelected} data-kind={clipSubject === "panel" ? "lift" : "sweep"}
                style={{ left: `${clip.startMs / durationMs * 100}%`, width: `${clip.durationMs / durationMs * 100}%` }}>
                <button type="button" className="studio-composer-trim" data-edge="start" aria-label={`Trim ${label} start`}
                  title={`Trim start · ${timeLabel(clip.startMs)}`} {...pointerHandlers("start")}/>
                <button type="button" className="studio-composer-clip-button" aria-pressed={isSelected} title={label} aria-label={label}
                  ref={isSelected ? selectedButton : undefined}
                  {...pointerHandlers("move")} onClick={() => selectClip(clip)}><Icon name={clipSubject}/><span>{label}</span></button>
                <button type="button" className="studio-composer-trim" data-edge="end" aria-label={`Trim ${label} end`}
                  title={`Trim end · ${timeLabel(clipEnd(clip))}`} {...pointerHandlers("end")}/>
                {touchesNext && <span className="studio-composer-joint" aria-hidden="true"/>}
              </div>;
            })}
          </div>
          <div className="studio-composer-source-lane"><Icon name={subject ?? "window"}/>{sourceLabel}
            <button type="button" className="studio-composer-source-end" aria-label="Resize source duration" title="Drag to extend timeline · maximum 1 minute"
              onPointerDown={event => {
                event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
                const bounds=timeline.current?.getBoundingClientRect();
                if(sourceDrag.current)clearInterval(sourceDrag.current.timer);
                const timer=setInterval(()=>{
                  const drag=sourceDrag.current;if(!drag)return;
                  const now=performance.now(),elapsed=Math.min(200,now-drag.tick);drag.tick=now;
                  if(drag.pointer>=drag.right-24 && drag.requested<STUDIO_MOTION_MAX_MS){
                    drag.requested=Math.min(STUDIO_MOTION_MAX_MS,drag.requested+elapsed*16);
                    resizeSource(drag.requested);
                  }
                },100);
                sourceDrag.current={x:event.clientX,width:bounds?.width??1,right:bounds?.right??event.clientX,pointer:event.clientX,requested:durationMs,tick:performance.now(),timer};
              }}
              onPointerMove={event => { const drag=sourceDrag.current;if(drag){drag.pointer=event.clientX;drag.requested=clamp(drag.requested+(event.clientX-drag.x)/drag.width*STUDIO_MOTION_MAX_MS,minimumMs,STUDIO_MOTION_MAX_MS);drag.x=event.clientX;resizeSource(drag.requested);} }}
              onPointerUp={event => { if(sourceDrag.current)clearInterval(sourceDrag.current.timer);sourceDrag.current = null; if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
              onPointerCancel={() => { if(sourceDrag.current)clearInterval(sourceDrag.current.timer);sourceDrag.current = null; }}
              onLostPointerCapture={() => { if(sourceDrag.current)clearInterval(sourceDrag.current.timer);sourceDrag.current = null; }}
              onKeyDown={event => { if(['ArrowRight','ArrowLeft','End'].includes(event.key)){event.preventDefault();resizeSource(event.key==='End'?STUDIO_MOTION_MAX_MS:durationMs+(event.key==='ArrowRight'?1000:-1000));} }}/>
          </div>
          <div className="studio-composer-playline" aria-hidden="true"/>
        </div>
      </div>
    </div>
  </section>;
}
