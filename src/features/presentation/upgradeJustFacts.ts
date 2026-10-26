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

/** The redesigned show replaces the original three-phase showcase. Preserve
 * compatible names and added set-owned modules, with bindings kept by the room. */
export function upgradeJustFactsShow(doc:PresentationPackage,target:PresentationPackage):PresentationPackage {
 if(doc.id!=='just-facts'||!['1.0.0','1.0.1'].includes(doc.version)||target.id!==doc.id||target.version!=='2.0.0')return doc;
 const next=structuredClone(target);
 const oldDefaults=new Set(['Host / Moderator','Guest one','Guest two']);
 for(const key of ['hostName','guest1Name','guest2Name']){
  const value=doc.set.values[key],replacement=next.set.values[key];
  if(value?.type==='text'&&replacement?.type==='text'&&!oldDefaults.has(value.default)){replacement.maxLength=Math.max(replacement.maxLength,value.maxLength);replacement.default=value.default;}
 }
 for(const instance of doc.runtime.instances){
  if(instance.owner!=='set'||next.runtime.instances.some(i=>i.id===instance.id)||next.runtime.instances.length>=32)continue;
  const definition=doc.runtime.definitions[instance.definition];
  if(!definition||next.runtime.definitions[instance.definition])continue;
  next.runtime.definitions[instance.definition]=structuredClone(definition);
  next.runtime.instances.push(structuredClone(instance));
 }
 return next;
}
