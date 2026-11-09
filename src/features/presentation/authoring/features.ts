import type {PresentationPackage,PresentationNode} from '../schema';
/** Derive requirements from the canonical tree; author-provided metadata is not authority. */
export function packageFeatures(doc:PresentationPackage):string[]{
 const features=new Set<string>(['core@1',...(doc.requires??[])]);
 for(const instance of doc.runtime.instances)for(const capability of doc.runtime.definitions[instance.definition].capabilities)features.add(capability);
 const visit=(n:PresentationNode)=>{
  if(n.mask)features.add('mask@1');if(n.backdrop)features.add('backdrop@1');
  if(n.chart)features.add('chart@1');if(n.scene3d)features.add('scene3d@1');
  if(n.scene3d?.world.dj?.role==='logoOrbit')features.add('dj.logo-orbit@1');
  if(n.shader)features.add(`shader.${n.shader.effect}@1`);n.children?.forEach(visit);
 };
 doc.set.layouts.forEach(l=>visit(l.root));Object.values(doc.set.components).forEach(c=>visit(c.root));
 return [...features].sort();
}
