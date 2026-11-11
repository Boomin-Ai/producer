import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { type Notice, fade, subscribeNotices } from "../lib/notices";
import {ToolbarButton} from './RoomToolbar';

export function useNotices(): Notice[] {
  const [list, setList] = useState<Notice[]>([]);
  useEffect(() => subscribeNotices(setList), []);
  return list;
}

type NoticeAction = { label: string; onClick: () => void; noticeKey: string };

export function NoticeHost({ action, hidden = false, compact = false }: {
  hidden?: boolean;
  compact?: boolean;
  action?: NoticeAction;
}) {
  const list = useNotices();
  const [history, setHistory] = useState<Notice[]>([]);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!list.length) return;
    setHistory(old => {
      const rows = new Map(old.map(notice => [notice.id, notice]));
      for (const notice of list) rows.set(notice.id, notice);
      return [...rows.values()].slice(-20);
    });
  }, [list]);

  useEffect(() => {
    const timers = list.filter(notice => !notice.faded && !notice.sticky && notice.tone !== "error")
      .map(notice => setTimeout(() => fade(notice.id), notice.ttl));
    return () => timers.forEach(clearTimeout);
  }, [list]);

  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  const closeOnEscape = (event: KeyboardEvent) => {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  };

  const active = list.filter(notice => !notice.faded);
  const latest = active[active.length - 1];
  const activityText = latest?.text ?? history[history.length - 1]?.text;
  const actionId = history.filter(notice => notice.key === action?.noticeKey).pop()?.id;
  if (hidden) return null;

  const symbol=<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 12h4l3-6 4 12 3-6h4" /></svg>;
  return <div className={`rm-top-activity${compact?' is-compact':''}`} onKeyDown={closeOnEscape}>
    {compact?<ToolbarButton ref={trigger} label="Room activity" tooltip={activityText?`Activity · ${activityText}`:'Room activity'} tooltipAlign="start" data-tone={latest?.tone} aria-expanded={open} aria-controls={open?panelId:undefined} onClick={()=>setOpen(current=>!current)}>{symbol}{latest&&<span className="rm-toolbar-notice" data-tone={latest.tone} aria-hidden="true"/>}</ToolbarButton>:<button ref={trigger} type="button" className="rm-activity-trigger" aria-label="Room activity" data-tone={latest?.tone}
      title={activityText ?? "Room activity"} aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => setOpen(current => !current)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M3 12h4l3-6 4 12 3-6h4" />
      </svg>
      <span className="rm-activity-label">Activity</span>
      {latest && <span className={`rm-activity-preview tone-${latest.tone}`}>{latest.text}</span>}
      {active.length > 1 && <span className="rm-activity-count" aria-hidden="true">{active.length}</span>}
      <svg className="rm-activity-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <path d="m3 4.5 3 3 3-3" />
      </svg>
    </button>}
    <span className="rm-activity-announcement" role="status">{latest?.text}</span>
    {open && <section id={panelId} className="rm-activity-panel" aria-label="Room activity feed">
      {history.length ? <ul className="rm-activity-list" tabIndex={0} aria-label="Recent updates">
        {history.slice().reverse().map(notice => <li key={notice.id} className={`rm-activity-entry tone-${notice.tone}`}>
          <span className="rm-activity-tone" aria-label={notice.tone}>{notice.tone === "success" ? "✓" : notice.tone === "error" || notice.tone === "warning" ? "!" : "•"}</span>
          <div>
            <p>{notice.text}</p>
            {action && notice.id === actionId && <button type="button" onClick={() => {
              setOpen(false);
              action.onClick();
            }}>{action.label} ↗</button>}
          </div>
        </li>)}
      </ul> : <p className="rm-activity-empty">No room updates yet.</p>}
    </section>}
  </div>;
}
