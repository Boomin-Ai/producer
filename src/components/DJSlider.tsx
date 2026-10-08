import { useEffect, useRef, useState } from "react";

/** Keep a drag local: playback polls/IPC replies must not move the thumb
 * under the pointer. Seek commits once on release; levels update live. */
export function DJSlider({
  value,
  min = 0,
  max,
  step = 1,
  label,
  orientation = "horizontal",
  disabled,
  live = false,
  fill,
  valueText,
  onValue,
}: {
  value: number;
  min?: number;
  max: number;
  step?: number;
  label: string;
  orientation?: "horizontal" | "vertical";
  disabled?: boolean;
  live?: boolean;
  /** Optional live meter fill; the thumb still represents value. */
  fill?: number;
  valueText?: string;
  onValue: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const dragging = useRef(false);
  const pending = useRef(false);
  const latest = useRef(value);
  const draftRef = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  latest.current = value;
  useEffect(() => {
    if (dragging.current) return;
    if (
      !pending.current ||
      Math.abs(value - draftRef.current) <=
        Math.max(step / 2, (max - min) / 1000)
    ) {
      pending.current = false;
      draftRef.current = value;
      setDraft(value);
    }
  }, [value, min, max, step]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const send = (n: number) => {
    pending.current = true;
    onValue(n);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (dragging.current) return;
      pending.current = false;
      draftRef.current = latest.current;
      setDraft(latest.current);
    }, 1200);
  };
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const update = (n: number) => {
    n = clamp(min + Math.round((n - min) / step) * step);
    draftRef.current = n;
    setDraft(n);
    if (live || !dragging.current) send(n);
  };
  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // Thumb center travels between the actual endpoints, independent of WebKit
    // native range gestures and global input styling.
    const position =
      orientation === "vertical"
        ? (rect.bottom - e.clientY - 6) / Math.max(1, rect.height - 12)
        : (e.clientX - rect.left - 6) / Math.max(1, rect.width - 12);
    const x = Math.max(0, Math.min(1, position));
    update(min + x * (max - min));
  };
  const release = () => {
    if (!dragging.current) return;
    dragging.current = false;
    send(draftRef.current);
  };
  const fraction = max > min ? (clamp(draft) - min) / (max - min) : 0;
  return (
    <div
      className={`dj-slider${orientation === "vertical" ? " vertical" : ""}`}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={clamp(draft)}
      aria-valuetext={
        valueText ?? (label === "Crossfader"
          ? Math.abs(fraction - 0.5) < 0.005
            ? "Center — equal A and B"
            : `A ${Math.round((1 - fraction) * 100)}%, B ${Math.round(fraction * 100)}%`
          : undefined)
      }
      aria-disabled={!!disabled}
      aria-orientation={orientation}
      tabIndex={disabled ? -1 : 0}
      style={
        {
          "--dj-position": `${fraction * 100}%`,
          "--dj-fraction": fraction,
          "--dj-fill-position": `${Math.max(0, Math.min(1, fill ?? fraction)) * 100}%`,
        } as React.CSSProperties
      }
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.focus();
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        point(e);
      }}
      onPointerMove={(e) => {
        if (dragging.current) point(e);
      }}
      onPointerUp={(e) => {
        if (dragging.current) {
          point(e);
          release();
        }
      }}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e) => {
        if (disabled) return;
        const increment = Math.max(step, (max - min) / 100);
        const values: Record<string, number> = {
          ArrowRight: draftRef.current + increment,
          ArrowUp: draftRef.current + increment,
          ArrowLeft: draftRef.current - increment,
          ArrowDown: draftRef.current - increment,
          PageUp: draftRef.current + increment * 10,
          PageDown: draftRef.current - increment * 10,
          Home: min,
          End: max,
        };
        if (e.key in values) {
          e.preventDefault();
          update(values[e.key]);
        }
      }}
    >
      <span className="dj-slider-rail">
        <span className="dj-slider-fill" />
      </span>
      <span className="dj-slider-thumb" />
    </div>
  );
}
