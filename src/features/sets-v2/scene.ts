import {
  finite,
  object,
  safeKey,
  type DataValue,
  type PublicData,
} from "./data";
import { validatePaint, type Paint } from "./paint";
export type Orientation = "landscape" | "portrait";
export type Scalar = string | number | boolean;
export interface DataBinding {
  data: { channel: string; path: string[] };
  fallback: Scalar;
  stale?: "hold" | "fallback";
  map?: { input: [number, number]; output: [number, number] };
}
export type Property = Scalar | DataBinding;
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface CommonNode {
  id: string;
  bounds: Bounds;
  properties?: Record<string, Property>;
  paint?: Paint;
}
export type SceneNode = CommonNode &
  (
    | {
        kind: "group";
        children: SceneNode[];
        mask?: { kind: "rounded"; radius: number };
        isolate?: boolean;
      }
    | { kind: "text" }
    | { kind: "source"; input: string; fit: "contain" | "cover" }
    | { kind: "asset"; asset: string; fit: "contain" | "cover" }
    | { kind: "graphic"; graphic: string }
    | { kind: "shader"; preset: string }
  );
export interface DesignCanvas {
  id: string;
  orientation: Orientation;
  width: number;
  height: number;
  root: SceneNode;
}
export interface SetDefinition {
  schema: "producer.set/2";
  id: string;
  revision: number;
  name: string;
  inputs: Array<{ id: string; label: string; required: boolean }>;
  channels: string[];
  canvases: DesignCanvas[];
}
export interface SetInstance {
  id: string;
  definitionId: string;
  bindings: Record<string, string>;
}
export interface OutputTarget {
  id: string;
  orientation: Orientation;
  width: number;
  height: number;
  scaling: "contain" | "cover" | "stretch";
}
export interface Viewport {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  clip: Bounds;
}
export type RenderNode = {
  id: string;
  kind: SceneNode["kind"];
  bounds: Bounds;
  properties: Record<string, Scalar>;
  resource?: string;
  fit?: "contain" | "cover";
  mask?: { kind: "rounded"; radius: number };
  children: RenderNode[];
  isolate?: boolean;
  paint?: Paint;
};
export interface RenderPlan {
  definitionId: string;
  definitionRevision: number;
  instanceId: string;
  canvasId: string;
  target: OutputTarget;
  viewport: Viewport;
  root: RenderNode;
  resources: string[];
}
export const DEFAULT_CANVASES: Readonly<
  Record<Orientation, { width: number; height: number }>
