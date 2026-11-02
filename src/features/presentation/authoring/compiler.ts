import {packageFeatures} from './features';
import {parsePackageText} from '../validation';
import {parsePackage, type PresentationPackage, type PresentationNode} from '../schema';
import {AUTHORING_CATALOG, requireFeatures, type AuthoringTarget} from './catalog';

type Obj = Record<string, any>;
function object(v: unknown, allowed: string[], required = allowed): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Expected an object.');
  const o = v as Obj;
  if (Object.keys(o).some(k => !allowed.includes(k)) || required.some(k => !Object.prototype.hasOwnProperty.call(o,k))) throw Error('Unknown or missing design field.');
  return o;
}
function list(v: unknown, max: number): any[] { if (!Array.isArray(v) || !v.length || v.length > max) throw Error('Design list exceeds its budget or is empty.'); return v; }
function id(v: unknown): string { if (typeof v !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(v) || ['constructor','prototype','__proto__'].includes(v)) throw Error('Invalid stable ID.'); return v; }
function text(v: unknown, max = 160): string { if (typeof v !== 'string' || v.length > max) throw Error('Invalid text.'); return v; }
function color(v: unknown): string { if (typeof v !== 'string' || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) throw Error('Use a hex color.'); return v; }
function rect(v: unknown, w: number, h: number) {
  if (!Array.isArray(v) || v.length !== 4 || v.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw Error('Bounds require [x,y,width,height].');
  const [left,top,width,height] = v;
  if (left < 0 || top < 0 || width < 1 || height < 1 || left+width > w || top+height > h) throw Error('Element must fit inside its authored canvas.');
  return {position:'absolute',left,top,width,height};
}
function designBudget(input:unknown){if(new TextEncoder().encode(JSON.stringify(input)).byteLength>AUTHORING_CATALOG.limits.designBytes)throw Error('Design input exceeds 1 MB. Split the work into revision-fenced edits.');}
export function compileDesignPlan(input: unknown, target: AuthoringTarget, assets: PresentationPackage['set']['assets'] = {}): PresentationPackage {
  designBudget(input);requireFeatures(target,['core@1']);
  if((input as Obj)?.schema==='producer.design-plan/2')return compileCanonicalPlan(input,target,assets);
  const p=object(input,['schema','id','name','background','layouts','views','initialView'],['schema','id','name','background','layouts']);
  if(p.schema!=='producer.design-plan/1')throw Error('Unsupported design plan.');
  const values: Obj={},slots=new Map<string,string>(),usedAssets:Obj={},controls:Obj[]=[];
  const layouts=list(p.layouts,AUTHORING_CATALOG.limits.layouts).map(raw=>{
    const l=object(raw,['id','name','orientation','elements']);
    if(!['landscape','portrait'].includes(l.orientation))throw Error('Unsupported orientation.');
    const width=l.orientation==='portrait'?1080:1920,height=l.orientation==='portrait'?1920:1080;
    const children=list(l.elements,AUTHORING_CATALOG.limits.elementsPerLayout).map(raw=>{
      const e=object(raw,['id','kind','bounds','text','field','color','size','font','align','fill','radius','slot','asset','effect','colors','sensitivity','speed'],['id','kind','bounds']);
      const fields:Record<string,string[]>={panel:['fill','radius'],text:['text','field','color','size','font','align'],camera:['slot','radius'],image:['asset'],effect:['effect','colors','sensitivity','speed','radius']};
      if(!fields[e.kind]||Object.keys(e).some(k=>!['id','kind','bounds',...fields[e.kind]].includes(k)))throw Error('Unsupported field for this element kind.');
      const node:Obj={id:id(e.id),styles:rect(e.bounds,width,height)};
      if(e.kind==='panel')return {...node,type:'box',styles:{...node.styles,background:color(e.fill),borderRadius:e.radius??0},children:[]};
      if(e.kind==='text'){
        const label=text(e.text,4096);let binding:any=label;
        if(e.field!==undefined){const key=id(e.field);if(values[key]&&values[key].default!==label)throw Error('Shared text field has conflicting defaults.');if(!values[key])controls.push({id:key,type:'text',label:key,key});values[key]={type:'text',default:label,maxLength:4096};binding={get:`values.${key}`};}
        return {...node,type:'text',text:binding,styles:{...node.styles,fontSize:e.size??48,fontFamily:e.font??'Arial',color:color(e.color??'#ffffff'),textAlign:e.align??'left',overflow:'hidden'}};
      }
      if(e.kind==='camera'){const role=id(e.slot);slots.set(role,role);return {...node,type:'slot',slotId:role,framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:e.radius??0}};}
      if(e.kind==='image'){const asset=id(e.asset);if(!assets?.[asset])throw Error(`Missing authorized asset: ${asset}`);usedAssets[asset]=assets[asset];return {...node,type:'media',assetId:asset,fit:'contain'};}
      if(e.kind==='effect'){
        if(!['voiceBars','voiceRing','voiceSea','launchV1'].includes(e.effect))throw Error('Unknown effect recipe.');
        if(e.effect==='voiceRing'&&(typeof e.radius!=='number'||!Number.isFinite(e.radius)||e.radius<=0))throw Error('voiceRing requires a positive radius matching the host camera radius; leave room around it for waves.');
        requireFeatures(target,[`shader.${e.effect}@1`]);
        return {...node,type:'shader',shader:{effect:e.effect,colors:e.colors??['#00d9ff','#ed17df','#ffae24'],intensity:e.sensitivity??1,speed:e.speed??.55,scale:1,opacity:1,radius:e.radius??0,quality:'medium',clock:'show'}};
      }
      throw Error(`Unsupported design element: ${String(e.kind)}`);
    });
    return {id:id(l.id),label:text(l.name,80),width,height,animation:{tracks:[],transition:{type:'morph',durationMs:450,contentDurationMs:0}},root:{id:'root',type:'box',styles:{position:'relative',width,height,background:color(p.background),overflow:'hidden'},children}};
  });

  return parsePackage({schema:'producer.presentation/2',id:id(p.id),name:text(p.name,80),version:'1.0.0',set:{...(p.views?{views:p.views}:{}),...(p.initialView?{initialView:p.initialView}:{}),initialLayout:layouts[0].id,values,feeds:{},assets:usedAssets,slots:[...slots].map(([id,label])=>({id,label})),components:{},layouts,controls,controlArrangement:{sections:[{id:'content',label:'Content and layouts',controls:['builtin:layout',...controls.map(c=>`set:${c.id}`)]}],minimized:['builtin:layout']}}});
}

