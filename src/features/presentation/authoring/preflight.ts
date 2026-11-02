import type {RenderNode,RenderPlan} from '../../sets-v2/scene';
/** Mirrors native graphics batching for admission estimates, not GPU allocation.
 * Keep limits tied to the current native scene owner. Native validation remains
 * authoritative; media decoding, drivers and combined retained stores are not measured. */
export function estimateRenderPlan(plan:RenderPlan&{motion?:{target:string}[];retainedTargets?:string[]}){
 const targets=new Set([...(plan.motion??[]).map(t=>t.target),...(plan.retainedTargets??[])]);
 const density=Math.max(1,plan.target.scaling==='contain'?Math.min(plan.viewport.scaleX,plan.viewport.scaleY):Math.max(plan.viewport.scaleX,plan.viewport.scaleY));
 let nativeNodes=0,graphicsSurfaces=0,graphicsPixels=0,maxDepth=0,oversizedSurface=false;
 const graphicsOnly=(n:RenderNode):boolean=>(!n.mask||n.mask.kind==='rounded')&&!n.backdrop&&!targets.has(n.id)&&['text','graphic','group'].includes(n.kind)&&n.children.every(graphicsOnly);
 const batch=(nodes:RenderNode[],depth:number)=>{
  nativeNodes++;maxDepth=Math.max(maxDepth,depth);graphicsSurfaces++;
  const x=Math.floor(Math.min(...nodes.map(n=>n.bounds.x))),y=Math.floor(Math.min(...nodes.map(n=>n.bounds.y)));
  const w=Math.max(1,Math.ceil(Math.max(...nodes.map(n=>n.bounds.x+n.bounds.width)))-x),h=Math.max(1,Math.ceil(Math.max(...nodes.map(n=>n.bounds.y+n.bounds.height)))-y);
  const pw=Math.ceil(w*density),ph=Math.ceil(h*density),pixels=pw*(ph+1);graphicsPixels+=pixels;
  if(pw>8192||ph>=8192||pixels>4096*4096)oversizedSurface=true;
 };
 const walk=(n:RenderNode,depth=0)=>{
  if(n.kind!=='group'){
   if(['text','graphic'].includes(n.kind))batch([n],depth);else{nativeNodes++;maxDepth=Math.max(maxDepth,depth);}return;
  }
  nativeNodes++;maxDepth=Math.max(maxDepth,depth);let pending:RenderNode[]=[];
  const flush=()=>{if(pending.length){batch(pending,depth+1);pending=[];}};
  for(const child of n.children){if(child.properties.visible===false||!child.bounds.width||!child.bounds.height)continue;if(graphicsOnly(child))pending.push(child);else{flush();walk(child,depth+1);}}flush();
 };
 walk(plan.root);
 const issues:string[]=[];
 if(nativeNodes>128)issues.push(`Estimated native graph needs ${nativeNodes} nodes; current limit is 128. Consolidate artwork or simplify the layout.`);
 if(maxDepth>12)issues.push(`Estimated native depth ${maxDepth} exceeds 12.`);
 if(graphicsSurfaces>16)issues.push(`Estimated graphics surfaces ${graphicsSurfaces} exceed 16. Group contiguous graphics and reduce interleaved sources/effects.`);
 if(graphicsPixels>8*1024*1024)issues.push(`Estimated graphics pixels ${graphicsPixels} exceed 8 Mi pixels. Reduce raster area or output resolution.`);
 if(oversizedSurface)issues.push('A graphics batch exceeds the current per-surface dimension/pixel budget.');
 return {scope:'estimated-native-batching' as const,nativeReadiness:'not-tested' as const,nativeNodes,maxDepth,graphicsSurfaces,graphicsPixels,density,issues};
}
