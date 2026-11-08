import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import "./ExpandableProgram.css";

/** Changes presentation only: children remain in the same DOM location.
 * Stream attachment, playback and track ownership belong to the caller. */
export function ExpandableProgram({ title, children }: { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const collapse = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    collapse.current?.focus();
    const focusable = () => Array.from(panel.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),video[controls],[tabindex]:not([tabindex="-1"])',
    ) ?? []).filter(element => element.getClientRects().length > 0 && !element.hidden);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); setExpanded(false); return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(), first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); panel.current?.focus(); return; }
      if (!panel.current?.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) collapse.current?.focus();
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", keepFocus);
      if (trigger.current?.isConnected) trigger.current.focus();
      else if (previous?.isConnected) previous.focus();
    };
  }, [expanded]);

  return (
    <div className={`expandable-program${expanded ? " is-expanded" : ""}`}>
      <div className="expandable-program-backdrop" hidden={!expanded} aria-hidden="true" onPointerDown={event => { event.preventDefault(); setExpanded(false); }} />
      <section ref={panel} id={id} className="expandable-program-panel" role={expanded ? "dialog" : undefined}
        aria-modal={expanded ? true : undefined} aria-labelledby={expanded ? `${id}-title` : undefined} tabIndex={expanded ? -1 : undefined}>
        <header className="expandable-program-header" hidden={!expanded}>
          <h2 id={`${id}-title`}>{title}</h2>
          <button ref={collapse} type="button" onClick={() => setExpanded(false)} aria-label="Collapse program output">
            <span aria-hidden="true">↙</span> Collapse
          </button>
        </header>
        <div className="expandable-program-media">{children}</div>
        <button ref={trigger} type="button" className="expandable-program-trigger" hidden={expanded}
          onClick={() => setExpanded(true)} aria-label="Expand program output" aria-expanded={expanded} aria-controls={id} title={`Expand ${title}`}>
          <span className="expandable-program-label">PROGRAM</span>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
          </svg>
        </button>
      </section>
    </div>
  );
}