/** Model context contains structure and asset identities, never embedded media bytes. */
export function designContext(doc: PresentationPackage) {
  const copy=structuredClone(doc);
  return {...copy,set:{...copy.set,assets:Object.fromEntries(Object.entries(copy.set.assets??{}).map(([id,a])=>[id,{name:a.name,mime:a.mime}]))}};
}
export async function packageRevision(doc: PresentationPackage): Promise<string> {
  const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(doc))));
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
/** Atomic, revision-fenced local edits. The input and its assets are never mutated. */
export async function applyDesignEdits(base: PresentationPackage, input: unknown, target: AuthoringTarget): Promise<PresentationPackage> {
  designBudget(input);requireFeatures(target,['core@1']);
  if((input as Obj)?.schema==='producer.set-edit/2')return applyCanonicalEdits(base,input,target);
  const request=object(input,['schema','baseRevision','operations']);
  if(request.schema!=='producer.set-edit/1'||request.baseRevision!==await packageRevision(base))throw Error('The Set changed after this edit was requested. Generate an edit against the current revision.');
  requireFeatures(target,packageFeatures(base));
  const next=structuredClone(base);
  for(const raw of list(request.operations,AUTHORING_CATALOG.limits.edits)){
    const op=object(raw,['op','layout','node','bounds','text','slot','id','name'],['op','layout']);
    const fields:Record<string,string[]>={move:['node','bounds'],text:['node','text'],'replace-camera':['node','slot'],'duplicate-layout':['id','name']};
    if(!fields[op.op]||Object.keys(op).some(k=>!['op','layout',...fields[op.op]].includes(k)))throw Error('Unsupported edit fields.');
    const layout=next.set.layouts.find(l=>l.id===op.layout);if(!layout)throw Error('Unknown edit layout.');
    if(op.op==='duplicate-layout'){
      const copy=structuredClone(layout);copy.id=id(op.id);copy.label=text(op.name,80);if(next.set.layouts.some(l=>l.id===copy.id))throw Error('Layout ID already exists.');next.set.layouts.push(copy);continue;
    }
    const matches:PresentationNode[]=[];const walk=(n:PresentationNode)=>{if(n.id===op.node)matches.push(n);n.children?.forEach(walk);};walk(layout.root);
    if(matches.length!==1)throw Error('Edit requires one existing node.');const node=matches[0];
    // Editing nested geometry requires a parent-relative contract; this first version rejects it.
    if(!layout.root.children?.includes(node))throw Error('This edit profile targets direct layout elements.');
    if(op.op==='move')node.styles={...node.styles,...rect(op.bounds,layout.width,layout.height)};
    else if(op.op==='text'){if(node.type!=='text')throw Error('Text edit requires a text element.');if(typeof node.text==='object')throw Error('Edit the declared field rather than replacing its binding.');node.text=text(op.text,512);}
    else if(op.op==='replace-camera'){
      const slot=id(op.slot);if(!next.set.slots.some(s=>s.id===slot))next.set.slots.push({id:slot,label:slot});
      const s=node.styles??{};const styles=rect([s.left,s.top,s.width,s.height],layout.width,layout.height);
      Object.keys(node).forEach(k=>delete (node as any)[k]);Object.assign(node,{id:id(op.node),type:'slot',slotId:slot,styles,framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'rectangle',cornerRadius:0}});
    }else throw Error('Unsupported edit operation.');
  }
  return parsePackage(next);
}


