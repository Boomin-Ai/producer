import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Notice as NoticeT, dismiss, fade, subscribeNotices } from "../lib/notices";

/** The live list of notices; one subscriber per host. */
export function useNotices(): NoticeT[] {
  const [list, setList] = useState<NoticeT[]>([]);
  useEffect(() => subscribeNotices(setList), []);
  return list;
}

/** Notices fade in place; hover pauses the clock and shows clipped text in
 * a portaled card without changing the pill or the surrounding toolbar. */
function NoticePill({ n }: { n: NoticeT }) {
  const [paused, setPaused] = useState(false);
  const [clipped, setClipped] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ left: number; top: number; width: number } | null>(null);
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
    <>
    <div
      className={`rm-notice tone-${n.tone}${n.check ? " check" : ""}${n.faded ? " faded" : ""}${clipped ? " clipped" : ""}`}
      role={n.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => {
        hoverRef.current = true;
        setPaused(true);
        const rect = textRef.current?.parentElement?.getBoundingClientRect();
        if (rect) {
          const width = Math.min(560, window.innerWidth - 24);
          setTip({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + 8, width });
        }
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
        setPaused(false);
        setTip(null);
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
    {paused && clipped && tip && createPortal(
      <div className="rm-notice-detail" data-over-stage role="tooltip" style={tip}>{n.text}</div>,
      document.body,
    )}
    </>
  );
}

/** The host: sits in the top bar's drag strip. Only the pills take the
 * pointer — the strip around them stays a window-drag region. */
export function NoticeHost({ action }: { action?: { label: string; onClick: () => void; noticeKey: string } } = {}) {
  const list = useNotices();
  if (list.length === 0) return null;
  // Newest last; at most three ACTIVE on screen so a burst never buries the
  // bar. The one faded notice (if any) rides along — the store keeps at most
  // one, and a fresh notice drops it.
  const active = list.filter((n) => !n.faded).slice(-3);
  const faded = list.filter((n) => n.faded);
  const shown = [...faded, ...active];
  const visibleAction = action && shown.some((n) => n.key === action.noticeKey) ? action : undefined;
  return (
    <div className={`rm-notices${visibleAction ? " with-action" : ""}`} data-tauri-drag-region>
      {shown.map((n) => (
        <NoticePill key={n.id} n={n} />
      ))}
      {visibleAction && <button type="button" className="rm-notice-action" onClick={visibleAction.onClick}>{visibleAction.label} <span aria-hidden="true">↗</span></button>}
    </div>
  );
}
