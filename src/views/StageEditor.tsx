import { useCallback, useEffect, useRef, useState } from "react";
import { keyIs } from "../lib/keys";
import { ipc, type LiveItem, type LiveTransformPatch } from "../lib/ipc";
import { resizeBox } from "../lib/stageMath";

/** StageEditor (UI-P2) — direct manipulation on the canvas.
 *
 * Renders as a transparent layer exactly over the letterboxed preview (the
 * native video sits BEHIND the webview, so this is ordinary HTML floating
 * over the picture). All geometry is translated between CSS pixels and
 * canvas units (base_width × base_height); the engine only ever hears
 * canvas units. Gesture ticks apply silently (commit:false); release
 * commits and lets engine truth echo back. */

const SNAP = 10; // canvas units
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];

interface Gesture {
  kind: "move" | "rotate" | Handle;
  /** ⌥ held at gesture start: edge handles crop instead of resize. */
  crop?: boolean;
  itemId: string;
  startX: number; // pointer, canvas units
  startY: number;
  orig: LiveItem;
  moved: boolean;
}

export function StageEditor({
  items,
  baseW,
  baseH,
  disabled,
  onOrder,
  onSelect,
  onDelete,
  onCommit,
  selectId,
}: {
  items: LiveItem[];
  baseW: number;
  baseH: number;
  disabled?: boolean;
  onOrder?: (id: string, dir: 1 | -1) => void;
  /** Selection is SHARED state: the rail highlights what the stage holds. */
  onSelect?: (id: string | null) => void;
  /** Delete/Backspace removes the selected source (part of the keymap). */
  onDelete?: (id: string) => void;
  /** Fires after every committed edit — the room mirrors it into the scene. */
  onCommit?: () => void;
  /** Selection driven from OUTSIDE (a rail row click): lights the item up. */
  selectId?: string | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [selected, setSelectedRaw] = useState<string | null>(null);
  // Windows float mode: the native preview covers the stage, so the engine
  // draws the selection outline itself. Harmless elsewhere.
  useEffect(() => {
    ipc.liveSetSelection(selected).catch(() => {});
  }, [selected]);
  const setSelected = (id: string | null) => {
    setSelectedRaw(id);
    onSelect?.(id);
  };
  useEffect(() => {
    if (selectId !== undefined) setSelectedRaw(selectId);
  }, [selectId]);
  const [drag, setDrag] = useState<LiveItem | null>(null); // optimistic geometry
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const gesture = useRef<Gesture | null>(null);
  const raf = useRef(0);
  const pending = useRef<LiveTransformPatch | null>(null);
  /** Live modifier state: ⇧ snaps rotation, ⌥ turns edge drags into crops. */
  const shiftRef = useRef(false);
  const altRef = useRef(false);

  useEffect(() => {
    const track = (e: KeyboardEvent) => {
      shiftRef.current = e.shiftKey;
      altRef.current = e.altKey;
    };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
    };
  }, []);

  const scale = useCallback(() => {
    const el = ref.current;
    if (!el) return 1;
    return el.getBoundingClientRect().width / baseW;
  }, [baseW]);

  const toCanvas = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const r = ref.current!.getBoundingClientRect();
      const s = scale();
      return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
    },
    [scale],
  );

  /** Send at animation-frame rate, never faster. */
  const send = useCallback((id: string, patch: LiveTransformPatch) => {
    pending.current = patch;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = pending.current;
      pending.current = null;
      if (p) ipc.liveSetTransform(id, p, false).catch(() => {});
    });
  }, []);

  const commit = useCallback((id: string, patch: LiveTransformPatch) => {
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      pending.current = null;
    }
    ipc.liveSetTransform(id, patch, true).catch(() => {});
    onCommit?.();
  }, [onCommit]);

  /** Where an item's picture ACTUALLY lands on the canvas. The box the
   * engine reports is the bounds; the cropped source is fitted inside it and
   * centred, so with a crop (or any aspect mismatch) the content occupies a
   * smaller rect than the bounds. Outlining the bounds would draw a box
   * around letterbox bars — this draws it around the picture. */
  function visRect(it: LiveItem) {
    const cw = Math.max(1, it.src_w - it.crop_left - it.crop_right);
    const ch = Math.max(1, it.src_h - it.crop_top - it.crop_bottom);
    if (it.src_w <= 0 || it.src_h <= 0 || it.w <= 0 || it.h <= 0) {
      return { x: it.x, y: it.y, w: it.w, h: it.h };
    }
    const k = Math.min(it.w / cw, it.h / ch);
    const vw = cw * k;
    const vh = ch * k;
    return { x: it.x + (it.w - vw) / 2, y: it.y + (it.h - vh) / 2, w: vw, h: vh };
  }

  const visible = items.filter((i) => i.visible);
  const shown = (id: string) => (drag && drag.id === id ? drag : items.find((i) => i.id === id));

  function hitTest(x: number, y: number): LiveItem | null {
    // Topmost first, and against the PICTURE rather than the bounds — a
    // click on a letterbox bar belongs to whatever is behind it.
    for (const it of [...visible].sort((a, b) => b.z - a.z)) {
      const r = visRect(it);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return it;
    }
    return null;
  }

  function applyGesture(px: number, py: number) {
    const g = gesture.current!;
    const dx = px - g.startX;
    const dy = py - g.startY;
    if (!g.moved && Math.hypot(dx, dy) < 3) return;
    g.moved = true;
    const o = g.orig;
    let { x, y, w, h } = o;
    const v: number[] = [];
    const hz: number[] = [];

    if (g.kind === "rotate") {
      // Angle from the item's centre to the pointer; ⇧ snaps to 15°.
      const cx = o.x + o.w / 2;
      const cy = o.y + o.h / 2;
      let deg = (Math.atan2(py - cy, px - cx) * 180) / Math.PI + 90;
      if (shiftRef.current) deg = Math.round(deg / 15) * 15;
      while (deg < 0) deg += 360;
      deg %= 360;
      setDrag({ ...o, rot: deg });
      setGuides({ v: [], h: [] });
      send(o.id, { rot: deg });
      return;
    }

    if (g.crop && g.kind !== "move") {
      // Crop is in SOURCE pixels, so canvas travel converts by the item's
      // current scale. Cropping never moves or resizes the box — it changes
      // what part of the source fills it.
      const k = g.kind;
      const sx = o.w > 0 && o.src_w > 0 ? o.src_w / o.w : 1;
      const sy = o.h > 0 && o.src_h > 0 ? o.src_h / o.h : 1;
      const patch: LiveTransformPatch = {};
      const next = { ...o };
      if (k.includes("w")) {
        const v = Math.max(0, Math.round(o.crop_left + dx * sx));
        patch.crop_left = v;
        next.crop_left = v;
      }
      if (k.includes("e")) {
        const v = Math.max(0, Math.round(o.crop_right - dx * sx));
        patch.crop_right = v;
        next.crop_right = v;
      }
      if (k.includes("n")) {
        const v = Math.max(0, Math.round(o.crop_top + dy * sy));
        patch.crop_top = v;
        next.crop_top = v;
      }
      if (k.includes("s")) {
        const v = Math.max(0, Math.round(o.crop_bottom - dy * sy));
        patch.crop_bottom = v;
        next.crop_bottom = v;
      }
      setDrag(next);
      setGuides({ v: [], h: [] });
      send(o.id, patch);
      return;
    }

    if (g.kind === "move") {
      x = o.x + dx;
      y = o.y + dy;
      // Snap the PICTURE's edges, not the bounds box. With a crop — or any
      // aspect mismatch — the picture sits inset inside its bounds, so
      // snapping the box leaves a visible gap at the canvas edge while the
      // guide claims it's flush.
      const vr0 = visRect(o);
      const insetX = vr0.x - o.x;
      const insetY = vr0.y - o.y;
      // [value that lands a picture edge on a landmark, the landmark itself]
      const xs: [number, number][] = [
        [-insetX, 0],
        [baseW / 2 - vr0.w / 2 - insetX, baseW / 2],
        [baseW - vr0.w - insetX, baseW],
      ];
      for (const [cand, line] of xs) {
        if (Math.abs(x - cand) <= SNAP) {
          x = cand;
          v.push(line);
          break;
        }
      }
      const ys: [number, number][] = [
        [-insetY, 0],
        [baseH / 2 - vr0.h / 2 - insetY, baseH / 2],
        [baseH - vr0.h - insetY, baseH],
      ];
      for (const [cand, line] of ys) {
        if (Math.abs(y - cand) <= SNAP) {
          y = cand;
          hz.push(line);
          break;
        }
      }
    } else {
      // Uniform scale on every handle — see stageMath.ts for why a side
      // handle must not change one dimension alone under SCALE_INNER.
      ({ x, y, w, h } = resizeBox(o, g.kind, dx, dy));
    }
    // convert edge guides to css-space lines for rendering
    setGuides({ v, h: hz });
    const next = { ...o, x, y, w, h };
    setDrag(next);
    send(o.id, { x, y, w, h });
  }

  function endGesture() {
    const g = gesture.current;
    gesture.current = null;
    setGuides({ v: [], h: [] });
    if (g?.moved && drag) {
      if (g.kind === "rotate") {
        commit(g.itemId, { rot: drag.rot });
      } else if (g.crop) {
        commit(g.itemId, {
          crop_left: drag.crop_left,
          crop_top: drag.crop_top,
          crop_right: drag.crop_right,
          crop_bottom: drag.crop_bottom,
        });
      } else {
        commit(g.itemId, { x: drag.x, y: drag.y, w: drag.w, h: drag.h });
      }
    }
    setDrag(null);
  }

  // keyboard: nudge + ordering + escape
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      const it = items.find((i) => i.id === selected);
      if (!it) return;
      const step = e.shiftKey ? 10 : 1;
      const move: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (e.key in move) {
        e.preventDefault();
        const [mx, my] = move[e.key];
        commit(it.id, { x: it.x + mx, y: it.y + my });
      } else if (e.key === "Escape") {
        setSelected(null);
      } else if (keyIs(e, "stage.delete")) {
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
        e.preventDefault();
        onDelete?.(it.id);
        setSelected(null);
      } else if (keyIs(e, "stage.layer_up")) {
        onOrder?.(it.id, 1);
      } else if (keyIs(e, "stage.layer_down")) {
        onOrder?.(it.id, -1);
      } else if (keyIs(e, "stage.straighten")) {
        // Straighten, or with ⌥ clear the crop — both are hard to undo by
        // hand once a drag has gone wrong.
        e.preventDefault();
        if (e.altKey) {
          commit(it.id, { crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0 });
        } else {
          commit(it.id, { rot: 0 });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, items, commit, onOrder, onDelete]);

  if (disabled) return null;
  const s = scale();
  const sel = selected ? shown(selected) : null;
  const cropped = !!sel && !!(sel.crop_left || sel.crop_top || sel.crop_right || sel.crop_bottom);
  const vr = sel ? visRect(sel) : { x: 0, y: 0, w: 0, h: 0 };

  return (
    <div
      ref={ref}
      className="stage-editor"
      onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        const { x, y } = toCanvas(e);
        const hit = hitTest(x, y);
        setSelected(hit?.id ?? null);
        if (hit) {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          gesture.current = { kind: "move", itemId: hit.id, startX: x, startY: y, orig: hit, moved: false };
        }
      }}
      onPointerMove={(e) => {
        if (!gesture.current || e.buttons !== 1) return;
        const { x, y } = toCanvas(e);
        applyGesture(x, y);
      }}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
    >
      {/* snap guides */}
      {/* Guides are canvas-space landmarks now, so the line is drawn where
        * the picture actually landed. */}
      {guides.v.map((gx, i) => (
        <div key={`v${i}`} className="se-guide v" style={{ left: gx * s }} />
      ))}
      {guides.h.map((gy, i) => (
        <div key={`h${i}`} className="se-guide h" style={{ top: gy * s }} />
      ))}

      {sel && (
        <div
          className={`se-sel${cropped ? " cropped" : ""}`}
          style={{
            left: vr.x * s,
            top: vr.y * s,
            width: vr.w * s,
            height: vr.h * s,
            transform: sel.rot ? `rotate(${sel.rot}deg)` : undefined,
          }}
        >
          {/* The outline IS the crop indicator, per EDGE: a side that was cut
            * goes red and dashed, untouched sides stay mint. You can see at a
            * glance which edges you took off, not just that you cropped. */}
          <div className={`se-edge n${sel.crop_top > 0 ? " cut" : ""}`} />
          <div className={`se-edge e${sel.crop_right > 0 ? " cut" : ""}`} />
          <div className={`se-edge s${sel.crop_bottom > 0 ? " cut" : ""}`} />
          <div className={`se-edge w${sel.crop_left > 0 ? " cut" : ""}`} />
          {sel.crop_left > 0 && <span className="se-crop-n l">{sel.crop_left}</span>}
          {sel.crop_right > 0 && <span className="se-crop-n r">{sel.crop_right}</span>}
          {sel.crop_top > 0 && <span className="se-crop-n t">{sel.crop_top}</span>}
          {sel.crop_bottom > 0 && <span className="se-crop-n b">{sel.crop_bottom}</span>}
          <div className="se-label">
            {sel.label || sel.id}
            {sel.rot ? <span className="se-badge">{Math.round(sel.rot)}°</span> : null}

          </div>
          <div
            className="se-rot"
            title="Drag to rotate (⇧ snaps to 15°)"
            onPointerDown={(e) => {
              e.stopPropagation();
              // Without preventDefault WebKit starts a text-selection drag
              // and takes the pointer with it — the gesture never lands.
              e.preventDefault();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const { x, y } = toCanvas(e);
              gesture.current = {
                kind: "rotate",
                itemId: sel.id,
                startX: x,
                startY: y,
                orig: sel,
                moved: false,
              };
            }}
            onPointerMove={(e) => {
              if (!gesture.current || e.buttons !== 1) return;
              const { x, y } = toCanvas(e);
              applyGesture(x, y);
            }}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
          />
          {HANDLES.map((hd) => (
            <div
              key={hd}
              className={`se-handle se-${hd}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                const { x, y } = toCanvas(e);
                gesture.current = {
                  kind: hd,
                  itemId: sel.id,
                  startX: x,
                  startY: y,
                  orig: sel,
                  moved: false,
                  // ⌥ at grab time decides crop vs resize for the whole drag.
                  crop: e.altKey && hd.length === 1,
                };
              }}
              onPointerMove={(e) => {
                if (!gesture.current || e.buttons !== 1) return;
                const { x, y } = toCanvas(e);
                applyGesture(x, y);
              }}
              onPointerUp={endGesture}
              onPointerCancel={endGesture}
            />
          ))}
        </div>
      )}
    </div>
  );
}
