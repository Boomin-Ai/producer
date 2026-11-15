import { useLayoutEffect, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import {
  isStudioPanelTarget, sampleStudioMotion, studioMotionKeyframes, validateStudioMotion,
  studioMotionPose, studioSequenceDuration, STUDIO_MOTION_MAX_MS,
  STUDIO_MOTION_LABELS, STUDIO_MOTION_MIN_MS,
  type StudioMotionBounds, type StudioMotionDraft, type StudioMotionTarget,
} from "./motion";
import { visiblePanelRect } from "./useStudioSpotlight";

const panelTargets = ["setControls", "assistant"] as const;
type StudioSubject = "window" | "canvas";

function motionBounds(): StudioMotionBounds {
  const bounds: StudioMotionBounds = {};
  for (const target of panelTargets) {
    const panel = document.querySelector<HTMLElement>(`[data-panel="${target}"]`);
    if (!panel?.parentElement || panel.getClientRects().length === 0 || panel.getBoundingClientRect().height < 15) continue;
    const rect = visiblePanelRect(panel, panel.parentElement);
    if (rect && rect.w > .01 && rect.h > .015) bounds[target] = rect;
  }
  return bounds;
}

const targetsFor = (bounds = motionBounds()): StudioMotionTarget[] =>
  ["window", "canvas", ...panelTargets.filter(target => !!bounds[target])];

const empty = (): StudioMotionDraft => ({ revision: 0, sequence: { clips: [] } });
function readDraft(key: string): StudioMotionDraft {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return empty();
    const { revision, sequence } = JSON.parse(raw);
    if (!Number.isSafeInteger(revision) || revision < 0) return empty();
    return { revision, sequence: validateStudioMotion(sequence) };
  } catch { return empty(); }
}

