import { useEffect, useState } from "react";
import { type Notice as NoticeT, dismiss, subscribeNotices } from "../lib/notices";

/** The live list of notices; one subscriber per host. */
export function useNotices(): NoticeT[] {
  const [list, setList] = useState<NoticeT[]>([]);
  useEffect(() => subscribeNotices(setList), []);
  return list;
}

/** One glass pill. Auto-dismisses after its ttl; hovering pauses the clock. */
function NoticePill({ n }: { n: NoticeT }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (n.sticky || paused) return;
    const t = window.setTimeout(() => dismiss(n.id), n.ttl);
    return () => window.clearTimeout(t);
  }, [n.id, n.ttl, n.sticky, paused]);
  return (
    <div
      className={`rm-notice tone-${n.tone}${n.check ? " check" : ""}`}
      role={n.tone === "error" ? "alert" : "status"}
      title={n.text}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={() => dismiss(n.id)}
    >
      {n.check && (
        <svg className="rm-notice-check" viewBox="0 0 16 16" aria-hidden>
          <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span className="rm-notice-text">{n.text}</span>
    </div>
  );
}

/** The host: sits in the top bar's drag strip. Only the pills take the
 * pointer — the strip around them stays a window-drag region. */
export function NoticeHost() {
  const list = useNotices();
  if (list.length === 0) return null;
  // Newest last; at most three on screen so a burst never buries the bar.
  const shown = list.slice(-3);
  return (
    <div className="rm-notices" data-tauri-drag-region>
      {shown.map((n) => (
        <NoticePill key={n.id} n={n} />
      ))}
    </div>
  );
}
