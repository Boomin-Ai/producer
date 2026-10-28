import type {
  OutputProjection,
  RenderNode as AuthorNode,
} from "../presentation/projection";
import type { RenderNode, RenderPlan, OutputTarget } from "./scene";
import { viewport } from "./scene";
import { PAINT_KEYS, type Paint, validatePaint } from "./paint";

export function nativeNodeId(value: string): string {
  let hash = 2166136261;
  for (const c of value) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return "node-" + (hash >>> 0).toString(16);
}
/** Lower the room editor's resolved layout into one ordered native graph.
 * The browser resolves CSS layout only; OBS composites the resulting graphics,
 * media and source placements. This does not rasterize HTML into a canvas. */
export async function compileRoomScene(
  projection: OutputProjection,
  options: {
    definitionId: string;
    instanceId: string;
    canvasId: string;
    target: OutputTarget;
    bindings: Record<string, string>;
    retainedTargets?:string[];
  },
): Promise<RenderPlan> {
  const container = document.createElement("div");
  container.style.cssText = `all:initial;box-sizing:border-box;position:fixed;left:-30000px;top:0;width:${projection.width}px;height:${projection.height}px;visibility:hidden;pointer-events:none;contain:layout style;`;
  const shaders: Record<string, unknown> = {};
  const charts:Record<string,import("../presentation/charts").ChartSpec>={};
  const scenes3d: Record<string, unknown> = {};
  const entries = new Map<
    string,
    { node: AuthorNode; element: HTMLDivElement; transform: string }
  >();
  const build = (node: AuthorNode): HTMLDivElement => {
    const element = document.createElement("div");
    element.style.cssText =
      "all:initial;box-sizing:border-box;display:block;font-family:inherit;font-size:inherit;line-height:inherit;color:inherit;";
    for (const [key, value] of Object.entries(node.styles)) {
      if (value === undefined) continue;
      (element.style as unknown as Record<string, string>)[key] =
        typeof value === "number" &&
        !["opacity", "fontWeight", "lineHeight"].includes(key)
          ? `${value}px`
          : String(value);
    }
    if (node.text !== undefined) element.textContent = node.text;
    entries.set(node.id, {
      node,
      element,
      transform:
        typeof node.styles.transform === "string"
          ? node.styles.transform
          : "none",
    });
    for (const child of node.children) element.appendChild(build(child));
    return element;
  };
  container.appendChild(build(projection.root));
  document.body.appendChild(container);
  try {
    await document.fonts.ready;
    // Measure authored layout before transforms so native placements can apply
    // the transform once, around their own center, without inflated AABBs.
    for (const { element } of entries.values())
      element.style.transform = "none";
    const resources = new Set<string>();
    const motionTargets = new Set(
      [...(projection.timeline?.tracks.map((t) => t.target) ?? []),...(options.retainedTargets??[])],
    );
    const assignedIds = new Set<string>();
    const identity = (name: string) => {
      const key = nativeNodeId(name);
      if (assignedIds.has(key)) throw Error("Set node identity collision");
      assignedIds.add(key);
      return key;
    };
    const walk = (node: AuthorNode, parent?: DOMRect): RenderNode => {
      const entry = entries.get(node.id)!;
      const rect = entry.element.getBoundingClientRect(),
        style = getComputedStyle(entry.element);
      const bounds = {
        x: parent ? rect.x - parent.x : 0,
        y: parent ? rect.y - parent.y : 0,
        width: rect.width,
        height: rect.height,
      };
      const properties: RenderNode["properties"] = {
        opacity: Number(style.opacity) || 0,
      };
      if (entry.transform && entry.transform !== "none") {
        const matrix = new DOMMatrix(entry.transform);
        if (
          !matrix.is2D ||
          Math.abs(matrix.a * matrix.c + matrix.b * matrix.d) > 0.001
        )
          throw Error(
            "Set transform requires an unsupported skew/3D placement",
          );
        properties.rotation = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
        properties.scaleX = Math.hypot(matrix.a, matrix.b);
        properties.scaleY = Math.hypot(matrix.c, matrix.d);
        bounds.x += matrix.e;
        bounds.y += matrix.f;
      }
      const common = {
        id: identity(node.id),
        bounds,
        properties,
        children: [] as RenderNode[],
      };
      // Native effects are placement-local groups, including source/media leaves.
      const wrap=(leaf:RenderNode):RenderNode=>node.mask||node.backdrop?{...common,kind:'group',...(node.mask?{mask:node.mask}:{}),...(node.backdrop?{backdrop:node.backdrop}:{}),isolate:true,children:[{...leaf,id:identity(node.id+'-content'),bounds:{...bounds,x:0,y:0},properties:{...leaf.properties,opacity:1}}]}:leaf;
      if (node.type === "slot") {
        const resource = options.bindings[node.slotId ?? ""];
        if (!resource) return wrap({ ...common, kind: "group" });
        resources.add(resource);
        return wrap({
          ...common,
          kind: "source",
          fit: node.framing?.mode === "fit" ? "contain" : "cover",
          ...(resource ? { resource } : {}),
          ...({ appearance: node.appearance, framing: node.framing } as object),
        });
      }
      if (node.type === "media") {
        const resource = "asset:" + node.assetId;
        resources.add(resource);
        return wrap({
          ...common,
          kind: "asset",
          resource,
          fit: node.fit ?? "contain",
          ...({ playback: node.playback, looping: node.loop } as object),
        });
      }
      if(node.type==='chart'){const key=nativeNodeId(options.definitionId+':'+options.instanceId+':'+node.chart!.id);if(charts[key])throw Error('Duplicate chart identity');charts[key]={...node.chart!,id:key};const resource='chart:'+key;resources.add(resource);return {...common,kind:'chart',resource};}
      if(node.type==='scene3d'){
        const key=node.scene3d!.id+'-'+node.scene3d!.pass,resource='scene3d:'+key;
        if(scenes3d[key])throw Error('Duplicate 3D resource pass');
        resources.add(resource);scenes3d[key]=node.scene3d;
        return {...common,kind:'scene3d',resource};
      }
      if (node.type === "shader") {
        const resource = "shader:" + common.id;
        resources.add(resource);
        shaders[common.id] = node.shader;
        return { ...common, kind: "shader", resource };
      }
      const paint: Paint = {};
      for (const key of PAINT_KEYS) {
        if (node.styles[key] !== undefined) paint[key] = node.styles[key];
      }
      if (node.type === "text") {
        // Inherited text metrics are made explicit at the native graphics boundary.
        for (const key of [
          "fontSize",
          "fontWeight",
          "fontFamily",
          "lineHeight",
          "letterSpacing",
          "color",
          "textAlign",
        ] as const) {
          if (paint[key] === undefined) paint[key] = style[key];
        }
        validatePaint(paint);
        const text: RenderNode = {
          ...common,
          kind: "text",
          properties: { ...properties, text: node.text ?? "" },
          paint,
        };
        if (
          motionTargets.has(node.id) ||
          properties.rotation ||
          properties.scaleX ||
          properties.scaleY
        ) {
          return {
            ...common,
            kind: "group",
            children: [
              {
                ...text,
                id: identity(node.id + "-glyph"),
                bounds: {
                  x: 0,
                  y: 0,
                  width: bounds.width,
                  height: bounds.height,
                },
                properties: { text: node.text ?? "" },
              },
            ],
          };
        }
        return text;
      }
      const children: RenderNode[] = [];
      if (Object.keys(paint).length) {
        validatePaint(paint);
        resources.add("graphic:custom");
        children.push({
          id: identity(node.id + "-paint"),
          kind: "graphic",
          bounds: { x: 0, y: 0, width: bounds.width, height: bounds.height },
          properties: { background: "#00000000" },
          resource: "graphic:custom",
          paint,
          children: [],
        });
      }
      children.push(...node.children.map((child) => walk(child, rect)));
      let radius = 0;
      const clipped = ["hidden", "clip"].includes(style.overflow);
      if (clipped) {
        const raw = style.borderTopLeftRadius;
        radius = raw.endsWith("%")
          ? (Math.min(bounds.width, bounds.height) * parseFloat(raw)) / 100
          : parseFloat(raw) || 0;
      }
      return {
        ...common,
        kind: "group",
        children,
        ...(node.backdrop?{backdrop:node.backdrop}:{}),
        ...(node.mask?{mask:node.mask,isolate:true}:clipped
          ? { mask: { kind: "rounded" as const, radius }, isolate: true }
          : {}),
      };
    };
    const root = walk(projection.root);
    let backdropCount=0,maskCount=0,backdropArea=0;
    const checkEffects=(n:RenderNode,parent?:RenderNode)=>{
      if(n.mask&&n.mask.kind!=='rounded')maskCount++;
      if(n.backdrop){backdropCount++;backdropArea+=n.bounds.width*n.bounds.height;if(!parent||n.bounds.x<0||n.bounds.y<0||n.bounds.x+n.bounds.width>parent.bounds.width+.01||n.bounds.y+n.bounds.height>parent.bounds.height+.01)throw Error('Backdrop must fit its local group');}
      n.children.forEach(c=>checkEffects(c,n));
    };checkEffects(root);
    if(backdropCount>4||maskCount>16||backdropArea>4194304)throw Error('Layer effect budget exceeded');
    root.bounds = {
      x: 0,
      y: 0,
      width: projection.width,
      height: projection.height,
    };
    return {
      definitionId: options.definitionId,
      definitionRevision: Math.max(1, projection.revision),
      instanceId: options.instanceId,
      canvasId: options.canvasId,
      target: options.target,
      viewport: viewport(
        { width: projection.width, height: projection.height },
        options.target,
      ),
      root,
      resources: [...resources],
      ...(Object.keys(charts).length?{charts}:{}),
      ...({
        assets: projection.assets ?? {},
        shaders,
        scenes3d,
        clock: projection.timeline?.clock,
        retainedTargets:(options.retainedTargets??[]).map(nativeNodeId),
        motion:
          projection.timeline?.tracks.map((track) => ({
            ...track,
            target: nativeNodeId(track.target),
          })) ?? [],
      } as object),
    };
  } finally {
    container.remove();
  }
}
