import {SetRuntime,type Command,type Principal,type RuntimeCheckpoint} from '../../shared/set-runtime/runtime';
import {parseRuntimeDefinition} from '../../shared/set-runtime/contract';
const capabilities=['audience.vote@1','audience.text@1','data.weather@1','data.agent@1','room.chat@1'];
interface Stored {effects?:Record<string,true>;deployment:string;bindings:Record<string,{id:string;revision:number}>;checkpoint:RuntimeCheckpoint}
interface Storage {get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>;delete?(key:string):Promise<boolean>}
/** Serialized authority inside the room DO. Storage commits precede acknowledgements. */
export class SetRuntimeService {
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private storage:Storage){}
 fetch(request:Request):Promise<Response>{const operation=this.tail.then(()=>this.execute(request));this.tail=operation.catch(()=>{});return operation;}
 private async execute(request:Request){
  try{
   const url=new URL(request.url),stored=await this.load();
   if(request.method==='GET'){
    if(!stored)return Response.json({deployment:null,snapshot:null});
    if(url.pathname.endsWith('/configuration'))return Response.json({definition:stored.checkpoint.definition,bindings:stored.bindings});
    const runtime=SetRuntime.restore(stored.checkpoint,capabilities);
    return Response.json({deployment:stored.deployment,snapshot:url.pathname.endsWith('/public')?runtime.public():runtime.operator()});
   }
   const raw=await request.text();if(raw.length>1100000)return this.error('Request budget exceeded',413);
   const body=JSON.parse(raw) as Record<string,unknown>;
   if(!body||typeof body!=='object'||Array.isArray(body))return this.error('Object required',400);
   if(url.pathname.endsWith('/install')){
    if(typeof body.deployment!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(body.deployment))return this.error('Invalid deployment identity',400);
    const definition=parseRuntimeDefinition(body.definition);
    const bindings=(body.bindings??{}) as Record<string,{id:string;revision:number}>;
    if(!bindings||typeof bindings!=='object'||Array.isArray(bindings)||Object.keys(bindings).length>64||Object.entries(bindings).some(([role,b])=>!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(role)||!b||typeof b.id!=='string'||!Number.isSafeInteger(b.revision)||b.revision<1))return this.error('Invalid connection bindings',400);
    if(stored?.deployment===body.deployment){if((JSON.stringify(stored.checkpoint.definition)!==JSON.stringify(definition)||JSON.stringify(stored.bindings)!==JSON.stringify(bindings)))return this.error('Deployment identity reused',409);return Response.json({deployment:stored.deployment,snapshot:SetRuntime.restore(stored.checkpoint,capabilities).operator()});}
    if((stored?.checkpoint.state.setEpoch??0)!==body.expectedEpoch)return this.error('Set was replaced; reload before applying',409);
    const runtime=new SetRuntime(definition,{epoch:(stored?.checkpoint.state.setEpoch??0)+1,domain:'live',capabilities});
    const next={deployment:body.deployment,bindings,checkpoint:runtime.checkpoint()};await this.save(next);
    return Response.json({deployment:next.deployment,snapshot:runtime.operator()});
   }
   if(!stored)return this.error('Apply a set before operating its modules',409);
   const runtime=SetRuntime.restore(stored.checkpoint,capabilities),command=body.command as Command;
   if(url.pathname.endsWith('/chat')){
    const message=body.message as Record<string,unknown>;if(!message||typeof message.id!=='string'||typeof message.text!=='string'||typeof message.name!=='string'||typeof message.at!=='number')return this.error('Invalid room chat event',400);
    let queued=0;for(const instance of runtime.definition.instances){const b=runtime.definition.definitions[instance.definition].behavior,m=runtime.snapshot().modules[instance.id];if(b?.type!=='submissions'||!b.sources?.includes('chat'))continue;const result=runtime.dispatch({id:'chat:'+message.id,setEpoch:runtime.snapshot().setEpoch,module:instance.id,epoch:m.epoch,op:'chat.ingest',input:{messageId:message.id,text:message.text,name:message.name,at:message.at}},{role:'connector',id:'room-chat',modules:[instance.id]},Date.now());if(result.status==='committed')queued++;}
    if(queued)await this.save({...stored,checkpoint:runtime.checkpoint()});return Response.json({queued});
   }
   if(url.pathname.endsWith('/orchestrate')){
    const result=runtime.orchestrate(body.lifecycle as Parameters<SetRuntime['orchestrate']>[0],{role:'show',id:'show-runner',modules:runtime.definition.instances.map(i=>i.id)},Date.now());
    if(result.status==='committed')await this.save({...stored,checkpoint:runtime.checkpoint()});return Response.json({result,snapshot:runtime.operator()});
   }
   if(url.pathname.endsWith('/claim')){
    const module=runtime.snapshot().modules[command.module];
    if(!module||command.setEpoch!==runtime.snapshot().setEpoch||command.epoch!==module.epoch)return this.error('Effect request expired',409);
    const behavior=runtime.definition.definitions[module.definition].behavior;
    if(behavior?.type==='agent'&&(module.agent.status!=='pending'||module.agent.requestId!==command.id))return Response.json({claimed:false});
    if(behavior?.type==='weather'&&module.execution!=='running')return this.error('Weather module is not running',409);
    if(!behavior||!['agent','weather'].includes(behavior.type))return this.error('Module has no provider effects',400);
    const key=[command.setEpoch,command.module,command.epoch,command.id].join(':');if(stored.effects?.[key])return Response.json({claimed:false});
    const effects={...stored.effects,[key]:true as const};const keys=Object.keys(effects);if(keys.length>128)delete effects[keys[0]];
    await this.save({...stored,effects});return Response.json({claimed:true});
   }

   // Principal is supplied by the authenticated Worker route, never from a public payload.
   const principal=body.principal as Principal;
   const result=runtime.dispatch(command,principal,Date.now());
   if(result.status==='committed')await this.save({...stored,checkpoint:runtime.checkpoint()});
   return Response.json({result,...(principal?.role!=='audience'?{snapshot:runtime.operator()}:{} )});
  }catch{return this.error('Runtime operation could not complete',400);}
 }
 private async load():Promise<Stored|undefined>{
  const manifest=await this.storage.get<{chunks?:string[]}&Stored>('set-runtime/1');if(!manifest)return;
  // Internal storage upgrade; package validation still accepts only presentation/2.
  if(!manifest.chunks)return manifest;
  const pieces=await Promise.all(manifest.chunks.map(k=>this.storage.get<string>(k)));if(pieces.some(s=>s===undefined))throw Error('Incomplete runtime storage');return JSON.parse(pieces.join('')) as Stored;
 }
 private async save(value:Stored){
  const raw=JSON.stringify(value);if(raw.length>8000000)throw Error('Set runtime storage budget exceeded');
  const previous=await this.storage.get<{chunks?:string[]}>('set-runtime/1'),prefix='set-runtime/chunks/'+crypto.randomUUID()+'/',chunks:string[]=[];
  try{for(let i=0;i<raw.length;i+=16000){const key=prefix+chunks.length;chunks.push(key);await this.storage.put(key,raw.slice(i,i+16000));}await this.storage.put('set-runtime/1',{chunks});}
  catch(error){for(const k of chunks)try{await this.storage.delete?.(k);}catch{}throw error;}
  for(const k of previous?.chunks??[])try{await this.storage.delete?.(k);}catch{/* A cleanup failure cannot undo an acknowledged durable commit. */}
 }
 private error(message:string,status:number){return Response.json({error:{code:'set_runtime_error',message}}, {status});}
}