> = Object.freeze({
  landscape: Object.freeze({ width: 1920, height: 1080 }),
  portrait: Object.freeze({ width: 1080, height: 1920 }),
});
const allowedProps = [
  "text",
  "color",
  "background",
  "opacity",
  "visible",
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "scale",
  "scaleX",
  "scaleY",
  "fontSize",
  "fontWeight",
  "align",
];
function exact(v: unknown, keys: string[]): Record<string, unknown> {
  const o = object(v);
  if (Object.keys(o).some((k) => !keys.includes(k)))
    throw Error("Unknown definition field");
  return o;
}
function id(v: unknown): asserts v is string {
  if (typeof v !== "string" || !safeKey(v)) throw Error("Invalid identity");
}
function scalar(v: unknown): asserts v is Scalar {
  if (typeof v === "number") finite(v, -1e9, 1e9);
  else if (typeof v !== "boolean" && (typeof v !== "string" || v.length > 4096))
    throw Error("Invalid property");
}
function property(v: Property, channels: Set<string>): void {
  if (typeof v !== "object") {
    scalar(v);
    return;
  }
  exact(v, ["data", "fallback", "stale", "map"]);
  exact(v.data, ["channel", "path"]);
  if (
    !channels.has(v.data.channel) ||
    !Array.isArray(v.data.path) ||
    v.data.path.length > 12 ||
    v.data.path.some(
      (k) => typeof k !== "string" || (!safeKey(k) && !/^\d{1,3}$/.test(k)),
    )
  )
    throw Error("Invalid data binding");
  scalar(v.fallback);
  if (v.stale !== undefined && !["hold", "fallback"].includes(v.stale))
    throw Error("Invalid stale policy");
  if (v.map) {
    exact(v.map, ["input", "output"]);
    for (const range of [v.map.input, v.map.output]) {
      if (!Array.isArray(range) || range.length !== 2)
        throw Error("Invalid mapping");
      range.forEach((n) => finite(n, -1e9, 1e9));
    }
    if (v.map.input[0] >= v.map.input[1] || typeof v.fallback !== "number")
      throw Error("Invalid numeric mapping");
  }
}
export function validateDefinition(input: unknown): SetDefinition {
  const d = exact(input, [
    "schema",
    "id",
    "revision",
    "name",
    "inputs",
    "channels",
    "canvases",
  ]) as unknown as SetDefinition;
  if (d.schema !== "producer.set/2") throw Error("Unsupported set format");
  id(d.id);
  finite(d.revision, 1, Number.MAX_SAFE_INTEGER);
  if (
    !Number.isSafeInteger(d.revision) ||
    typeof d.name !== "string" ||
    !d.name ||
    d.name.length > 160
  )
    throw Error("Invalid definition header");
  if (
    !Array.isArray(d.inputs) ||
    d.inputs.length > 64 ||
    !Array.isArray(d.channels) ||
    d.channels.length > 64 ||
    !Array.isArray(d.canvases) ||
    d.canvases.length < 1 ||
    d.canvases.length > 2
  )
    throw Error("Invalid definition collection");
  const roles = new Set<string>();
  for (const i of d.inputs) {
    exact(i, ["id", "label", "required"]);
    id(i.id);
    if (
      roles.has(i.id) ||
      typeof i.required !== "boolean" ||
      typeof i.label !== "string" ||
      i.label.length > 120
    )
      throw Error("Invalid source role");
    roles.add(i.id);
  }
  const channels = new Set<string>();
  for (const c of d.channels) {
    id(c);
    if (channels.has(c)) throw Error("Duplicate channel");
    channels.add(c);
  }
  const canvases = new Set<string>(),
    orientations = new Set<Orientation>();
  let budget = 0;
  for (const c of d.canvases) {
    exact(c, ["id", "orientation", "width", "height", "root"]);
    id(c.id);
    if (
      canvases.has(c.id) ||
      orientations.has(c.orientation) ||
      !["portrait", "landscape"].includes(c.orientation)
    )
      throw Error("Invalid canvas identity");
    canvases.add(c.id);
    orientations.add(c.orientation);
    for (const size of [c.width, c.height]) {
      finite(size, 320, 8192);
      if (!Number.isInteger(size))
        throw Error("Canvas dimensions must be integers");
    }
    if (c.orientation === "portrait" ? c.height < c.width : c.width < c.height)
      throw Error("Canvas orientation does not match dimensions");
    const ids = new Set<string>();
    const visit = (n: SceneNode, depth: number) => {
      if (++budget > 2048 || depth > 16)
        throw Error("Scene graph exceeds budget");
      const specific = {
        group: ["children", "mask", "isolate"],
        text: [],
        source: ["input", "fit"],
        asset: ["asset", "fit"],
        graphic: ["graphic"],
        shader: ["preset"],
      }[n.kind];
      if (!specific) throw Error("Unknown scene kind");
      exact(n, ["id", "kind", "bounds", "properties", "paint", ...specific]);
      if (n.paint) {
        if (!["text", "graphic"].includes(n.kind))
          throw Error("Paint is only valid on graphics leaves");
        validatePaint(n.paint);
      }
      id(n.id);
      if (ids.has(n.id)) throw Error("Duplicate node identity");
      ids.add(n.id);
      exact(n.bounds, ["x", "y", "width", "height"]);
      finite(n.bounds.x, -16384, 16384);
      finite(n.bounds.y, -16384, 16384);
      finite(n.bounds.width, 0, 16384);
      finite(n.bounds.height, 0, 16384);
      if (n.properties) {
        object(n.properties);
        for (const [k, v] of Object.entries(n.properties)) {
          if (!allowedProps.includes(k)) throw Error("Unknown visual property");
          property(v, channels);
        }
      }
      if (n.kind === "group") {
        if (
          !Array.isArray(n.children) ||
          n.children.length > 512 ||
          (n.isolate !== undefined && typeof n.isolate !== "boolean")
        )
          throw Error("Invalid group");
        if (n.mask) {
          exact(n.mask, ["kind", "radius"]);
          if (n.mask.kind !== "rounded") throw Error("Unsupported mask");
          finite(n.mask.radius, 0, 8192);
        }
        n.children.forEach((child) => visit(child, depth + 1));
      }
      if (n.kind === "source" && !roles.has(n.input))
        throw Error("Unknown source role");
      if (n.kind === "source" || n.kind === "asset") {
        if (!["contain", "cover"].includes(n.fit))
          throw Error("Invalid content fit");
      }
      if (n.kind === "asset") id(n.asset);
      if (n.kind === "graphic") id(n.graphic);
      if (n.kind === "shader") id(n.preset);
    };
    visit(c.root, 0);
    if (c.root.kind !== "group") throw Error("Canvas root must be a group");
    if (
      c.root.bounds.x !== 0 ||
      c.root.bounds.y !== 0 ||
      c.root.bounds.width !== c.width ||
      c.root.bounds.height !== c.height
    )
      throw Error("Canvas root must match design dimensions");
  }
  return structuredClone(d);
}
export function viewport(
  canvas: { width: number; height: number },
  target: OutputTarget,
): Viewport {
  id(target.id);
  for (const n of [canvas.width, canvas.height]) finite(n, 1, 16384);
  for (const n of [target.width, target.height]) {
    finite(n, 1, 16384);
    if (!Number.isInteger(n)) throw Error("Output dimensions must be integers");
  }
  if (!["contain", "cover", "stretch"].includes(target.scaling))
    throw Error("Invalid output scaling");
  const sx = target.width / canvas.width,
    sy = target.height / canvas.height;
  const ratio =
    target.scaling === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
  const scaleX = target.scaling === "stretch" ? sx : ratio,
    scaleY = target.scaling === "stretch" ? sy : ratio;
  return {
    scaleX,
    scaleY,
    offsetX:
      Math.abs(target.width - canvas.width * scaleX) < 1e-8
        ? 0
        : (target.width - canvas.width * scaleX) / 2,
    offsetY:
      Math.abs(target.height - canvas.height * scaleY) < 1e-8
        ? 0
        : (target.height - canvas.height * scaleY) / 2,
    clip: { x: 0, y: 0, width: target.width, height: target.height },
  };
}
function validateVisualProperty(key: string, value: Scalar): void {
  if (["x", "y", "width", "height"].includes(key)) {
    finite(value, key === "width" || key === "height" ? 0 : -16384, 16384);
  } else if (key === "opacity") finite(value, 0, 1);
  else if (["scale", "scaleX", "scaleY"].includes(key)) finite(value, 0.01, 32);
  else if (key === "rotation") finite(value, -36000, 36000);
  else if (key === "fontSize") finite(value, 1, 1024);
  else if (key === "fontWeight") finite(value, 100, 1000);
  else if (key === "visible" && typeof value !== "boolean")
    throw Error("Visibility must be boolean");
  else if (
    ["color", "background"].includes(key) &&
    (typeof value !== "string" ||
      !/^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$/.test(value))
  )
    throw Error("Paint requires a hex color");
  else if (
    key === "align" &&
    !["left", "center", "right"].includes(String(value))
  )
    throw Error("Invalid text alignment");
  else if (key === "text" && typeof value !== "string")
    throw Error("Text must be a string");
}
function resolve(p: Property, data: PublicData): Scalar {
  if (typeof p !== "object") return p;
  const channel = data[p.data.channel];
  let v: DataValue | undefined;
  if (channel && (!channel.stale || p.stale === "hold")) {
    v = channel.value;
    for (const k of p.data.path) {
      if (
        v === null ||
        typeof v !== "object" ||
        !Object.prototype.hasOwnProperty.call(v, k)
      ) {
        v = undefined;
        break;
      }
      v = (v as Record<string, DataValue>)[k];
    }
  }
  if (
    typeof v !== typeof p.fallback ||
    v === null ||
    typeof v === "object" ||
    v === undefined
  )
    return p.fallback;
  if (p.map) {
    if (typeof v !== "number") return p.fallback;
    const t = Math.max(
      0,
      Math.min(1, (v - p.map.input[0]) / (p.map.input[1] - p.map.input[0])),
    );
    return p.map.output[0] + t * (p.map.output[1] - p.map.output[0]);
  }
  return v as Scalar;
}
/** Ordered graph IR only: no DOM special plane, no private data attached to plans.
 * Native render passes/groups are implemented by the next milestone's adapter. */
