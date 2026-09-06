import { useEffect, useRef, useState } from "react";
import { type Notice as NoticeT, dismiss, fade, subscribeNotices } from "../lib/notices";

/** The live list of notices; one subscriber per host. */
export function useNotices(): NoticeT[] {
  const [list, setList] = useState<NoticeT[]>([]);
  useEffect(() => subscribeNotices(setList), []);
  return list;
}

/** One glass pill. After its ttl it FADES in place (opacity 0.55) rather
 * than vanishing — the last thing the room said stays readable until you
 * hover it (full opacity; a pill that had to ellipsize EXPANDS natively to
 * its full text — a 120 ms max-width transition, no browser tooltip), click
 * it (dismiss), or a newer notice replaces it. Errors never fade: full
 * opacity until dismissed. Hovering pauses the clock. */
function NoticePill({ n }: { n: NoticeT }) {
  const [paused, setPaused] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (n.sticky || paused || n.faded || n.tone === "error") return;
    const t = window.setTimeout(() => fade(n.id), n.ttl);
    return () => window.clearTimeout(t);
  }, [n.id, n.ttl, n.sticky, n.tone, n.faded, paused]);
  // Expansion only when the text had to ellipsize — a pill that fits says
  // everything already (and must not jump on hover).
  const hoverRef = useRef(false);
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    // Never re-measure while hovered: the expanded pill would read as
    // "fits", drop the class, and snap shut under the pointer.
    const check = () => {
      if (hoverRef.current) return;
      setClipped(el.scrollWidth > el.clientWidth + 1);
    };
    check();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [n.text]);
  return (
    <div
      className={`rm-notice tone-${n.tone}${n.check ? " check" : ""}${n.faded ? " faded" : ""}${clipped ? " clipped" : ""}`}
      role={n.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => {
        hoverRef.current = true;
        setPaused(true);
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
        setPaused(false);
      }}
      onClick={() => dismiss(n.id)}
    >
      {n.check && (
        <svg className="rm-notice-check" viewBox="0 0 16 16" aria-hidden>
          <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span ref={textRef} className="rm-notice-text">{n.text}</span>
    </div>
  );
}

/** The host: sits in the top bar's drag strip. Only the pills take the
 * pointer — the strip around them stays a window-drag region. */
export function NoticeHost() {
  const list = useNotices();
  if (list.length === 0) return null;
  // Newest last; at most three ACTIVE on screen so a burst never buries the
  // bar. The one faded notice (if any) rides along — the store keeps at most
  // one, and a fresh notice drops it.
  const active = list.filter((n) => !n.faded).slice(-3);
  const faded = list.filter((n) => n.faded);
  const shown = [...faded, ...active];
  return (
    <div className="rm-notices" data-tauri-drag-region>
      {shown.map((n) => (
        <NoticePill key={n.id} n={n} />
      ))}
    </div>
  );
}
