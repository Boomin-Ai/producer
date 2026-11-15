import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ipc, type StudioSpotlightRect } from "../../lib/ipc";

export function visiblePanelRect(panel: HTMLElement, dock: HTMLElement): StudioSpotlightRect | null {
  const width = window.innerWidth;
  const height = window.innerHeight;
  if (!panel.isConnected || width <= 0 || height <= 0) return null;

  const bounds = panel.getBoundingClientRect();
  const clip = dock.getBoundingClientRect();
  const left = Math.max(0, bounds.left, clip.left);
  const top = Math.max(0, bounds.top, clip.top);
  const right = Math.min(width, bounds.right, clip.right);
  const bottom = Math.min(height, bounds.bottom, clip.bottom);
  if (right <= left || bottom <= top) return null;
  const x = left / width;
  const y = top / height;
  return { x, y, w: right / width - x, h: bottom / height - y };
}

function sameRect(a: StudioSpotlightRect | null, b: StudioSpotlightRect | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
}

/** Send only geometry updates. The native Studio renderer animates the lift. */
export function useStudioSpotlight(enabled: boolean) {
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const updates = useRef<{ next: StudioSpotlightRect | null; sent: StudioSpotlightRect | null; sending: boolean }>({
    next: null, sent: null, sending: false,
  });

  const send = useCallback((rect: StudioSpotlightRect | null, force = false) => {
    const queue = updates.current;
    if (!force && sameRect(queue.next, rect)) return;
    queue.next = rect;
    if (queue.sending) return;

    // Keep only the latest bounds while the engine applies an earlier update.
    queue.sending = true;
    void (async () => {
      try {
        while (queue.sent !== queue.next) {
          const next = queue.next;
          queue.sent = next;
          await ipc.liveSetStudioSpotlight(next).catch(error => console.warn("Studio spotlight update failed", error));
        }
      } finally {
        queue.sending = false;
      }
    })();
  }, []);

  useLayoutEffect(() => {
    if (!panel) return;
    const dock = panel.parentElement;
    if (!enabled || !dock || !panel.isConnected) {
      setPanel(null);
      return;
    }

    let frame = 0;
    let force = false;
    const refresh = () => {
      const rect = visiblePanelRect(panel, dock);
      send(rect, force);
      force = false;
      if (!rect) setPanel(null);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    const resize = () => {
      // Native titlebar or backing scale may change while normalized bounds stay equal.
      force = true;
      schedule();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPanel(null);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(dock);
    for (const sibling of dock.children) observer.observe(sibling);
    const children = new MutationObserver(() => {
      if (panel.isConnected) schedule();
      else refresh();
    });
    // A whole dock can be removed without changing any of its own children.
    for (let ancestor: HTMLElement | null = dock; ancestor; ancestor = ancestor.parentElement) {
      children.observe(ancestor, { childList: true });
    }
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("keydown", keyDown, true);
    refresh();

    return () => {
      observer.disconnect();
      children.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("keydown", keyDown, true);
      send(null);
    };
  }, [enabled, panel, send]);

  return (event: MouseEvent<HTMLElement>) => {
    // React portals can bubble through the dock without being part of its capture.
    if (enabled && event.target instanceof Node && event.currentTarget.contains(event.target)) {
      setPanel(event.currentTarget);
    }
  };
}
