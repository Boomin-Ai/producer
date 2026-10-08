import type { PresentationPackage, PresentationNode } from './schema';

/** Content belongs to the layout that references it, including shared components. */
export function layoutFieldKeys(doc:PresentationPackage,layoutId:string):Set<string> {
  const keys=new Set<string>();
  const binding=(value:unknown)=>{
    if(!value || typeof value!=='object')return;
    const b=value as {get?:string;args?:unknown[]};
    if(b.get?.startsWith('values.'))keys.add(b.get.split('.')[1]);
    b.args?.forEach(binding);
  };
  const visit=(node:PresentationNode,ancestors:Set<string>)=>{
    binding(node.text);binding(node.when);
    Object.values(node.styles??{}).forEach(binding);
    Object.values(node.appearance??{}).forEach(binding);
    Object.values(node.props??{}).forEach(binding);
    node.children?.forEach(child=>visit(child,ancestors));
    if(node.component && !ancestors.has(node.component)){
      const component=doc.set.components[node.component];
      if(component)visit(component.root,new Set([...ancestors,node.component]));
    }
  };
  const layout=doc.set.layouts.find(layout=>layout.id===layoutId);
  if(layout)visit(layout.root,new Set());
  return keys;
}
