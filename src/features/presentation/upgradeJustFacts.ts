import type {PresentationPackage} from './schema';

/** Add question-only headlines to the original showcase without replacing
 * user-authored modules, values, bindings or layouts. */
export function upgradeJustFacts(doc:PresentationPackage):PresentationPackage {
 if(doc.id!=='just-facts'||doc.version!=='1.0.0')return doc;
 const next=structuredClone(doc);
 for(const layout of next.set.layouts)for(const node of layout.root.children??[]){
  if(node.type!=='text'||node.id!=='headline')continue;
  const text=node.text;
  if(typeof text==='object'&&'op'in text&&text.op==='if'
    &&JSON.stringify(text.args[0])===JSON.stringify({get:'modules.research.hasAnswer'})){
   node.text={op:'if',args:[{op:'eq',args:[{get:'modules.research.questionDisplay'},'']},text.args[2],text.args[1]]};
  }
 }
 next.version='1.0.1';
 return next;
}
