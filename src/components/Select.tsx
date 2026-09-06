/** THE Select — one control for every choice in Producer (v0.4.32).
 *
 * Replaces every native `<select>` in src/views: a 32px GLASS trigger
 * (`--surface-2`, hairline, `--r-ctl`, chevron) and a portaled glass
 * popover in the room's `.cr-menu` idiom, listbox / option roles, a mint
 * dot on the active item, keyboard travel (arrows, Home/End, Enter/Space,
 * Escape, type-ahead — lib/selectKeys.ts, tested), and ONE open at a time
 * across the app (opening one closes any other).
 *
 * Value-typed like a native select: `value` is a string, `onChange` gets
 * the option's value. Options may be disabled; an empty-string value is a
 * fine "none" row. `size="sm"` is the 28px variant for dense rows.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CLOSED_SELECT, selectKeyReduce, type SelectKeyState, type SelectOptionLike } from "../lib/selectKeys";

export interface SelectOption extends SelectOptionLike {
  /** Optional second line / hint rendered dim after the label. */
  hint?: string;
}

export interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** Shown on the trigger when `value` matches no option. */
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  className?: string;
  style?: CSSProperties;
  size?: "md" | "sm";
  /** An icon before the trigger's label. */
  icon?: ReactNode;
  /** Let the popover grow to this width at most (px). */
  menuWidth?: number;
}

/** One open at a time, app-wide. */
let closeOpen: (() => void) | null = null;

const chevron = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export function Select(p: SelectProps) {
  const [st, setSt] = useState<SelectKeyState>(CLOSED_SELECT);
  const stRef = useRef(st);
  stRef.current = st;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const selectedIndex = useMemo(() => p.options.findIndex((o) => o.value === p.value), [p.options, p.value]);
  const selected = selectedIndex >= 0 ? p.options[selectedIndex] : undefined;
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);

  const close = useCallback(() => {
    setSt({ ...CLOSED_SELECT });
    if (closeOpen === close) closeOpen = null;
  }, []);

  const open = () => {
    if (p.disabled) return;
    if (closeOpen && closeOpen !== close) closeOpen();
    closeOpen = close;
    setSt(selectKeyReduce(stRef.current, { type: "open", selectedIndex }, p.options).state);
  };

  const commit = (i: number) => {
    const o = p.options[i];
    if (!o || o.disabled) return;
    if (o.value !== p.value) p.onChange(o.value);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (p.disabled) return;
    const key = e.key === "ArrowDown" && e.altKey ? "Enter" : e.key;
    const r = selectKeyReduce(stRef.current, { type: "key", key, now: Date.now(), selectedIndex }, p.options);
    if (r.state !== stRef.current) {
      if (r.state.open && !stRef.current.open) {
        if (closeOpen && closeOpen !== close) closeOpen();
        closeOpen = close;
      }
      if (!r.state.open && closeOpen === close) closeOpen = null;
      setSt(r.state);
    }
    if (r.commit != null) commit(r.commit);
    if (r.handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Place the popover under (or over) the trigger; follow scroll / resize.
  useLayoutEffect(() => {
    if (!st.open) {
      setPos(null);
      return;
    }
    const place = () => {
      const t = trigger.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const width = Math.max(r.width, Math.min(p.menuWidth ?? 320, 320));
      const below = window.innerHeight - r.bottom;
      const est = Math.min(320, 8 + p.options.length * 30);
      const up = below < est + 12 && r.top > below;
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8));
      setPos({ left, top: up ? r.top - 4 : r.bottom + 4, width, up });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [st.open, p.options.length, p.menuWidth]);

  // Outside click closes; the highlighted row stays in view.
  useEffect(() => {
    if (!st.open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (trigger.current?.contains(t) || list.current?.contains(t)) return;
      close();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [st.open, close]);
  useEffect(() => {
    if (!st.open || st.highlight < 0) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-i="${st.highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [st.open, st.highlight]);
  useEffect(() => () => { if (closeOpen === close) closeOpen = null; }, [close]);

  const cls = ["sel", p.size === "sm" ? "sel-sm" : "", st.open ? "open" : "", p.className ?? ""].filter(Boolean).join(" ");
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={cls}
        style={p.style}
        disabled={p.disabled}
        title={p.title}
        aria-label={p["aria-label"] ?? p.title}
        aria-haspopup="listbox"
        aria-expanded={st.open}
        aria-controls={st.open ? `${id}-list` : undefined}
        onClick={() => (st.open ? close() : open())}
        onKeyDown={onKey}
      >
        {p.icon && <span className="sel-icon">{p.icon}</span>}
        <span className={`sel-label${selected ? "" : " placeholder"}`}>{selected ? selected.label : p.placeholder ?? "Choose…"}</span>
        <span className="sel-chev">{chevron}</span>
      </button>
      {st.open &&
        pos &&
        createPortal(
          <div
            ref={list}
            id={`${id}-list`}
            role="listbox"
            className={`sel-menu cr-menu${pos.up ? " up" : ""}`}
            style={{ left: pos.left, top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined, minWidth: pos.width, right: "auto" }}
            aria-activedescendant={st.highlight >= 0 ? `${id}-o${st.highlight}` : undefined}
            onKeyDown={onKey}
            tabIndex={-1}
          >
            {p.options.map((o, i) => {
              const active = o.value === p.value;
              return (
                <div
                  key={`${o.value}-${i}`}
                  id={`${id}-o${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={active}
                  aria-disabled={o.disabled || undefined}
                  className={`sel-opt${active ? " active" : ""}${st.highlight === i ? " hl" : ""}${o.disabled ? " disabled" : ""}`}
                  onMouseEnter={() => setSt((s) => selectKeyReduce(s, { type: "hover", index: i }, p.options).state)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (o.disabled) return;
                    commit(i);
                    close();
                    trigger.current?.focus();
                  }}
                >
                  <span className="sel-dot" aria-hidden="true" />
                  <span className="sel-opt-label">{o.label}</span>
                  {o.hint && <span className="sel-opt-hint">{o.hint}</span>}
                </div>
              );
            })}
            {p.options.length === 0 && <div className="sel-opt disabled">Nothing to choose</div>}
          </div>,
          document.body,
        )}
    </>
  );
}
