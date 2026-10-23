import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
const b = await build({
  stdin: {
    contents:
      "export {compileSet} from './src/features/sets-v2/scene';export {planPasses} from './src/features/sets-v2/planner';export {graphicsSurface} from './src/features/sets-v2/graphics';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { compileSet, planPasses, graphicsSurface } = await import(
  "data:text/javascript;base64," +
    Buffer.from(b.outputFiles[0].text).toString("base64")
);
const output = process.argv[2] ?? "docs/sets-v2/native";
fs.mkdirSync(output, { recursive: true });
for (const orientation of ["landscape", "portrait"]) {
  const [w, h] = orientation === "landscape" ? [1920, 1080] : [1080, 1920];
  const gw = Math.floor(w * 0.8),
    gh = Math.floor(h * 0.6);
  const node = (id, kind, x, y, width, height, extra = {}) => ({
    id,
    kind,
    bounds: { x, y, width, height },
    ...extra,
  });
  const root = node("root", "group", 0, 0, w, h, {
    children: [
      node("backdrop", "graphic", 0, 0, w, h, { graphic: "blue" }),
      node("panel", "group", w * 0.1, h * 0.2, gw, gh, {
        mask: { kind: "rounded", radius: 80 },
        isolate: true,
        children: [
          node("panelBackground", "graphic", 0, 0, gw, gh, { graphic: "red" }),
          node("camera", "source", w * 0.2, h * 0.12, w * 0.4, h * 0.36, {
            input: "host",
            fit: "cover",
          }),
          node("foreground", "graphic", w * 0.35, h * 0.27, w * 0.1, h * 0.1, {
            graphic: "yellow",
          }),
        ],
      }),
    ],
  });
  const definition = {
    schema: "producer.set/2",
    id: "nativeProof",
    revision: 1,
    name: "Native mixed group proof",
    inputs: [{ id: "host", label: "Synthetic moving capture", required: true }],
    channels: [],
    canvases: [{ id: orientation, orientation, width: w, height: h, root }],
  };
  const plan = compileSet(
    definition,
    {
      id: "nativeInstance",
      definitionId: "nativeProof",
      bindings: { host: "synthetic-camera" },
    },
    {
      id: "proof",
      orientation,
      width: orientation === "portrait" ? 720 : 1280,
      height: orientation === "portrait" ? 1280 : 720,
      scaling: "contain",
    },
    {},
  );
  const passes = planPasses(plan);
  fs.writeFileSync(
    path.join(output, orientation + "-plan.json"),
    JSON.stringify(plan, null, 2),
  );
  fs.writeFileSync(
    path.join(output, orientation + "-passes.json"),
    JSON.stringify(passes, null, 2),
  );
}
console.log(
  "Generated native fixtures through actual Sets v2 compiler and pass planner",
);

const leaf = (id, kind, x, y, width, height, properties = {}) => ({
  id,
  kind,
  bounds: { x, y, width, height },
  properties,
  children: [],
});
const background = graphicsSurface(
  [
    leaf("cyan", "graphic", 0, 0, 320, 240, { background: "#00ffff" }),
    leaf("backText", "text", 0, 0, 320, 100, {
      text: "HTML BACKGROUND",
      color: "#0000ff",
      fontSize: 40,
    }),
  ],
  {},
);
const foreground = graphicsSurface(
  [
    leaf("transparent", "graphic", 0, 0, 320, 240, { background: "#00000000" }),
    leaf("card", "graphic", 100, 80, 120, 70, { background: "#ffff00" }),
    leaf("frontText", "text", 100, 100, 120, 32, {
      text: "SETS V2",
      color: "#0000ff",
      fontSize: 24,
      fontWeight: 700,
      align: "center",
    }),
  ],
  {},
);
for (const [name, surface] of [
  ["background", background],
  ["foreground", foreground],
]) {
  fs.writeFileSync(path.join(output, name + ".html"), surface.html);
  fs.writeFileSync(
    path.join(output, name + "-surface.json"),
    JSON.stringify({ ...surface, html: undefined }, null, 2),
  );
}
