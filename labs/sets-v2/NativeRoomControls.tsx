import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { compileSet } from "../../src/features/sets-v2/scene";
import { pollSet } from "../../src/features/sets-v2/fixtures";
import type { PublicData } from "../../src/features/sets-v2/data";
import { nativeRoomSmoke } from "./nativeSmoke";
type Status = {
  generation: number;
  preparedRevision: number;
  renderedRevision: number;
  renderSerial: number;
  ready: boolean;
  warmed: boolean;
  transitioning: boolean;
  queued: boolean;
  clockMs: number;
  paused: boolean;
};
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Native diagnostics only. These controls are not the eventual library picker. */
export function NativeRoomControls({ data }: { data: PublicData }) {
  const [status, setStatus] = useState<Status>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState("dissolve"),
    [source, setSource] = useState("sets-v2-demo-source");
  const revision = useRef(0),
    generation = useRef(0),
    preview = useRef<HTMLDivElement>(null);
  const [previewOn, setPreviewOn] = useState(false);
  const smokeStarted = useRef(false);
  useEffect(() => {
    if (
      !isTauri() ||
      smokeStarted.current ||
      new URLSearchParams(location.search).get("nativeSmoke") !== "1"
    )
      return;
    smokeStarted.current = true;
    setBusy(true);
    void nativeRoomSmoke()
      .then(setMessage, (error) => setMessage(String(error)))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    if (!isTauri() || !previewOn || !preview.current) return;
    const element = preview.current;
    let disposed = false,
      attached = false;
    const update = async () => {
      const r = element.getBoundingClientRect();
      try {
        await invoke(attached ? "live_move_preview" : "live_attach_preview", {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
        });
        attached = true;
        if (disposed) await invoke("live_detach_preview");
      } catch (e) {
        if (!disposed) setMessage(String(e));
      }
    };
    void update();
    const observer = new ResizeObserver(() => void update());
    observer.observe(element);
    const move = () => void update();
    window.addEventListener("scroll", move);
    window.addEventListener("resize", move);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("scroll", move);
      window.removeEventListener("resize", move);
      void invoke("live_detach_preview").catch(() => {});
    };
  }, [previewOn]);
  if (!isTauri()) return null;
  const request = async (value: Record<string, unknown>) => {
    const result = await invoke<Status>("live_set_v2", {
      request: { generation: generation.current, ...value },
    });
    setStatus(result);
    return result;
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    await request({ op: "status" });
  };
  const prepare = async (style: "bars" | "spotlight") => {
    const room = await invoke<{ generation: number }>("live_set_status");
    generation.current = room.generation;
    const engine = await invoke<{
      video_height?: number;
      video_width?: number;
    }>("live_engine_status");
    const height = engine.video_height ?? 720,
      width = engine.video_width ?? Math.round((height * 16) / 9);
    const def = pollSet(style);
    const plan = compileSet(
      def,
      { id: "native-room", definitionId: def.id, bindings: { host: source } },
      {
        id: "program",
        orientation: "landscape",
        width,
        height,
        scaling: "contain",
      },
      data,
    );
    const next = ++revision.current;
    await request({ op: "prepare", revision: next, plan });
    for (let i = 0; i < 250; i++) {
      const current = await request({ op: "status" });
      if (current.preparedRevision !== next)
        throw Error("Preparation was replaced");
      if (current.ready && current.warmed) {
        setMessage("Ready off air. Take to show this composition.");
        return;
      }
      await pause(40);
    }
    throw Error(
      "Graphics have not confirmed their first paint. Current output is retained.",
    );
  };
  return (
    <section className="tools">
      <div>
        <strong>Native dev room · experimental v2 adapter</strong>
        <p>
          Controls the isolated room output. Browser previews below remain
          simulations. This adapter currently prepares landscape room output;
          native portrait primitives are tested separately.
        </p>
        <label>
          Room video source ID{" "}
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={busy}
          />
        </label>
        <div className="buttons">
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await invoke("live_add_source", {
                  id: "sets-v2-demo-source",
                  label: "V2 synthetic host",
                  spec: { kind: "color", color: "#20c060" },
                });
                setSource("sets-v2-demo-source");
                setMessage("Synthetic source added to this dev room.");
              })
            }
          >
            Add synthetic host
          </button>
          <button
            disabled={busy}
            onClick={() => void run(() => prepare("bars"))}
          >
            Prepare Audience Desk
          </button>
          <button
            disabled={busy}
            onClick={() => void run(() => prepare("spotlight"))}
          >
            Prepare Spotlight
          </button>
          <select
            aria-label="Native transition"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option>dissolve</option>
            <option>wipe</option>
            <option>slide</option>
          </select>
          <button
            disabled={
              busy || !status?.ready || !status.warmed || status.transitioning
            }
            onClick={() =>
              void run(async () => {
                await request({
                  op: "take",
                  revision: status!.preparedRevision,
                  durationMs: 500,
                  mode,
                });
                for (let i = 0; i < 200; i++) {
                  const s = await request({ op: "status" });
                  if (
                    s.renderedRevision === status!.preparedRevision &&
                    !s.transitioning
                  ) {
                    setMessage("Composition rendered on native room output.");
                    return;
                  }
                  await pause(25);
                }
                throw Error("Native rendered receipt timed out");
              })
            }
          >
            Take
          </button>
          <button
            disabled={busy || !status}
            onClick={() =>
              void run(async () => {
                await request({ op: "pause", paused: !status!.paused });
              })
            }
          >
            {status?.paused ? "Resume clock" : "Pause clock"}
          </button>
          <button disabled={busy || !status} onClick={() => void run(refresh)}>
            Refresh native status
          </button>
          <button
            disabled={busy || !status}
            onClick={() =>
              void run(async () => {
                await request({ op: "return" });
                setMessage("Returned to room sources.");
              })
            }
          >
            Return to room
          </button>
          <button onClick={() => setPreviewOn((value) => !value)}>
            {previewOn ? "Hide native preview" : "Show native preview"}
          </button>
        </div>
        {status && (
          <p>
            Prepared {status.preparedRevision} · rendered{" "}
            {status.renderedRevision} · render {status.renderSerial} · clock{" "}
            {Math.round(status.clockMs)} ms ·{" "}
            {status.transitioning
              ? "transitioning"
              : status.ready
                ? "ready"
                : "preparing"}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {previewOn && (
          <div
            ref={preview}
            aria-label="Actual native room output"
            style={{
              width: 640,
              maxWidth: "100%",
              aspectRatio: "16/9",
              background: "transparent",
              border: "1px solid #597286",
            }}
          />
        )}
      </div>
    </section>
  );
}
