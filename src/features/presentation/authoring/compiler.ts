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
export function compileDesignPlan(input: unknown, target: AuthoringTarget, assets: PresentationPackage['set']['assets'] = {}): PresentationPackage {
  requireFeatures(target,['core@1']);
  const p=object(input,['schema','id','name','background','layouts']);
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
        requireFeatures(target,[`shader.${e.effect}@1`]);
        return {...node,type:'shader',shader:{effect:e.effect,colors:e.colors??['#00d9ff','#ed17df','#ffae24'],intensity:e.sensitivity??1,speed:e.speed??.55,scale:1,opacity:1,radius:e.radius??0,quality:'medium',clock:'show'}};
      }
      throw Error(`Unsupported design element: ${String(e.kind)}`);
    });
    return {id:id(l.id),label:text(l.name,80),width,height,animation:{tracks:[],transition:{type:'morph',durationMs:450,contentDurationMs:0}},root:{id:'root',type:'box',styles:{position:'relative',width,height,background:color(p.background),overflow:'hidden'},children}};
  });
  for(const l of layouts)controls.push({id:`view-${l.id}`,type:'button',label:l.label,action:{type:'layout.select',layoutId:l.id}});
  return parsePackage({schema:'producer.presentation/2',id:id(p.id),name:text(p.name,80),version:'1.0.0',set:{initialLayout:layouts[0].id,values,feeds:{},assets:usedAssets,slots:[...slots].map(([id,label])=>({id,label})),components:{},layouts,controls,controlArrangement:{sections:[{id:'content',label:'Content and layouts',controls:controls.map(c=>`set:${c.id}`)}],minimized:controls.filter(c=>c.type==='button').map(c=>`set:${c.id}`)}}});
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
  requireFeatures(target,['core@1']);
  const request=object(input,['schema','baseRevision','operations']);
  if(request.schema!=='producer.set-edit/1'||request.baseRevision!==await packageRevision(base))throw Error('The Set changed after this edit was requested. Generate an edit against the current revision.');
  const required=new Set<string>(['core@1',...(base.requires??[])]);
  const inspect=(n:PresentationNode)=>{if(n.shader)required.add(`shader.${n.shader.effect}@1`);if(n.scene3d)required.add('scene3d@1');n.children?.forEach(inspect);};
  base.set.layouts.forEach(l=>inspect(l.root));Object.values(base.set.components).forEach(c=>inspect(c.root));
  requireFeatures(target,[...required]);
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
