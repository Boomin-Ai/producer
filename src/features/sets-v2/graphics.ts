import type { RenderNode, Bounds } from "./scene";

export interface GraphicsSurface {
  bounds: Bounds;
  html: string;
  nodeIds: string[];
}
export type GraphicPalette = Readonly<Record<string, string>>;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
const color = (v: unknown, fallback: string) => {
  const value = v ?? fallback;
  if (
    typeof value !== "string" ||
    !/^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$/.test(value)
  )
    throw Error("Graphics paint requires a hex color");
  return value;
};
const number = (v: unknown, fallback: number, min: number, max: number) => {
  const value = v ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw Error("Invalid graphics geometry or style");
  return value;
};

/** Serialize one planner graphics batch, never an entire mixed scene. No scripts,
 * arbitrary CSS, URLs or private data enter this document. The native owner places
 * the returned texture at bounds.x/y in the surrounding ordered group. */
export function graphicsSurface(
  nodes: readonly RenderNode[],
  palette: GraphicPalette,
): GraphicsSurface {
  if (!nodes.length || nodes.length > 256)
    throw Error("Invalid graphics batch size");
  for (const n of nodes) {
    if (
      !["text", "graphic"].includes(n.kind) ||
      n.children.length ||
      n.mask || n.backdrop ||
      n.isolate
    )
      throw Error("Graphics batch must contain only flat graphics leaves");
    number(n.bounds.x, 0, -16384, 16384);
    number(n.bounds.y, 0, -16384, 16384);
    number(n.bounds.width, 0, 0, 16384);
    number(n.bounds.height, 0, 0, 16384);
  }
  const x = Math.floor(Math.min(...nodes.map((n) => n.bounds.x))),
    y = Math.floor(Math.min(...nodes.map((n) => n.bounds.y))),
    width = Math.max(
      1,
      Math.ceil(Math.max(...nodes.map((n) => n.bounds.x + n.bounds.width))) - x,
    ),
    height = Math.max(
      1,
      Math.ceil(Math.max(...nodes.map((n) => n.bounds.y + n.bounds.height))) -
        y,
    );
  if (width > 8192 || height > 8192 || width * height > 4096 * 4096)
    throw Error("Graphics surface exceeds native texture budget");
  const elements = nodes
    .map((n) => {
      const p = n.properties,
        b = n.bounds;
      if (p.visible !== undefined && typeof p.visible !== "boolean")
        throw Error("Invalid visibility");
      const opacity = number(p.opacity, 1, 0, 1),
        rotation = number(p.rotation, 0, -36000, 36000),
        scale = number(p.scale, 1, 0.01, 32);
      // Transforming outside a cropped graphics surface would silently lose pixels.
      // Such nodes need placement transforms in the native graph, not CSS here.
      if (rotation !== 0 || scale !== 1)
        throw Error("Graphics transforms require native placement");
      let style = `position:absolute;left:${b.x - x}px;top:${b.y - y}px;width:${b.width}px;height:${b.height}px;opacity:${opacity};overflow:hidden;`;
      if (p.visible === false) style += "display:none;";
      let content = "";
      if (n.kind === "graphic") {
        const paint =
          p.background ?? (n.resource ? palette[n.resource] : undefined);
        if (paint === undefined) throw Error("Unresolved graphic paint");
        style += `background:${color(paint, "#00000000")};`;
      } else {
        if (p.text !== undefined && typeof p.text !== "string")
          throw Error("Invalid graphics text");
        if (String(p.text ?? "").length > 4096)
          throw Error("Graphics text exceeds limit");
        const align = p.align ?? "left";
        if (!["left", "center", "right"].includes(String(align)))
          throw Error("Invalid text alignment");
        style += `color:${color(p.color, "#ffffff")};background:${color(p.background, "#00000000")};font-size:${number(p.fontSize, 32, 1, 1024)}px;font-weight:${number(p.fontWeight, 400, 100, 1000)};text-align:${align};white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.15;`;
        content = escape(String(p.text ?? ""));
      }
      return `<div style="${style}">${content}</div>`;
    })
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:Arial,sans-serif}*{box-sizing:border-box}</style>${elements}`;
  return {
    bounds: { x, y, width, height },
    html,
    nodeIds: nodes.map((n) => n.id),
  };
}