const messageFor = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useStudioComposer({ scope, mayAuthor, studioOn, timelineOpen, timelineDock, timelineBar, availableTargets, onError }: {
  scope: string;
  mayAuthor: boolean;
  studioOn: boolean;
  timelineOpen: boolean;
  timelineDock: "top" | "bottom" | "left" | "right" | "hidden";
  timelineBar: boolean;
  availableTargets: StudioMotionTarget[];
  onError(message: string): void;
}) {
  const key = "producer.studio.motion/1:" + scope;
  const draft = useRef<{ key: string; data: StudioMotionDraft }>(null);
  if (draft.current?.key !== key) draft.current = { key, data: readDraft(key) };
  const [, refreshDraft] = useState(0);
  const queue = useRef(Promise.resolve());
  const mounted = useRef(false);
  const room = useRef({ key, mayAuthor, studioOn });
  if (room.current.key !== key || room.current.mayAuthor !== mayAuthor || room.current.studioOn !== studioOn) {
    room.current = { key, mayAuthor, studioOn };
  }
  const owner = room.current;
  const [source, setSource] = useState<{ owner: typeof owner; subject: StudioSubject } | null>(null);
  const subject = source?.owner === owner ? source.subject : "window";
  const [subjectBusy, setSubjectBusy] = useState(false);
  const subjectFlight = useRef(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const [timelineOwner, setTimelineOwner] = useState<{ owner: typeof owner; dock: typeof timelineDock; open: boolean; bar: boolean } | null>(null);
  const timelineEnabled = mayAuthor && studioOn;
  const timelineVisible = timelineOwner?.owner === owner && timelineOwner.dock === timelineDock && timelineOwner.open === timelineOpen && timelineOwner.bar === timelineBar && timelineEnabled && timelineOpen;
  const [timelineError, setTimelineError] = useState("");
  const pendingScrub = useRef<{ owner: typeof owner; timeMs: number } | null>(null);
  const scrubQueued = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const stillOwnsOutput = () => mounted.current && room.current === owner && owner.mayAuthor && owner.studioOn;
  const enqueue = (action: () => Promise<void>) => {
    const run = queue.current.then(async () => {
      if (!stillOwnsOutput()) throw new Error("Enable Studio in the current host room first.");
      await action();
    });
    queue.current = run.catch(() => {});
    return run;
  };

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    const dock = timeline?.closest<HTMLElement>("[data-studio-timeline-region], [data-dock]");
    const footer = footerRef.current;
    if (!timelineEnabled || !timeline || !dock || !footer) return;

    let canceled = false;
    let applying = false;
    let requested: { x: number; y: number; w: number; h: number } | null = null;
    let previous = "";
    setTimelineError("");
    const syncCrop = async () => {
      if (applying) return;
      applying = true;
      try {
        while (!canceled && requested) {
          const crop = requested;
          requested = null;
          if (JSON.stringify(crop) === previous) continue;
          await enqueue(async () => {
            if (canceled) return;
            await ipc.liveSetStudioRoomCrop(crop);
            if (canceled || !stillOwnsOutput()) return;
            previous = JSON.stringify(crop);
            setTimelineOwner({ owner, dock: timelineDock, open: timelineOpen, bar: timelineBar });
          });
        }
      } catch (error) {
        if (!canceled && stillOwnsOutput()) onError(messageFor(error));
      } finally { applying = false; }
    };
    const measure = () => {
      const height = window.innerHeight;
      if (height <= 0) return;
      const rect = dock.getBoundingClientRect();
      // Docked Timeline is part of the presented workspace. Only the separate
      // authoring bar stays outside capture, along with the application footer.
      const top = 0;
      const bottom = timelineBar && timelineOpen
        ? Math.floor(rect.top) / height : Math.floor(footer.getBoundingClientRect().top) / height;
      if (bottom - top < .25) return;
      requested = { x: 0, y: top, w: 1, h: bottom - top };
      void syncCrop();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    observer.observe(footer);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      canceled = true;
      observer.disconnect();
      window.removeEventListener("resize", measure);
      // The next crop request is serialized behind this one. When the panel
      // unmounts entirely, restore capture after a fresh native window frame.
      void enqueue(async () => { await ipc.liveSetStudioRoomCrop(null); }).catch(() => {});
    };
  }, [owner, timelineOpen, timelineDock, timelineBar]);

  const author = (sequence: unknown, revision: unknown) => {
    if (!mounted.current || room.current !== owner || !owner.mayAuthor) throw new Error("Open this room as host to edit Studio motion.");
    const current = draft.current!.data;
    if (revision !== current.revision) throw new Error("The Studio draft changed. Inspect it again before replacing it.");
    const data = { revision: current.revision + 1, sequence: validateStudioMotion(sequence) };
    localStorage.setItem(key, JSON.stringify(data));
    draft.current = { key, data };
    refreshDraft(data.revision);
    return { ...data, outputChanged: false };
  };

  const inspect = () => ({
    supported: mayAuthor,
    studioOn,
    timelineVisible,
    subject,
    ...draft.current!.data,
    availableTargets: targetsFor(),
    labels: STUDIO_MOTION_LABELS,
    durationMs: studioSequenceDuration(draft.current!.data.sequence),
    maximumDurationMs: STUDIO_MOTION_MAX_MS,
    minimumDurationMs: STUDIO_MOTION_MIN_MS,
  });

  const play = (timeMs = 0) => enqueue(async () => {
    const bounds = motionBounds();
    const current = draft.current!.data;
    const sequence = current.revision === 0 ? sampleStudioMotion(availableTargets) : current.sequence;
    const missing = subject === "window" && sequence.clips.find(({ target }) => isStudioPanelTarget(target) && !bounds[target]);
    if (missing) throw new Error(`Open the ${STUDIO_MOTION_LABELS[missing.target]} dock to preview this motion.`);
    await ipc.livePlayStudioMotion(studioMotionKeyframes(sequence, timeMs, bounds));
  });

  const preview = (timeMs: number) => {
    if (!stillOwnsOutput()) return;
    pendingScrub.current = { owner, timeMs };
    if (scrubQueued.current) return;
    scrubQueued.current = true;
    void enqueue(async () => {
      while (stillOwnsOutput() && pendingScrub.current?.owner === owner) {
        const { timeMs } = pendingScrub.current;
        pendingScrub.current = null;
        const current = draft.current!.data;
        const sequence = current.revision === 0 ? sampleStudioMotion(availableTargets) : current.sequence;
        await ipc.liveSetStudioMotionPose(studioMotionPose(sequence, timeMs, motionBounds()));
      }
    }).catch(error => {
      if (stillOwnsOutput()) setTimelineError(messageFor(error));
    }).finally(() => { scrubQueued.current = false; });
  };

  const changeSubject = (next: StudioSubject) => {
    if (!stillOwnsOutput() || subjectFlight.current || subject === next) return;
    subjectFlight.current = true;
    setSubjectBusy(true);
    void enqueue(async () => {
      await ipc.liveSetStudioCanvasOnly(next === "canvas");
      if (stillOwnsOutput()) setSource({ owner, subject: next });
    }).catch(error => {
      if (stillOwnsOutput()) onError(messageFor(error));
    }).finally(() => {
      subjectFlight.current = false;
      if (mounted.current) setSubjectBusy(false);
    });
  };

  return {
    inspect, author, play, preview, subject, subjectBusy, changeSubject,
    timelineEnabled, timelineVisible, timelineError, timelineRef, footerRef,
    sequence: draft.current.data.revision === 0 ? sampleStudioMotion(availableTargets) : draft.current.data.sequence,
    changeSequence: (sequence: StudioMotionDraft["sequence"]) => {
      try {
        setTimelineError("");
        author(sequence, draft.current!.data.revision);
      } catch (error) { setTimelineError(messageFor(error)); }
    },
  };
}
