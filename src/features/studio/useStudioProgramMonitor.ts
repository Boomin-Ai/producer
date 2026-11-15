import { useLayoutEffect, useState, type RefObject } from "react";
import { ipc, type StudioSpotlightRect } from "../../lib/ipc";
import { notifyError } from "../../lib/notices";
import { afterPreviewWork } from "../../lib/previewSession";
import { observeStageCutouts } from "../../lib/stageCutouts";

export function useStudioProgramMonitor(canvas: RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [showing, setShowing] = useState(false);
  useLayoutEffect(() => {
    setShowing(false);
    const stage = canvas.current;
    if (!enabled || !stage) return;

    const sessionId = crypto.randomUUID();
    let alive = true;
    let opened = false;
    let failed = false;
    let updating = false;
    let scheduled = 0;
    let force = false;
    let cutouts: { x: number; y: number; w: number; h: number }[] = [];
    let previous = "";

    const measure = (): StudioSpotlightRect | null => {
      const { left, right, top, bottom, width, height } = stage.getBoundingClientRect();
      const viewWidth = window.innerWidth;
      const viewHeight = window.innerHeight;
      if (width < 10 || height < 10 || left < 0 || top < 0 || right > viewWidth || bottom > viewHeight) return null;
      if (cutouts.some(r => r.x < right && r.x + r.w > left && r.y < bottom && r.y + r.h > top)) return null;
      return { x: left / viewWidth, y: top / viewHeight, w: width / viewWidth, h: height / viewHeight };
    };
    const update = async () => {
      scheduled = 0;
      if (!alive || updating || failed) return;
      const rect = measure();
      const key = JSON.stringify(rect);
      if (key === previous && !force) return;
      force = false;
      if (!rect && !opened) return;
      updating = true;
      try {
        await afterPreviewWork(async () => {
          if (!alive) return;
          if (!opened) {
            await ipc.liveOpenStudioComposer(sessionId);
            opened = true;
          }
          if (!alive) return;
          const latest = measure();
          await ipc.liveSetStudioComposerPreview(sessionId, latest);
          previous = JSON.stringify(latest);
          if (alive) setShowing(latest !== null);
        });
      } catch (error) {
        failed = true;
        if (alive) {
          setShowing(false);
          notifyError(error, { key: "banner" });
        }
      } finally {
        updating = false;
        if (alive && (force || previous !== JSON.stringify(measure()))) schedule();
      }
    };
    const schedule = () => {
      if (alive && !failed && !scheduled) scheduled = window.setTimeout(() => void update(), 0);
    };
    const resize = () => { force = true; schedule(); };
    const observer = new ResizeObserver(schedule);
    observer.observe(stage);
    const unsubscribe = observeStageCutouts(rects => { cutouts = rects; schedule(); });
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", schedule, true);
    // A dock can move the fitted stage without changing its dimensions.
    const tick = window.setInterval(schedule, 250);
    return () => {
      alive = false;
      window.clearTimeout(scheduled);
      window.clearInterval(tick);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", schedule, true);
      observer.disconnect();
      unsubscribe();
      void afterPreviewWork(async () => {
        if (opened) await ipc.liveCloseStudioComposer(sessionId);
      }).catch(() => {});
    };
  }, [canvas, enabled]);
  return enabled && showing;
}
