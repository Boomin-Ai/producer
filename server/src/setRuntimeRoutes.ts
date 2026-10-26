import {weatherPayload} from '../../shared/set-runtime/weather';
import {savedConnection,querySavedConnection} from './dataIntegrations/routes';
import type {RuntimeDefinition} from '../../shared/set-runtime/contract';
import type {Snapshot,Result} from '../../shared/set-runtime/runtime';
import type {AgentResult,WeatherResult} from './dataIntegrations/providers';
import {Hono} from 'hono';
import {requirePrimary,type TokenClass} from './auth';
import type {Env} from './env';
import {loadRoom,hostPresent} from './guests';
import {audienceClaims,roomStateCall} from './interactionRoutes';
import {sha256Hex} from './crypto';
import {ApiError} from './errors';
import type {Command} from '../../shared/set-runtime/runtime';
export const setRuntimeHostRoutes=new Hono<{Bindings:Env;Variables:{tokenClass:TokenClass}}>();
export const setRuntimeAudienceRoutes=new Hono<{Bindings:Env;Variables:{tokenClass:TokenClass}}>();
setRuntimeHostRoutes.use('*',async(c,next)=>{requirePrimary(c.get('tokenClass'));await next();});
async function body(request:{text():Promise<string>}){const raw=await request.text();if(raw.length>1100000)throw new ApiError(413,'request_budget','Set runtime request exceeds its budget');let value:unknown;try{value=JSON.parse(raw);}catch{throw new ApiError(400,'invalid_request','Valid JSON required');}if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'invalid_request','Object required');return value as Record<string,unknown>;}
setRuntimeHostRoutes.get('/rooms/:id/set-runtime',async c=>{const room=await loadRoom(c.env,c.req.param('id'));return c.json(await roomStateCall(c.env,room.id,'/set-runtime/operator'));});
setRuntimeHostRoutes.post('/rooms/:id/set-runtime',async c=>{const room=await loadRoom(c.env,c.req.param('id')),input=await body(c.req);if(Object.keys(input).some(k=>!['deployment','definition','expectedEpoch','bindings'].includes(k)))throw new ApiError(400,'invalid_request','Unknown install field');return c.json(await roomStateCall(c.env,room.id,'/set-runtime/install',{method:'POST',body:JSON.stringify(input)}));});
setRuntimeHostRoutes.post('/rooms/:id/set-runtime/commands',async c=>{
 const room=await loadRoom(c.env,c.req.param('id')),input=await body(c.req),command=input.command as Command;
 if(Object.keys(input).some(k=>k!=='command')||!command||typeof command.module!=='string')throw new ApiError(400,'invalid_request','Command required');
 return c.json(await roomStateCall(c.env,room.id,'/set-runtime/command',{method:'POST',body:JSON.stringify({command,principal:{role:'operator',id:'room-operator',modules:[command.module]}})}));
});
setRuntimeAudienceRoutes.get('/audience/set-runtime/state',async c=>{const claims=await audienceClaims(c,c.env);const room=await loadRoom(c.env,claims.room!);if(!hostPresent(room.host_seen_at))return c.json({snapshot:null,deployment:null});return c.json(await roomStateCall(c.env,claims.room!,'/set-runtime/public'));});
setRuntimeAudienceRoutes.post('/audience/set-runtime/commands',async c=>{
 const claims=await audienceClaims(c,c.env),input=await body(c.req),command=input.command as Command;
 const room=await loadRoom(c.env,claims.room!);if(!hostPresent(room.host_seen_at))throw new ApiError(409,'room_closed','This room is no longer open');
 if(Object.keys(input).some(k=>k!=='command')||!command||typeof command.module!=='string')throw new ApiError(400,'invalid_request','Command required');
 const identity=(await sha256Hex(`${claims.sub}:${claims.room}:modules:${c.env.SIGNALING_SECRET}`)).slice(0,32);
 return c.json(await roomStateCall(c.env,claims.room!,'/set-runtime/command',{method:'POST',body:JSON.stringify({command,principal:{role:'audience',id:identity,modules:[command.module]}})}));
});