/** Bounded canonical authoring: every declarative schema field, no second schema
 * for geometry/materials/modules to drift from the actual renderer contract. */
export function compileCanonicalPlan(input:unknown,target:AuthoringTarget,assets:PresentationPackage['set']['assets']={}):PresentationPackage {
 const plan=object(input,['schema','package','assetRefs'],['schema','package']);
 if(plan.schema!=='producer.design-plan/2')throw Error('Unsupported canonical design plan.');
 const raw=structuredClone(plan.package);
 if(!raw||typeof raw!=='object'||!raw.set||typeof raw.set!=='object')throw Error('Canonical plan requires a complete Set package.');
 if(raw.set.assets!==undefined)throw Error('Use assetRefs for authorized local assets; never supply asset bytes in a design.');
 const refs=plan.assetRefs??[];
 if(!Array.isArray(refs)||refs.length>24||new Set(refs).size!==refs.length)throw Error('Expected up to 24 distinct assetRefs.');
 raw.set.assets=Object.fromEntries(refs.map((key:unknown)=>{const asset=id(key);if(!assets?.[asset])throw Error(`Missing authorized asset: ${asset}`);return [asset,structuredClone(assets[asset])];}));
 const doc=parsePackageText(JSON.stringify(raw));requireFeatures(target,packageFeatures(doc));return doc;
}
/** RFC 6901 paths / RFC 6902 add, replace and remove, applied to a private copy.
 * The final canonical validator owns reference/type checks. No intermediate
 * partially-edited package can escape, and embedded assets cannot be patched. */
export async function applyCanonicalEdits(base:PresentationPackage,input:unknown,target:AuthoringTarget):Promise<PresentationPackage>{
 const edit=object(input,['schema','baseRevision','operations']);
 if(edit.schema!=='producer.set-edit/2'||edit.baseRevision!==await packageRevision(base))throw Error('The Set changed after this edit was requested. Inspect its current revision.');
 const next:any=structuredClone(base);
 for(const raw of list(edit.operations,AUTHORING_CATALOG.limits.edits)){
  const op=object(raw,['op','path','value'],['op','path']);
  if(!['add','replace','remove'].includes(op.op)||typeof op.path!=='string'||!op.path.startsWith('/')||op.path.length>1024||/\~(?![01])/.test(op.path))throw Error('Invalid canonical edit operation or JSON pointer.');
  if((op.op==='remove')===Object.prototype.hasOwnProperty.call(op,'value'))throw Error('Add/replace require value; remove must omit value.');
  const parts=op.path.slice(1).split('/').map((p:string)=>p.replace(/~1/g,'/').replace(/~0/g,'~'));
  if(parts.some((p:string)=>['__proto__','prototype','constructor'].includes(p))||parts[0]==='set'&&(parts.length===1||parts[1]==='assets'))throw Error('Asset/prototype replacement is not permitted.');
  let parent=next;
  for(const key of parts.slice(0,-1)){if(!parent||typeof parent!=='object'||!Object.prototype.hasOwnProperty.call(parent,key))throw Error('Edit parent does not exist.');parent=parent[key];}
  if(!parent||typeof parent!=='object')throw Error('Edit parent must be an object or array.');
  const key=parts[parts.length-1];
  if(Array.isArray(parent)){
   const index=key==='-'&&op.op==='add'?parent.length:/^(0|[1-9][0-9]*)$/.test(key)?Number(key):NaN;
   if(!Number.isSafeInteger(index)||index<0||index>parent.length||(op.op!=='add'&&index===parent.length))throw Error('Invalid array edit index.');
   if(op.op==='add')parent.splice(index,0,structuredClone(op.value));else if(op.op==='remove')parent.splice(index,1);else parent[index]=structuredClone(op.value);
  }else{
   if(op.op!=='add'&&!Object.prototype.hasOwnProperty.call(parent,key))throw Error('Edit target does not exist.');
   if(op.op==='remove')delete parent[key];else parent[key]=structuredClone(op.value);
  }
 }
 const doc=parsePackageText(JSON.stringify(next));requireFeatures(target,packageFeatures(doc));return doc;
}
