/** Portable module contract. No renderer, transport, credentials or ambient IO. */
export type ModuleBindings=Record<string,{id:string;revision:number}>;
export type Scalar = string | number | boolean;
export type Role = 'operator' | 'audience' | 'connector' | 'show';
export type Field = {type:'text';default:string;maxLength:number}|{type:'number';default:number;min:number;max:number}|{type:'boolean';default:boolean};
export type Expression = Scalar | {read:string} | {op:'eq'|'not'|'and'|'add'|'concat'|'if';args:Expression[]};
export type Control = {id:string;type:'button'|'toggle'|'text'|'number'|'choice'|'readout';label:string;action?:string;field?:string;options?:{id:string;label:string}[];when?:Expression;enabled?:Expression;segment?:string};
export type Step = {op:'set'|'add';field:string;value:Expression}|{op:'view';view:string};
export interface Action {roles:Role[];steps:Step[];when?:Expression}
export interface ModuleDefinition {
 label:string;
 state:Record<string,Field>;
 publicFields?:string[];
 initialView?:string;
 views?:string[];
 actions:Record<string,Action>;
 controls:{id:string;label:string;audience:Role;controls:Control[]}[];
 capabilities:string[];
 behavior?:
  |{type:'vote';question:string;options:{id:string;label:string}[];maxParticipants:number;allowChange:boolean;showView?:string}
  |{type:'submissions';prompt:string;maxLength:number;capacity:number;showView?:string;sources?:Array<'submissions'|'chat'>}
  |{type:'agent';integrationRole:string;prompt:string;mode:'answer'|'factCheck';maxLength:number;showView?:string;initialQuestion?:string;researchView?:string}
  |{type:'weather';integrationRole:string};
}
export interface ModuleInstanceDefinition {id:string;definition:string;owner:'set'|'segment';audiencePolicy?:'manual'|'whileRunning';audienceSegments?:string[];segment?:string;initialState?:Record<string,Scalar>;hidden:'continue'|'pause';onExit:'continue'|'pause'|'stop'|'dispose';reenter:'resume'|'reset'|'new'}
export interface RuntimeDefinition {schema:'producer.modules/1';definitions:Record<string,ModuleDefinition>;instances:ModuleInstanceDefinition[]}
export class ContractError extends Error {}
export const key=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v);
const own=(o:object,k:PropertyKey)=>Object.prototype.hasOwnProperty.call(o,k);
function fail(message:string):never{throw new ContractError(message);}
function object(v:unknown,allowed:string[],required=allowed):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('Expected plain object');
 const o=v as Record<string,unknown>;
 if(Object.keys(o).some(k=>!allowed.includes(k))||required.some(k=>!own(o,k)))fail('Unknown or missing field');return o;
}
const list=(v:unknown,max:number):unknown[]=>Array.isArray(v)&&v.length<=max?v:fail('Invalid list');
const text=(v:unknown,max:number):string=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)?v:fail('Invalid text');
const num=(v:unknown,min:number,max:number):number=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max?v:fail('Invalid number');
const bool=(v:unknown):boolean=>typeof v==='boolean'?v:fail('Invalid boolean');
const id=(v:unknown):string=>key(v)?v:fail('Invalid identity');
function record<T>(v:unknown,parse:(v:unknown)=>T,max=64):Record<string,T>{
 if(!v||typeof v!=='object'||Array.isArray(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('Invalid dictionary');
 const entries=Object.entries(v);if(entries.length>max)fail('Dictionary budget exceeded');
 return Object.fromEntries(entries.map(([k,value])=>[id(k),parse(value)]));
}
function scalar(v:unknown):Scalar{if(typeof v==='boolean')return v;if(typeof v==='number')return num(v,-1e9,1e9);return text(v,1024);}
export function fieldValue(field:Field,v:unknown):Scalar{
 if(field.type==='text')return text(v,field.maxLength);if(field.type==='number')return num(v,field.min,field.max);return bool(v);
}
function field(v:unknown):Field{
 if(!v||typeof v!=='object')fail('Invalid field');const type=(v as any).type;
 if(type==='text'){const o=object(v,['type','default','maxLength']);const maxLength=num(o.maxLength,1,1024);return {type,default:text(o.default,maxLength),maxLength};}
 if(type==='number'){const o=object(v,['type','default','min','max']);const min=num(o.min,-1e9,1e9),max=num(o.max,min,1e9);return {type,default:num(o.default,min,max),min,max};}
 if(type==='boolean'){const o=object(v,['type','default']);return {type,default:bool(o.default)};}return fail('Unknown field type');
}
export function expression(v:unknown,depth=0):Expression{
 if(depth>12)fail('Expression depth exceeded');if(!v||typeof v!=='object')return scalar(v);
 if(own(v,'read')){const o=object(v,['read']);const read=text(o.read,160);if(!/^(local|input|set)\.[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(read)||!key(read.split('.')[1]))fail('Invalid state reference');return {read};}
 const o=object(v,['op','args']);if(!['eq','not','and','add','concat','if'].includes(String(o.op)))fail('Unknown expression');
 const args=list(o.args,8).map(a=>expression(a,depth+1));const op=o.op as 'eq';if(!args.length||(op as string)==='not'&&args.length!==1||['eq','add'].includes(op)&&args.length!==2||(op as string)==='if'&&args.length!==3)fail('Invalid expression arity');return {op,args};
}
function role(v:unknown):Role{if(!['operator','audience','connector','show'].includes(String(v)))fail('Unknown role');return v as Role;}
function control(v:unknown):Control{
 const o=object(v,['id','type','label','action','field','options','when','enabled','segment'],['id','type','label']);
 if(!['button','toggle','text','number','choice','readout'].includes(String(o.type)))fail('Unknown control type');
 return {id:id(o.id),type:o.type as Control['type'],label:text(o.label,80),...(o.action!==undefined?{action:id(o.action)}:{}),...(o.field!==undefined?{field:id(o.field)}:{}),...(o.options!==undefined?{options:options(o.options)}:{}),...(o.when!==undefined?{when:expression(o.when)}:{}),...(o.enabled!==undefined?{enabled:expression(o.enabled)}:{}),...(o.segment!==undefined?{segment:id(o.segment)}:{})};
}
function options(v:unknown){const items=list(v,12).map(v=>{const o=object(v,['id','label']);return {id:id(o.id),label:text(o.label,120)};});if(new Set(items.map(i=>i.id)).size!==items.length||items.some(i=>!i.label.trim()))fail('Invalid options');return items;}
function behavior(v:unknown):ModuleDefinition['behavior']{
 if(v===undefined)return;
 if(!v||typeof v!=='object')fail('Invalid behavior');const type=(v as any).type;
 if(type==='vote'){const o=object(v,['type','question','options','maxParticipants','allowChange','showView'],['type','question','options','maxParticipants','allowChange']);const choices=options(o.options);if(choices.length<2)fail('Vote requires two or more choices');const maxParticipants=num(o.maxParticipants,1,100000);if(!Number.isInteger(maxParticipants))fail('Invalid participant capacity');return {type,question:text(o.question,240),options:choices,maxParticipants,allowChange:bool(o.allowChange),...(o.showView!==undefined?{showView:id(o.showView)}:{})};}
 if(type==='submissions'){const o=object(v,['type','prompt','maxLength','capacity','showView','sources'],['type','prompt','maxLength','capacity']);const maxLength=num(o.maxLength,1,1000),capacity=num(o.capacity,1,500);if(!Number.isInteger(maxLength)||!Number.isInteger(capacity))fail('Invalid submission bounds');return {type,prompt:text(o.prompt,240),maxLength,capacity,...(o.sources===undefined?{}:{sources:list(o.sources,2).map(v=>{if(v!=='submissions'&&v!=='chat')fail('Unknown audience source');return v as 'submissions'|'chat';})}),...(o.showView!==undefined?{showView:id(o.showView)}:{})};}
 if(type==='agent'){const o=object(v,['type','integrationRole','prompt','mode','maxLength','showView','initialQuestion','researchView'],['type','integrationRole','prompt','mode','maxLength']);if(o.mode!=='answer'&&o.mode!=='factCheck')fail('Invalid agent mode');return {type,integrationRole:id(o.integrationRole),prompt:text(o.prompt,1000),mode:o.mode,maxLength:num(o.maxLength,240,16000),...(o.showView!==undefined?{showView:id(o.showView)}:{}),...(o.initialQuestion!==undefined?{initialQuestion:text(o.initialQuestion,1000)}:{}),...(o.researchView!==undefined?{researchView:id(o.researchView)}:{})};}
 if(type==='weather'){const o=object(v,['type','integrationRole']);return {type,integrationRole:id(o.integrationRole)};}
 return fail('Unsupported behavior capability');
}
export function parseRuntimeDefinition(value:unknown):RuntimeDefinition{
 if(JSON.stringify(value).length>1024*1024)fail('Module definition exceeds 1 MB');
 const root=object(value,['schema','definitions','instances']);if(root.schema!=='producer.modules/1')fail('Unsupported module schema');
 const definitions=record(root.definitions,v=>{
  const o=object(v,['label','state','publicFields','initialView','views','actions','controls','capabilities','behavior'],['label','state','actions','controls','capabilities']);
  const state=record(o.state,field);const publicFields=o.publicFields===undefined?[]:list(o.publicFields,64).map(id);if(publicFields.some(k=>!own(state,k)))fail('Unknown public state field');const views=o.views===undefined?undefined:list(o.views,32).map(id);
  const actions=record(o.actions,v=>{const a=object(v,['roles','steps','when'],['roles','steps']);const steps=list(a.steps,32).map(v=>{const s=object(v,['op','field','value','view'],['op']);if(s.op==='view'){object(v,['op','view']);const view=id(s.view);if(!views?.includes(view))fail('Unknown view');return {op:'view' as const,view};}if(s.op!=='set'&&s.op!=='add')fail('Unknown action step');object(v,['op','field','value']);const name=id(s.field);if(!own(state,name))fail('Unknown local field');if(s.op==='add'&&state[name].type!=='number')fail('Add requires numeric field');return {op:s.op as 'set'|'add',field:name,value:expression(s.value)};});return {roles:list(a.roles,4).map(role),steps,...(a.when===undefined?{}:{when:expression(a.when)})};});
  const controls=list(o.controls,16).map(v=>{const g=object(v,['id','label','audience','controls']);return {id:id(g.id),label:text(g.label,80),audience:role(g.audience),controls:list(g.controls,32).map(control)};});
  const groups=new Set<string>(),ids=new Set<string>();for(const g of controls){if(groups.has(g.id))fail('Duplicate control group');groups.add(g.id);for(const c of g.controls){if(ids.has(c.id))fail('Duplicate control');ids.add(c.id);if(c.action&&!own(actions,c.action))fail('Unknown control action');if(c.field&&!own(state,c.field))fail('Unknown control field');if(c.type==='button'&&!c.action||!['button','readout'].includes(c.type)&&!c.field)fail('Control binding missing');if(c.field&&g.audience!=='operator'&&c.type!=='readout')fail('Field editors require operator scope');if(c.action&&!actions[c.action].roles.includes(g.audience))fail('Control role lacks action authority');}}
  const validateExpression=(e:Expression,publicOnly=false,allowInput=true)=>{
   const visit=(e:Expression)=>{if(typeof e!=='object')return;if('read'in e){const [scope,k]=e.read.split('.');if(scope==='set')fail('Shared reads require a declared export capability');if(scope==='input'&&!allowInput)fail('Input reference outside action');if(scope==='local'&&(!own(state,k)||publicOnly&&!publicFields.includes(k)))fail('Unknown or private state reference');return;}e.args.forEach(visit);};visit(e);
  };
  for(const a of Object.values(actions)){if(a.when!==undefined)validateExpression(a.when);for(const step of a.steps)if(step.op!=='view')validateExpression(step.value);}
  for(const g of controls)for(const c of g.controls){const audience=g.audience==='audience';if(audience&&c.field&&!publicFields.includes(c.field))fail('Audience control reads private field');if(c.when!==undefined)validateExpression(c.when,audience,false);if(c.enabled!==undefined)validateExpression(c.enabled,audience,false);}
  const capabilities=list(o.capabilities,16).map(v=>text(v,80));if(capabilities.some(c=>!/^[a-z][a-z0-9.-]+@[1-9][0-9]*$/.test(c)))fail('Invalid capability requirement');
  const b=behavior(o.behavior);if(b?.type==='submissions'&&b.sources?.includes('chat')&&!capabilities.includes('room.chat@1'))fail('Chat input requires room.chat@1');if(b&&'showView'in b&&b.showView&&!views?.includes(b.showView))fail('Unknown presentation view');if(b?.type==='agent'&&b.researchView&&!views?.includes(b.researchView))fail('Unknown research view');if(b){const cap=b.type==='vote'?'audience.vote@1':b.type==='submissions'?'audience.text@1':b.type==='agent'?'data.agent@1':'data.weather@1';if(!capabilities.includes(cap))fail('Behavior capability must be declared');}
  const initialView=o.initialView===undefined?undefined:id(o.initialView);if(initialView&&!views?.includes(initialView))fail('Initial view is not declared');
  return {label:text(o.label,80),state,publicFields,actions,controls,capabilities,...(views?{views}:{}),...(initialView?{initialView}:{}),...(b?{behavior:b}:{})};
 },32);
 const instanceIds=new Set<string>();const instances=list(root.instances,32).map(v=>{
  const o=object(v,['id','definition','owner','segment','initialState','hidden','onExit','reenter','audiencePolicy','audienceSegments'],['id','definition','owner','hidden','onExit','reenter']);const name=id(o.id),definition=id(o.definition);if(instanceIds.has(name)||!own(definitions,definition))fail('Duplicate instance or missing definition');instanceIds.add(name);
  if(o.owner!=='set'&&o.owner!=='segment'||!['continue','pause'].includes(String(o.hidden))||!['continue','pause','stop','dispose'].includes(String(o.onExit))||!['resume','reset','new'].includes(String(o.reenter)))fail('Invalid lifecycle policy');
  if(o.audiencePolicy!==undefined&&!['manual','whileRunning'].includes(String(o.audiencePolicy)))fail('Invalid audience exposure policy');
  const audienceSegments=o.audienceSegments===undefined?undefined:list(o.audienceSegments,32).map(id);
  const segment=o.segment===undefined?undefined:id(o.segment);if((o.owner==='segment')!==!!segment)fail('Segment ownership requires a segment');
  const initialState=o.initialState===undefined?undefined:record(o.initialState,scalar);for(const [k,v]of Object.entries(initialState??{})){if(!own(definitions[definition].state,k))fail('Unknown initial state field');fieldValue(definitions[definition].state[k],v);}
  return {id:name,definition,owner:o.owner as 'set'|'segment',hidden:o.hidden as 'continue'|'pause',onExit:o.onExit as 'continue'|'pause'|'stop'|'dispose',reenter:o.reenter as 'resume'|'reset'|'new',...(o.audiencePolicy!==undefined?{audiencePolicy:o.audiencePolicy as 'manual'|'whileRunning'}:{}),...(audienceSegments?{audienceSegments}:{}),...(segment?{segment}:{}),...(initialState?{initialState}:{})};
 });
 return {schema:'producer.modules/1',definitions,instances};
}
export function evaluate(value:Expression,local:Record<string,Scalar>,input:Record<string,Scalar>,shared:Record<string,Scalar>,budget=64):Scalar{
 if(budget<1)fail('Expression budget exceeded');if(typeof value!=='object')return value;
 if('read'in value){const [scope,k]=value.read.split('.');const values=scope==='local'?local:scope==='input'?input:shared;if(!own(values,k))fail('Missing state reference '+value.read);return values[k];}
 const read=(v:Expression)=>evaluate(v,local,input,shared,budget-1);
 if(value.op==='if'){const c=read(value.args[0]);if(typeof c!=='boolean')fail('Expected boolean');return read(value.args[c?1:2]);}
 if(value.op==='eq')return read(value.args[0])===read(value.args[1]);
 if(value.op==='not'){const c=read(value.args[0]);if(typeof c!=='boolean')fail('Expected boolean');return !c;}
 if(value.op==='and')return value.args.every(a=>{const c=read(a);if(typeof c!=='boolean')fail('Expected boolean');return c;});
 if(value.op==='concat')return value.args.map(read).join('').slice(0,1024);
 const a=read(value.args[0]),b=read(value.args[1]);if(typeof a!=='number'||typeof b!=='number')fail('Expected numbers');return num(a+b,-1e9,1e9);
}
