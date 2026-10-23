import { useMemo, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { DataHub } from "../../src/features/sets-v2/data";
import {
  PollSession,
  pollDataSchema,
} from "../../src/features/sets-v2/interactions";
import {
  compileSet,
  type Orientation,
  type RenderNode,
} from "../../src/features/sets-v2/scene";
import { pollSet } from "../../src/features/sets-v2/fixtures";
import "./style.css";
import { NativeRoomControls } from "./NativeRoomControls";
const hub = new DataHub("local-lab");
hub.register({
  id: "audiencePoll",
  producer: "audience",
  schema: pollDataSchema,
  maxAgeMs: 3600000,
});
const poll = new PollSession({
  id: "cityPoll",
  question: "Which story should we cover next?",
  choices: [
    { id: "a", label: "Neighborhoods" },
    { id: "b", label: "College life" },
  ],
  allowChange: true,
  maxVoters: 10000,
});
let revision = 0,
  voter = 0;
const publish = () =>
  hub.publish(
    { roomId: "local-lab", producer: "audience" },
    {
      roomId: "local-lab",
      channel: "audiencePoll",
      generation: hub.generation("audiencePoll"),
      revision: ++revision,
      observedAt: Date.now(),
      value: poll.data(),
    },
  );
publish();
const palette: Record<string, string> = {
  navy: "#111d34",
  gold: "#e4b969",
  panel: "#19223a",
  pink: "#d94e99",
};
function Node({ node }: { node: RenderNode }) {
  const p = node.properties,
    b = node.bounds;
  const style: CSSProperties = {
    position: "absolute",
    left: b.x,
    top: b.y,
    width: b.width,
    height: b.height,
    boxSizing: "border-box",
    opacity: typeof p.opacity === "number" ? p.opacity : 1,
    overflow: node.mask ? "hidden" : undefined,
    borderRadius: node.mask?.radius,
    display: p.visible === false ? "none" : undefined,
  };
  if (node.kind === "group")
    return (
      <div style={style} data-scene-node={node.id}>
        {node.children.map((n) => (
          <Node key={n.id} node={n} />
        ))}
      </div>
    );
  if (node.kind === "text")
    Object.assign(style, {
      fontSize: p.fontSize ?? 30,
      color: p.color ?? "#fff",
      fontWeight: 750,
      lineHeight: 1.12,
    });
  if (node.kind === "graphic")
    style.background =
      palette[(node.resource ?? "").split(":")[1]] ?? "#1c2940";
  if (node.kind === "source")
    Object.assign(style, {
      background: "linear-gradient(145deg,#33415b,#223048)",
      borderRadius: 28,
      display: "grid",
      placeItems: "center",
      fontSize: 36,
      color: "#b8c5de",
    });
  return (
    <div style={style} data-scene-node={node.id}>
      {node.kind === "text"
        ? String(p.text ?? "")
        : node.kind === "source"
          ? "Host source · simulation"
          : null}
    </div>
  );
}
function App() {
  const [version, setVersion] = useState(0),
    [orientation, setOrientation] = useState<Orientation>("landscape"),
    [width, setWidth] = useState(1280),
    [error, setError] = useState("");
  const data = useMemo(() => hub.snapshot(), [version]);
  const change = (fn: () => void) => {
    try {
      fn();
      publish();
      setVersion((x) => x + 1);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  const state = poll.publicState();
  return (
    <main>
      <header>
        <div>
          <small>PRODUCER / SETS V2</small>
          <h1>One audience. Different sets.</h1>
          <p>
            Runtime foundation lab · simulated sources · no native output or
            network connections
          </p>
        </div>
        <span className="badge">LOCAL DEVELOPMENT</span>
      </header>
      <NativeRoomControls data={data} />
      <section className="tools">
        <div>
          <strong>Audience interaction</strong>
          <div className="buttons">
            <button onClick={() => change(() => poll.start())}>
              Open poll
            </button>
            <button
              disabled={!state.open}
              onClick={() =>
                change(() => {
                  poll.cast("member-" + ++voter, {
                    round: state.round,
                    sequence: 1,
                    choice: "a",
                  });
                })
              }
            >
              Vote A
            </button>
            <button
              disabled={!state.open}
              onClick={() =>
                change(() => {
                  poll.cast("member-" + ++voter, {
                    round: state.round,
                    sequence: 1,
                    choice: "b",
                  });
                })
              }
            >
              Vote B
            </button>
            <button onClick={() => change(() => poll.close())}>
              Close poll
            </button>
            <button
              disabled={state.open}
              onClick={() => change(() => poll.reveal())}
            >
              Reveal results
            </button>
            <button onClick={() => change(() => poll.reset())}>
              New round
            </button>
          </div>
          <p>
            Votes stay private until reveal. Switching canvas or visual style
            does not reset the poll.
          </p>
        </div>
        <div>
          <strong>Set-owned design canvas → output size</strong>
          <div className="buttons">
            <button
              aria-pressed={orientation === "landscape"}
              onClick={() => {
                setOrientation("landscape");
                setWidth(1280);
              }}
            >
              Landscape · 1920×1080
            </button>
            <button
              aria-pressed={orientation === "portrait"}
              onClick={() => {
                setOrientation("portrait");
                setWidth(720);
              }}
            >
              Portrait · 1080×1920
            </button>
            <label>
              Output width{" "}
              <select
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
              >
                {[640, 720, 1080, 1280, 1920].map((w) => (
                  <option key={w}>{w}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </section>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section className={"previews " + orientation}>
        {(["bars", "spotlight"] as const).map((style) => {
          const def = pollSet(style);
          const height = Math.round(
            width * (orientation === "landscape" ? 9 / 16 : 16 / 9),
          );
          const plan = compileSet(
            def,
            {
              id: "instance-" + style,
              definitionId: def.id,
              bindings: { host: "shared-camera" },
            },
            { id: "preview", orientation, width, height, scaling: "contain" },
            data,
          );
          const canvas = def.canvases.find(
            (c) => c.orientation === orientation,
          )!;
          const displayWidth = orientation === "landscape" ? 640 : 400;
          const previewScale = displayWidth / width;
          return (
            <article key={style}>
              <h2>{def.name}</h2>
              <p>
                Same poll channel · round {state.round} ·{" "}
                {state.open
                  ? "voting open"
                  : state.revealed
                    ? "results revealed"
                    : "results hidden"}
              </p>
              <div
                className="viewport"
                style={{ width: displayWidth, height: height * previewScale }}
              >
                <div
                  style={{
                    width,
                    height,
                    transform: `scale(${previewScale})`,
                    transformOrigin: "top left",
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: plan.viewport.offsetX,
                      top: plan.viewport.offsetY,
                      width: canvas.width,
                      height: canvas.height,
                      transform: `scale(${plan.viewport.scaleX},${plan.viewport.scaleY})`,
                      transformOrigin: "top left",
                    }}
                  >
                    <Node node={plan.root} />
                  </div>
                </div>
              </div>
              <p>
                Output {width}×{height} · design scale{" "}
                {plan.viewport.scaleX.toFixed(3)}
              </p>
            </article>
          );
        })}
      </section>
      <details>
        <summary>Exact public data delivered to visual bindings</summary>
        <pre data-testid="public-data">{JSON.stringify(data, null, 2)}</pre>
      </details>
      <footer>
        This is an ordered DOM diagnostic of the v2 render plan. OBS groups,
        live captures, native animation and direct-to-output integration are the
        next milestones.
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