setRuntimeHostRoutes.post('/rooms/:id/set-runtime/modules/:module/query',async c=>{
 const room=await loadRoom(c.env,c.req.param('id')),input=await body(c.req),module=c.req.param('module');
 if(Object.keys(input).some(k=>!['command','connectionRevision'].includes(k)))throw new ApiError(400,'invalid_request','Unknown query field');
 const config=await roomStateCall<{definition:RuntimeDefinition;bindings:Record<string,{id:string;revision:number}>}>(c.env,room.id,'/set-runtime/configuration');
 const instance=config.definition?.instances.find(i=>i.id===module),definition=instance?config.definition.definitions[instance.definition]:undefined,b=definition?.behavior;
 if(!b||!['agent','weather'].includes(b.type)||!('integrationRole'in b))throw new ApiError(400,'invalid_module','This module has no data connection');
 const binding=config.bindings[b.integrationRole];if(!binding)throw new ApiError(409,'connection_unbound','Choose a saved connection in the set editor');
 const connection=await savedConnection(c.env,binding.id);if(connection.revision!==binding.revision)throw new ApiError(409,'connection_changed','The saved connection changed. Reapply its binding.');
 if(connection.connection.kind!==b.type)throw new ApiError(400,'connection_kind','The connection does not match the module capability');
 const command=input.command as Command;if(!command||command.module!==module||command.op!==(b.type==='agent'?'agent.ask':'weather.refresh'))throw new ApiError(400,'invalid_request','Invalid data request');
 let current:Snapshot;
 if(b.type==='agent'){
  const started=await roomStateCall<{result:Result;snapshot:Snapshot}>(c.env,room.id,'/set-runtime/command',{method:'POST',body:JSON.stringify({command,principal:{role:'operator',id:'room-operator',modules:[module]}})});
  if(started.result.status==='rejected')return c.json(started);current=started.snapshot;
 }else{current=(await roomStateCall<{snapshot:Snapshot}>(c.env,room.id,'/set-runtime/operator')).snapshot;if(current.setEpoch!==command.setEpoch||current.modules[module]?.epoch!==command.epoch||current.modules[module]?.execution!=='running')throw new ApiError(409,'module_expired','Start the weather module before requesting data');}
 const claim=await roomStateCall<{claimed:boolean}>(c.env,room.id,'/set-runtime/claim',{method:'POST',body:JSON.stringify({command})});
 if(!claim.claimed)return c.json({snapshot:current,result:{status:'committed',revision:current.revision,moduleEpoch:current.modules[module].epoch}});
 const deliver=async(op:string,fields:Record<string,string|number|boolean>)=>roomStateCall(c.env,room.id,'/set-runtime/command',{method:'POST',body:JSON.stringify({command:{...command,id:command.id+'-result',op,input:fields},principal:{role:'connector',id:'saved-connection',modules:[module]}})});
 try{
  const result=await querySavedConnection(c.env,binding.id,binding.revision,b.type==='agent'?{question:command.input?.question,mode:b.mode,instructions:b.prompt}:{...(current.modules[module].weatherLocation?{location:current.modules[module].weatherLocation}:{})});
  if(b.type==='agent'){const answer=result.result as AgentResult;return c.json(await deliver('agent.complete',{requestId:command.id,response:answer.response,citations:JSON.stringify(answer.citations)}));}
  return c.json(await deliver('weather.update',{...weatherPayload(result.result as WeatherResult),locationRevision:current.modules[module].weatherLocationRevision??0}));
 }catch(error){await deliver(b.type==='agent'?'agent.error':'weather.error',{requestId:command.id,locationRevision:current.modules[module].weatherLocationRevision??0,message:error instanceof ApiError?error.message:'The provider request did not complete'});throw error;}
});

setRuntimeHostRoutes.post('/rooms/:id/set-runtime/orchestrate',async c=>{
 const room=await loadRoom(c.env,c.req.param('id')),input=await body(c.req);if(Object.keys(input).some(k=>k!=='lifecycle'))throw new ApiError(400,'invalid_request','Invalid orchestration field');
 return c.json(await roomStateCall(c.env,room.id,'/set-runtime/orchestrate',{method:'POST',body:JSON.stringify(input)}));
});
