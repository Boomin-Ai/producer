import type {PresentationPackage} from './schema';

export type ArrangementControl = {id:string;label:string;type:string;sectionId:string;kind:'set'|'module'|'builtin';moduleId?:string;controlId:string;signature:string};
export type ArrangementSection = {id:string;label:string;controls:string[];collapsed:boolean};
export type ArrangementCatalog = {controls:ArrangementControl[];sections:ArrangementSection[];minimized:string[]};
export type ArrangementPreferences = {version:1;signatures:Record<string,string>;minimized:Record<string,boolean>;minimizedOrder:string[];sectionOrder:string[];controlOrder:Record<string,string[]>;collapsed:Record<string,boolean>};
export type ResolvedArrangement = {sections:ArrangementSection[];minimized:string[]};

/** Stable IDs describe controls, never their permission or current visibility. */
export function arrangementCatalog(doc:PresentationPackage):ArrangementCatalog {
  const controls:ArrangementControl[]=[],defaults:ArrangementSection[]=[];
  const section=(id:string,label:string)=>{const s={id,label,controls:[] as string[],collapsed:false};defaults.push(s);return s;};
  const add=(s:ArrangementSection,c:Omit<ArrangementControl,'sectionId'>)=>{s.controls.push(c.id);controls.push({...c,sectionId:s.id});};
  const navigation=section('builtin:navigation','Navigation');
  add(navigation,{id:'builtin:layout',label:'Layout',type:'layout',kind:'builtin',controlId:'layout',signature:'builtin:layout/1'});
  const fields=section('set:controls','Set controls');
  for(const c of doc.set.controls)add(fields,{id:`set:${c.id}`,label:c.label,type:c.type,kind:'set',controlId:c.id,signature:JSON.stringify(c.type==='button'?{type:c.type,action:c.action}:{type:c.type,key:c.key})});
  for(const instance of doc.runtime.instances){
    const definition=doc.runtime.definitions[instance.definition];
    for(const group of definition.controls.filter(g=>g.audience==='operator')){
      const s=section(`module:${instance.id}:${group.id}`,`${definition.label} · ${group.label}`);
      for(const c of group.controls)add(s,{id:`module:${instance.id}:${c.id}`,label:c.label,type:c.type,kind:'module',moduleId:instance.id,controlId:c.id,signature:JSON.stringify({type:c.type,field:c.field,action:c.action,definition:instance.definition})});
    }
    const s=section(`module:${instance.id}:$tools`,`${definition.label} · Tools`);
    add(s,{id:`module:${instance.id}:$lifecycle`,label:`${definition.label} playback`,type:'lifecycle',kind:'module',moduleId:instance.id,controlId:'$lifecycle',signature:`lifecycle/1:${instance.definition}`});
    if(definition.behavior?.type==='weather')add(s,{id:`module:${instance.id}:$weather-location`,label:'City and weather refresh',type:'weather-location',kind:'module',moduleId:instance.id,controlId:'$weather-location',signature:`weather-location/1:${instance.definition}`});
    if(definition.behavior&&['agent','vote','submissions'].includes(definition.behavior.type))add(s,{id:`module:${instance.id}:$behavior-tools`,label:`${definition.label} tools`,type:'behavior-tools',kind:'module',moduleId:instance.id,controlId:'$behavior-tools',signature:`behavior-tools/1:${instance.definition}:${definition.behavior.type}`});
  }
  const authored=doc.set.controlArrangement;
  const placed=new Set(authored?.sections.flatMap(s=>s.controls)??[]);
  const sections:ArrangementSection[]=(authored?.sections??[]).map(s=>({id:`authored:${s.id}`,label:s.label,controls:[...s.controls],collapsed:s.collapsed??false}));
  for(const s of defaults){const rest=s.controls.filter(id=>!placed.has(id));if(rest.length)sections.push({...s,controls:rest});}
  for(const s of sections)for(const id of s.controls){const c=controls.find(c=>c.id===id);if(c)c.sectionId=s.id;}
  return {controls,sections,minimized:[...(authored?.minimized??[])]};
}

export function createArrangementPreferences(catalog:ArrangementCatalog):ArrangementPreferences {
  return {version:1,signatures:Object.fromEntries(catalog.controls.map(c=>[c.id,c.signature])),minimized:{},minimizedOrder:[],sectionOrder:[],controlOrder:{},collapsed:{}};
}
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))?value as Record<string,unknown>:{};
const ordered=(value:unknown,allowed:Set<string>):string[]=>Array.isArray(value)?[...new Set(value.slice(0,20_000).filter((id):id is string=>typeof id==='string'&&allowed.has(id)))]:[];

/** Saved values are untrusted. Removed or incompatible controls lose their overrides. */
export function reconcileArrangementPreferences(catalog:ArrangementCatalog,value:unknown):ArrangementPreferences {
  const next=createArrangementPreferences(catalog),saved=record(value);
  if(saved.version!==1)return next;
  const signatures=record(saved.signatures),compatible=new Set(catalog.controls.filter(c=>signatures[c.id]===c.signature).map(c=>c.id));
  const minimized=record(saved.minimized);
  for(const id of compatible)if(typeof minimized[id]==='boolean')next.minimized[id]=minimized[id] as boolean;
  next.minimizedOrder=ordered(saved.minimizedOrder,compatible);
  next.sectionOrder=ordered(saved.sectionOrder,new Set(catalog.sections.map(s=>s.id)));
  const collapsed=record(saved.collapsed),controlOrder=record(saved.controlOrder);
  for(const section of catalog.sections){
    if(typeof collapsed[section.id]==='boolean')next.collapsed[section.id]=collapsed[section.id] as boolean;
    const allowed=new Set(section.controls.filter(id=>compatible.has(id)));
    const order=ordered(controlOrder[section.id],allowed);if(order.length)next.controlOrder[section.id]=order;
  }
  return next;
}
function reorder<T>(values:T[],order:string[],id:(v:T)=>string):T[]{const positions=new Map(order.map((id,index)=>[id,index]));return [...values].sort((a,b)=>(positions.get(id(a))??Infinity)-(positions.get(id(b))??Infinity));}
export function resolveArrangement(catalog:ArrangementCatalog,value?:unknown):ResolvedArrangement {
  const prefs=reconcileArrangementPreferences(catalog,value),defaults=new Set(catalog.minimized);
  return {
    sections:reorder(catalog.sections,prefs.sectionOrder,s=>s.id).map(s=>({...s,controls:reorder(s.controls,prefs.controlOrder[s.id]??[],id=>id),collapsed:prefs.collapsed[s.id]??s.collapsed})),
    minimized:reorder(reorder(catalog.controls.filter(c=>prefs.minimized[c.id]??defaults.has(c.id)).map(c=>c.id),catalog.minimized,id=>id),prefs.minimizedOrder,id=>id),
  };
}
