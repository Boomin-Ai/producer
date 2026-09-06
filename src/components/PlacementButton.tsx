import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { nextPlacement, placementLabel } from "../lib/placement";

/** The ONE placement button (v0.4.38). Replaces every row of four little
 * squares. Shows the CURRENT placement as a 4-cell mini layout with the
 * active edge filled; hovering previews the NEXT placement (160 ms ease,
 * loops every 900 ms while hovered); click applies whatever is previewed.
 * Keyboard: focus + arrows cycle the preview, Enter / Space applies.
 * Tooltip: "Move to <placement>". Generic over the ring so the stage's
 * quick-controls edge and a panel's dock share one control. */
export function PlacementButton<T extends string>({
  value,
  order,
  onChange,
  labelFor = placementLabel,
  className = "",
  glyph = glyphFor,
}: {
  value: T;
  /** The ring to walk. `value` need not be in it (it then previews the first entry). */
  order: readonly T[];
  onChange: (next: T) => void;
  labelFor?: (p: T) => string;
  className?: string;
  /** Which edge the mini-layout fills for a placement (default: the name itself). */
  glyph?: (p: T) => "top" | "right" | "bottom" | "left" | "none";
}) {
  const [preview, setPreview] = useState<T | null>(null);
  const [hover, setHover] = useState(false);
  const timer = useRef<number | null>(null);
  const shown = preview ?? value;

  // Hover: step to the next placement at once, then every 900 ms.
  useEffect(() => {
    if (!hover) return;
    setPreview((p) => nextPlacement(p ?? value, order));
    timer.current = window.setInterval(() => setPreview((p) => nextPlacement(p ?? value, order)), 900);
    return () => {
      if (timer.current != null) window.clearInterval(timer.current);
      timer.current = null;
    };
  }, [hover, order, value]);
  // A value change from outside resets the preview.
  useEffect(() => setPreview(null), [value]);

  const apply = () => {
    const next = preview ?? nextPlacement(value, order);
    setPreview(null);
    setHover(false);
    if (next !== value) onChange(next);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      setPreview((p) => nextPlacement(p ?? value, order));
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      setPreview((p) => nextPlacement(p ?? value, order, -1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      apply();
    } else if (e.key === "Escape") {
      setPreview(null);
    }
  };
  const edge = glyph(shown);
  return (
    <button
      type="button"
      className={`rm-place${preview && preview !== value ? " previewing" : ""} ${className}`.trim()}
      title={labelFor(preview ?? nextPlacement(value, order))}
      aria-label={labelFor(preview ?? nextPlacement(value, order))}
      data-place={edge}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPreview(null);
      }}
      onBlur={() => setPreview(null)}
      onKeyDown={onKey}
      onClick={apply}
    >
      <span className="rm-place-grid" aria-hidden>
        <i className="rm-place-cell t" />
        <i className="rm-place-cell r" />
        <i className="rm-place-cell b" />
        <i className="rm-place-cell l" />
      </span>
    </button>
  );
}

function glyphFor(p: string): "top" | "right" | "bottom" | "left" | "none" {
  return p === "top" || p === "right" || p === "bottom" || p === "left" ? p : "none";
}
