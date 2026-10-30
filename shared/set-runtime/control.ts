import {key,type Field,type Scalar} from './contract';

export type ControlField=Field&{label?:string};

/** Bounded control catalog, not a substitute for visual package admission. */
export interface ControlDefinition {
 schema:'producer.control/1';layouts:string[];initialLayout:string;
 fields?:Record<string,ControlField>;
 show?:{initialPhase:string;phases:{id:string;layoutId:string;next?:string}[]};
}
export interface ControlState {
 layoutId:string;visible:boolean;values?:Record<string,Scalar>;
 show:{run:number;status:'stopped'|'running'|'paused';phase:string;positionMs:number;anchorMs:number};
}
export interface ControlCommand {
 id:string;setEpoch:number;expectedRevision:number;
 op:'field.set'|'layout.select'|'visibility.set'|'show.start'|'show.pause'|'show.resume'|'show.next'|'show.previous'|'show.stop';
 input?:{layoutId?:string;visible?:boolean;key?:string;value?:Scalar};
}
function object(value:unknown,allowed:string[],required=allowed):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('Control object required');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!allowed.includes(k))||required.some(k=>!Object.prototype.hasOwnProperty.call(v,k)))throw Error('Unknown or missing control field');
 return v;
}
export function parseControlDefinition(value:unknown):ControlDefinition {
 const v=object(value,['schema','layouts','initialLayout','show','fields'],['schema','layouts','initialLayout']);
 if(v.schema!=='producer.control/1'||!Array.isArray(v.layouts)||!v.layouts.length||v.layouts.length>64||v.layouts.some(id=>!key(id))||new Set(v.layouts).size!==v.layouts.length||!key(v.initialLayout)||!v.layouts.includes(v.initialLayout))throw Error('Invalid control layouts');
 const result:ControlDefinition={schema:v.schema,layouts:[...v.layouts],initialLayout:v.initialLayout};
 if(v.fields!==undefined){
  if(!v.fields||typeof v.fields!=='object'||Array.isArray(v.fields)||![Object.prototype,null].includes(Object.getPrototypeOf(v.fields)))throw Error('Invalid control fields');
  const entries=Object.entries(v.fields);if(entries.length>64)throw Error('Control fields budget exceeded');
  result.fields=Object.fromEntries(entries.map(([name,value])=>{
   if(!key(name)||!value||typeof value!=='object')throw Error('Invalid control field');
   const type=(value as Record<string,unknown>).type,allowed=type==='text'?['type','default','maxLength']:type==='number'?['type','default','min','max']:type==='boolean'?['type','default']:[];
   if(!allowed.length)throw Error('Unknown control field type');
   const f=object(value,[...allowed,'label'],allowed);
   if(f.label!==undefined&&(typeof f.label!=='string'||!f.label.trim()||f.label.length>80))throw Error('Invalid control field label');
   if(type==='text'&&(typeof f.maxLength!=='number'||!Number.isFinite(f.maxLength)||f.maxLength<1||f.maxLength>160))throw Error('Invalid control text limit');
   if(type==='number'&&(typeof f.min!=='number'||typeof f.max!=='number'||!Number.isFinite(f.min)||!Number.isFinite(f.max)||f.min< -1e6||f.max>1e6||f.min>f.max))throw Error('Invalid control number limits');
   const field=structuredClone(f) as ControlField;validateControlValue(field,f.default);return [name,field];
  }));
 }
 if(v.show!==undefined){
  const show=object(v.show,['initialPhase','phases']);
  if(!key(show.initialPhase)||!Array.isArray(show.phases)||!show.phases.length||show.phases.length>64)throw Error('Invalid Show catalog');
  const phases=show.phases.map(value=>{
   const p=object(value,['id','layoutId','next'],['id','layoutId']);
   if(!key(p.id)||!key(p.layoutId)||!result.layouts.includes(p.layoutId)||p.next!==undefined&&!key(p.next))throw Error('Invalid Show phase');
   return {id:p.id,layoutId:p.layoutId,...(p.next!==undefined?{next:p.next as string}:{})};
  });
  const byId=new Map(phases.map(p=>[p.id,p])),visited=new Set<string>();let id:string|undefined=show.initialPhase;
  if(byId.size!==phases.length)throw Error('Duplicate Show phase');
  while(id!==undefined){if(visited.has(id)||!byId.has(id))throw Error('Invalid Show path');visited.add(id);id=byId.get(id)!.next;}
  if(visited.size!==phases.length)throw Error('Unreachable Show phase');
  result.show={initialPhase:show.initialPhase,phases};
 }
 return result;
}
/** Values are validated without coercion; scope/identity/revision are checked by SetRuntime. */
export function validateControlValue(field:ControlField,value:unknown):Scalar {
 if(field.type==='text'&&typeof value==='string'&&value.length<=field.maxLength)return value;
 if(field.type==='number'&&typeof value==='number'&&Number.isFinite(value)&&value>=field.min&&value<=field.max)return value;
 if(field.type==='boolean'&&typeof value==='boolean')return value;
 throw Error('Field value does not match declared type or bounds');
}
export function initialControl(definition:ControlDefinition):ControlState {
 return {layoutId:definition.initialLayout,visible:true,...(definition.fields?{values:Object.fromEntries(Object.entries(definition.fields).map(([key,field])=>[key,field.default]))}:{}),show:{run:0,status:'stopped',phase:definition.show?.initialPhase??'',positionMs:0,anchorMs:0}};
}
export function parseControlCommand(value:unknown):ControlCommand {
 const c=object(value,['id','setEpoch','expectedRevision','op','input'],['id','setEpoch','expectedRevision','op']);
 if(typeof c.id!=='string'||!/^[-A-Za-z0-9._:]{1,160}$/.test(c.id)||!Number.isSafeInteger(c.setEpoch)||(c.setEpoch as number)<1||!Number.isSafeInteger(c.expectedRevision)||(c.expectedRevision as number)<0||!['field.set','layout.select','visibility.set','show.start','show.pause','show.resume','show.next','show.previous','show.stop'].includes(String(c.op)))throw Error('Invalid control command');
 const allowed=c.op==='field.set'?['key','value']:c.op==='layout.select'?['layoutId']:c.op==='visibility.set'?['visible']:[];
 object(c.input??{},allowed);
 if(c.op==='layout.select'&&!key((c.input as Record<string,unknown>).layoutId)||c.op==='visibility.set'&&typeof (c.input as Record<string,unknown>).visible!=='boolean')throw Error('Invalid control input');
 if(c.op==='field.set'){const input=c.input as Record<string,unknown>;if(!key(input.key)||!(typeof input.value==='string'&&input.value.length<=160||typeof input.value==='number'&&Number.isFinite(input.value)&&Math.abs(input.value)<=1e6||typeof input.value==='boolean'))throw Error('Invalid field input');}
 return structuredClone(c) as unknown as ControlCommand;
}
/** Only the trusted runtime supplies `now`; clients cannot choose the clock. */
export function reduceControl(definition:ControlDefinition,state:ControlState,value:unknown,now:number):ControlState {
 const c=parseControlCommand(value),input=c.input??{};
 if(!Number.isFinite(now)||now<0||now<state.show.anchorMs)throw Error('Invalid control clock');
 const next=structuredClone(state),show=next.show;
 if(c.op==='field.set'){
  if(!input.key||!definition.fields||!Object.prototype.hasOwnProperty.call(definition.fields,input.key))throw Error('Unknown Set field');
  const value=validateControlValue(definition.fields[input.key],input.value);
  next.values={...Object.fromEntries(Object.entries(definition.fields).map(([key,field])=>[key,field.default])),...next.values,[input.key]:value};return next;
 }
 if(c.op==='layout.select'){
  if(typeof input.layoutId!=='string'||!definition.layouts.includes(input.layoutId))throw Error('Unknown layout');
  next.layoutId=input.layoutId;return next;
 }
 if(c.op==='visibility.set'){
  if(typeof input.visible!=='boolean')throw Error('Invalid visibility');next.visible=input.visible;return next;
 }
 if(!definition.show)throw Error('Set has no Show');
 if(show.status==='running')show.positionMs+=now-show.anchorMs;
 show.anchorMs=now;
 switch(c.op){
  case 'show.start':
   if(show.status!=='stopped'||show.run>=Number.MAX_SAFE_INTEGER)throw Error('Show cannot start');
   show.run++;show.status='running';show.phase=definition.show.initialPhase;show.positionMs=0;break;
  case 'show.pause':if(show.status!=='running')throw Error('Show is not running');show.status='paused';break;
  case 'show.resume':if(show.status!=='paused')throw Error('Show is not paused');show.status='running';break;
  case 'show.stop':if(show.status==='stopped')throw Error('Show is stopped');show.status='stopped';return next;
  case 'show.next':case 'show.previous':{
   if(show.status!=='running')throw Error('Cannot advance Show');
   const current=definition.show.phases.find(p=>p.id===show.phase)!;
   const target=c.op==='show.next'?definition.show.phases.find(p=>p.id===current.next):definition.show.phases.find(p=>p.next===current.id);
   if(!target)throw Error('Show boundary reached');show.phase=target.id;break;
  }
  default:throw Error('Unknown control operation');
 }
 if(c.op==='show.start'||c.op==='show.next'||c.op==='show.previous')next.layoutId=definition.show.phases.find(p=>p.id===show.phase)!.layoutId;
 return next;
}
