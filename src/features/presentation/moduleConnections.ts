import {weatherPayload} from '../../../shared/set-runtime/weather';
import {guests} from '../../lib/ipc';
import {dataIntegrations,type SavedConnection} from '../../lib/dataIntegrations';
import type {Command,Result,Snapshot} from '../../../shared/set-runtime/runtime';
import type {RehearsalSession} from './rehearsal';
import type {ModuleBindings} from '../../../shared/set-runtime/contract';
export type {ModuleBindings} from '../../../shared/set-runtime/contract';
export interface RuntimeReply {deployment:string|null;snapshot:Snapshot|null;result?:Result;serverNow?:number;controlProtocol?:number;controlFieldsProtocol?:number;setEpoch?:number;control?:import('../../../shared/set-runtime/control').ControlDefinition}
export async function moduleCall(endpoint:string,room:string,method:'GET'|'POST',suffix='',body?:unknown):Promise<RuntimeReply>{
 const response=await guests.request(endpoint,method,`/v1/app/live/rooms/${encodeURIComponent(room)}/set-runtime${suffix}`,body);
 if(!response.available)throw Error('This workspace server does not support set modules yet.');
 return response.body as RuntimeReply;
}
export async function requestModuleData(session:RehearsalSession,module:string,question:string,endpoint:string,room:string|undefined,bindings:ModuleBindings,connections:SavedConnection[],refresh=false){
 const snapshot=session.moduleSnapshot(),m=snapshot.modules[module],b=m&&session.package.runtime.definitions[m.definition].behavior;
 if(!m||!b||!('integrationRole'in b))throw Error('This module has no data connection');
 if(m.execution!=='running')throw Error('Start the module before requesting data');
 const binding=bindings[b.integrationRole],connection=connections.find(c=>c.connection.id===binding?.id&&c.revision===binding.revision);
 if(!connection)throw Error('Choose a current saved connection in the set editor');
 if(connection.connection.kind!==b.type)throw Error('Connection capability does not match');
 const command:Command={id:crypto.randomUUID(),setEpoch:snapshot.setEpoch,module,epoch:m.epoch,op:b.type==='agent'?'agent.ask':'weather.refresh',input:{question,...(b.type==='weather'&&refresh?{refresh:true}:{})}};
 if(session.snapshot().workspaceMode==='live'){
  if(!room)throw Error('Live modules require a connected room');
  const reply=await moduleCall(endpoint,room,'POST',`/modules/${encodeURIComponent(module)}/query`,{command});
  if(reply.snapshot)session.receiveModuleSnapshot(reply.snapshot);if(reply.result?.status==='rejected')throw Error(reply.result.error);return;
 }
 if(session.snapshot().workspaceMode!=='rehearsal')throw Error('Enter rehearsal to test this connection');
 if(b.type==='agent'){const result=await session.sendModule(module,'agent.ask',{question});if(result.status==='rejected')throw Error(result.error);}
 const current=session.moduleSnapshot(),target=current.modules[module],requestId=target.agent.requestId;
 try{
  const response=await dataIntegrations.query(endpoint,connection,b.type==='agent'?{question,mode:b.mode,instructions:b.prompt}:{...(target.weatherLocation?{location:target.weatherLocation}:{})},{refresh});
  const result=session.receiveModuleData({id:crypto.randomUUID(),setEpoch:current.setEpoch,module,epoch:target.epoch,op:b.type==='agent'?'agent.complete':'weather.update',input:b.type==='agent'?{requestId,response:(response.result as import('../../lib/dataIntegrations').AgentResult).response,citations:JSON.stringify((response.result as import('../../lib/dataIntegrations').AgentResult).citations)}:{...weatherPayload(response.result as import('../../lib/dataIntegrations').WeatherResult,response.cache,response.stale),locationRevision:target.weatherLocationRevision??0}});
  if(result.status==='rejected')throw Error(result.error);
 }catch(e){session.receiveModuleData({id:crypto.randomUUID(),setEpoch:current.setEpoch,module,epoch:target.epoch,op:b.type==='agent'?'agent.error':'weather.error',input:{requestId,locationRevision:target.weatherLocationRevision??0,message:e instanceof Error?e.message:'Provider request failed'}});throw e;}
}
