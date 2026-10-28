import type { Bounds, RenderNode, RenderPlan } from "./scene";
export type RenderOperation =
  | {
      op: "begin-group";
      id: string;
      bounds: Bounds;
      offscreen: boolean;
      mask?: import('../presentation/visualEffects').LayerMask;
      backdrop?: import('../presentation/visualEffects').BackdropEffect;
      properties: RenderNode["properties"];
    }
  | { op: "end-group"; id: string }
  | { op: "graphics"; id: string; nodes: RenderNode[] }
  | { op: "source" | "asset" | "shader" | "chart"; node: RenderNode };
export interface PassPlan {
  operations: RenderOperation[];
  graphicsSurfaces: number;
  offscreenGroups: number;
  estimatedRGBABytes: number;
}
/** Backend-neutral ordered pass plan. Memory estimates are at design resolution,
 * excluding buffering/backend staging; adapters must enforce actual allocation budgets. Adapters must preserve order, group transforms,
 * alpha and mask semantics. A graphics batch never jumps across a native source. */
export function planPasses(
  plan: RenderPlan,
  budget = { surfaces: 32, offscreenGroups: 32, rgbaBytes: 256 * 1024 * 1024 },
): PassPlan {
  const operations: RenderOperation[] = [];
  let graphicsSurfaces = 0,
    offscreenGroups = 0,
    estimatedRGBABytes = 0;
  const bytes = (bounds: Bounds) =>
    Math.ceil(bounds.width) * Math.ceil(bounds.height) * 4;
  const group = (node: RenderNode) => {
    const offscreen =
      node.isolate === true ||
      !!node.mask || !!node.backdrop || node.children.some(c=>!!c.backdrop) ||
      (node.properties.opacity !== undefined && node.properties.opacity !== 1);
    if (offscreen) {
      offscreenGroups++;
      estimatedRGBABytes += bytes(node.bounds);
    }
    if(node.children.some(c=>!!c.backdrop))estimatedRGBABytes+=3*bytes(node.bounds)+Math.ceil(node.bounds.width)*48*4;
    operations.push({
      op: "begin-group",
      id: node.id,
      bounds: { ...node.bounds },
      offscreen,
      ...(node.mask ? { mask: { ...node.mask } } : {}),
      ...(node.backdrop?{backdrop:{...node.backdrop}}:{}),
      properties: { ...node.properties },
    });
    let graphics: RenderNode[] = [];
    const flush = () => {
      if (!graphics.length) return;
      graphicsSurfaces++;
      const left = Math.min(...graphics.map((n) => n.bounds.x)),
        top = Math.min(...graphics.map((n) => n.bounds.y));
      const right = Math.max(
          ...graphics.map((n) => n.bounds.x + n.bounds.width),
        ),
        bottom = Math.max(...graphics.map((n) => n.bounds.y + n.bounds.height));
      estimatedRGBABytes +=
        Math.max(0, right - left) * Math.max(0, bottom - top) * 4;
      operations.push({
        op: "graphics",
        id: `${node.id}-graphics-${graphicsSurfaces}`,
        nodes: structuredClone(graphics),
      });
      graphics = [];
    };
    for (const child of node.children) {
      if (child.properties.visible === false) continue;
      if (["text", "graphic"].includes(child.kind)) {
        graphics.push(child);
        continue;
      }
      flush();
      if (child.kind === "group") group(child);
      else if (
        child.kind === "source" ||
        child.kind === "asset" ||
        child.kind === "chart" || child.kind === "shader"
      )
        operations.push({ op: child.kind, node: structuredClone(child) });
    }
    flush();
    operations.push({ op: "end-group", id: node.id });
  };
  group(plan.root);
  if (
    graphicsSurfaces > budget.surfaces ||
    offscreenGroups > budget.offscreenGroups ||
    estimatedRGBABytes > budget.rgbaBytes
  )
    throw Error("Render pass resource budget exceeded");
  return { operations, graphicsSurfaces, offscreenGroups, estimatedRGBABytes };
}
