import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { placementLabel, placementMenuKey, placementMenuStart, placementOptionLabel, placementOptions } from "../lib/placement";

/** The ONE placement button (v0.4.40). Replaces every row of four little
 * squares. A STATIC glyph: a 4-cell mini layout with the active edge filled,
 * showing where the panel currently IS, tooltip "In the <dock> dock".
 * Clicking it opens a small portaled glass menu (the Select list's idiom)
 * with every placement in the ring; choosing one moves the panel. Keyboard:
 * Enter / Space / arrows open, arrows move the highlight, Enter applies,
 * Escape closes. Nothing previews or cycles on hover — the only hover
 * effect is the normal button tint. Generic over the ring so the stage's
 * quick-controls edge and a panel's dock share one control. */
export function PlacementButton<T extends string>({
  value,
  order,
  onChange,
  labelFor = placementLabel,
  optionLabel = placementOptionLabel,
  className = "",
  glyph = glyphFor,
}: {
  value: T;
  /** The placements offered in the menu. `value` need not be in it. */
  order: readonly T[];
  onChange: (next: T) => void;
  /** The button's tooltip for the CURRENT value. */
  labelFor?: (p: T) => string;
  /** A menu row's text. */
  optionLabel?: (p: T) => string;
  className?: string;
  /** Which edge the mini-layout fills for a placement (default: the name itself). */
  glyph?: (p: T) => "top" | "right" | "bottom" | "left" | "none";
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const options = placementOptions(value, order, optionLabel);

  const close = useCallback(() => {
    setOpen(false);
    setHighlight(-1);
  }, []);
  const show = () => {
    setHighlight(placementMenuStart(value, order));
    setOpen(true);
  };
  const commit = (i: number) => {
    const o = options[i];
    close();
    trigger.current?.focus();
    if (o && o.value !== value) onChange(o.value);
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        show();
      }
      return;
    }
    const r = placementMenuKey(highlight, e.key, options.length);
    if (r.handled) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (r.commit) {
      commit(r.highlight);
      return;
    }
    if (r.close) {
      close();
      trigger.current?.focus();
      return;
    }
    if (r.highlight !== highlight) setHighlight(r.highlight);
  };

  // Place the menu under (or over) the button; follow scroll / resize.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const t = trigger.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const width = 150;
      const est = 10 + options.length * 30;
      const below = window.innerHeight - r.bottom;
      const up = below < est + 12 && r.top > below;
      const left = Math.min(Math.max(8, r.right - width), Math.max(8, window.innerWidth - width - 8));
      setPos({ left, top: up ? r.top - 4 : r.bottom + 4, up });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, options.length]);

  // Outside click closes.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (trigger.current?.contains(t) || list.current?.contains(t)) return;
      close();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, close]);
  // A value change from outside closes the menu.
  useEffect(() => close(), [value, close]);

  const edge = glyph(value);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`rm-place${open ? " open" : ""} ${className}`.trim()}
        title={labelFor(value)}
        aria-label={labelFor(value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        data-place={edge}
        onKeyDown={onKey}
        onClick={(e) => {
          e.stopPropagation();
          open ? close() : show();
        }}
      >
        <span className="rm-place-grid" aria-hidden>
          <i className="rm-place-cell t" />
          <i className="rm-place-cell r" />
          <i className="rm-place-cell b" />
          <i className="rm-place-cell l" />
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={list}
            id={`${id}-menu`}
            role="menu"
            className={`sel-menu rm-place-menu cr-menu${pos.up ? " up" : ""}`}
            style={{ left: pos.left, top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined, minWidth: 150, right: "auto" }}
            onKeyDown={onKey}
            tabIndex={-1}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                role="menuitemradio"
                aria-checked={o.active}
                data-i={i}
                className={`sel-opt${o.active ? " active" : ""}${highlight === i ? " hl" : ""}`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  commit(i);
                }}
              >
                <span className="sel-dot" aria-hidden="true" />
                <span className="sel-opt-label">{o.label}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function glyphFor(p: string): "top" | "right" | "bottom" | "left" | "none" {
  return p === "top" || p === "right" || p === "bottom" || p === "left" ? p : "none";
}