export function compileSet(
  input: unknown,
  instance: SetInstance,
  target: OutputTarget,
  data: PublicData,
): RenderPlan {
  const d = validateDefinition(input);
  id(instance.id);
  if (instance.definitionId !== d.id)
    throw Error("Instance definition mismatch");
  object(instance.bindings);
  const canvas = d.canvases.find((c) => c.orientation === target.orientation);
  if (!canvas) throw Error("Set does not support requested orientation");
  const resources = new Set<string>();
  const walk = (n: SceneNode): RenderNode => {
    const properties: Record<string, Scalar> = {};
    for (const [k, v] of Object.entries(n.properties ?? {}))
      properties[k] = resolve(v, data);
    for (const [key, value] of Object.entries(properties))
      validateVisualProperty(key, value);
    const bounds = { ...n.bounds };
    for (const key of ["x", "y", "width", "height"] as const) {
      if (properties[key] !== undefined) {
        bounds[key] = finite(
          properties[key],
          key === "width" || key === "height" ? 0 : -16384,
          16384,
        );
        delete properties[key];
      }
    }
    if (properties.opacity !== undefined) finite(properties.opacity, 0, 1);
    if (
      properties.visible !== undefined &&
      typeof properties.visible !== "boolean"
    )
      throw Error("Visibility must be boolean");
    const out: RenderNode = {
      id: n.id,
      kind: n.kind,
      bounds,
      properties,
      children: [],
      ...(n.paint ? { paint: structuredClone(n.paint) } : {}),
    };
    if (n.kind === "source") {
      const handle = instance.bindings[n.input];
      if (!handle && d.inputs.find((i) => i.id === n.input)?.required)
        throw Error(`Missing source: ${n.input}`);
      if (handle) {
        if (typeof handle !== "string" || handle.length > 160)
          throw Error("Invalid resource handle");
        out.resource = handle;
        resources.add(handle);
      }
      out.fit = n.fit;
    }
    if (n.kind === "asset") {
      out.resource = "asset:" + n.asset;
      out.fit = n.fit;
      resources.add(out.resource);
    }
    if (n.kind === "graphic") {
      out.resource = "graphic:" + n.graphic;
      resources.add(out.resource);
    }
    if (n.kind === "shader") {
      out.resource = "shader:" + n.preset;
      resources.add(out.resource);
    }
    if (n.kind === "group") {
      out.children = n.children.map(walk);
      if (n.mask) out.mask = { ...n.mask };
      if (n.isolate !== undefined) out.isolate = n.isolate;
    }
    return out;
  };
  return {
    definitionId: d.id,
    definitionRevision: d.revision,
    instanceId: instance.id,
    canvasId: canvas.id,
    target: { ...target },
    viewport: viewport(canvas, target),
    root: walk(canvas.root),
    resources: [...resources],
  };
}
