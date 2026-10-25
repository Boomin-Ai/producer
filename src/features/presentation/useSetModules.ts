import {uiLog} from '../../lib/ipc';
import {dataIntegrations} from '../../lib/dataIntegrations';
import {useEffect,useRef} from 'react';
import {moduleCall,type ModuleBindings} from './moduleConnections';
import type {RehearsalSession} from './rehearsal';
export function useSetModules(session:RehearsalSession,endpoint:string|undefined,room:string|undefined,active:boolean,mode:string,bindings:ModuleBindings){
 const queue=useRef<Promise<unknown>>(Promise.resolve());
 useEffect(()=>{if(import.meta.env.DEV)uiLog('[set-modules] '+JSON.stringify({set:session.package.id,active,mode,endpoint:!!endpoint,room:!!room}));if(active&&mode==='prepare')session.enterLive();},[session,active,mode]);
 const signature=JSON.stringify([session.package.id,session.package.version,session.package.runtime,bindings]),generation=useRef(0);
 useEffect(()=>{
  const ticket=++generation.current;let disposed=false,timer:ReturnType<typeof setTimeout>;
  const valid=()=>!disposed&&ticket===generation.current;
  if(!session.package.runtime.instances.length||mode!=='live')return;
  if(!endpoint||!room){session.attachModuleTransport(undefined,'Connect this room to a workspace to use live modules. Rehearsal is available in the editor.');return;}
  session.attachModuleTransport(undefined);
  let deployment='',lastLifecycle='';
  const lifecycle=(value:{segment:string;running:boolean;paused:boolean})=>{const desired={setEpoch:session.moduleSnapshot().setEpoch,...value,showAttached:!!session.package.show,visible:active},identity=JSON.stringify(desired);if(identity===lastLifecycle)return;lastLifecycle=identity;queue.current=queue.current.catch(()=>{}).then(async()=>{if(!valid())return;const reply=await moduleCall(endpoint,room,'POST','/orchestrate',{lifecycle:desired});if(!valid())return;if(reply.snapshot)session.receiveModuleSnapshot(reply.snapshot);if(reply.result?.status==='rejected')throw Error(reply.result.error);}).catch(e=>{if(valid()){lastLifecycle='';session.attachModuleTransport(undefined,e instanceof Error?e.message:'Show module transition failed');}});};
  const weatherAttempts=new Map<string,number>(),weatherIntervals=new Map<string,number>();
  const pollWeather=()=>{for(const instance of session.package.runtime.instances){const b=session.package.runtime.definitions[instance.definition].behavior,m=session.moduleSnapshot().modules[instance.id];if(b?.type!=='weather'||m?.execution!=='running'||!bindings[b.integrationRole]?.id)continue;const now=Date.now(),interval=weatherIntervals.get(b.integrationRole)??60000;if(now-(m.weather?.at??0)<interval||now-(weatherAttempts.get(instance.id)??0)<interval)continue;weatherAttempts.set(instance.id,now);const command={id:crypto.randomUUID(),setEpoch:session.moduleSnapshot().setEpoch,module:instance.id,epoch:m.epoch,op:'weather.refresh'};void moduleCall(endpoint,room,'POST',`/modules/${encodeURIComponent(instance.id)}/query`,{command}).then(reply=>{if(valid()&&reply.snapshot)session.receiveModuleSnapshot(reply.snapshot);}).catch(()=>{});}};
  const attach=()=>{session.attachModuleLifecycle(lifecycle);session.attachModuleTransport(async command=>{if(!valid())throw Error('Set connection expired');const result=await moduleCall(endpoint,room,'POST','/commands',{command});if(valid()&&result.snapshot)session.receiveModuleSnapshot(result.snapshot);if(!result.result)throw Error('Missing command receipt');return result.result;});};
  const refresh=async()=>{
   try{const reply=await moduleCall(endpoint,room,'GET');if(!valid())return;if(reply.deployment!==deployment)throw Error('The room’s set was replaced. Apply this set again to take control.');if(reply.snapshot)session.receiveModuleSnapshot(reply.snapshot);attach();pollWeather();}
   catch(e){if(valid())session.attachModuleTransport(undefined,e instanceof Error?e.message:'Live module connection failed');}
   finally{if(valid())timer=setTimeout(()=>void refresh(),1000);}
  };
  void (async()=>{
   try{
    const saved=await dataIntegrations.list(endpoint).catch(()=>({connections:[]}));for(const [role,binding]of Object.entries(bindings)){const c=saved.connections.find(c=>c.connection.id===binding.id)?.connection;if(c?.kind==='weather')weatherIntervals.set(role,c.pollSeconds*1000);}
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(signature));deployment='set-'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
    const previous=await moduleCall(endpoint,room,'GET');if(!valid())return;
    const reply=previous.deployment===deployment?previous:await moduleCall(endpoint,room,'POST','',{deployment,definition:session.package.runtime,bindings,expectedEpoch:previous.snapshot?.setEpoch??0});
    if(!valid())return;if(reply.snapshot)session.receiveModuleSnapshot(reply.snapshot);
    attach();
    timer=setTimeout(()=>void refresh(),1000);
   }catch(e){if(valid())session.attachModuleTransport(undefined,e instanceof Error?e.message:'Live module connection failed');}
  })();
  return()=>{disposed=true;clearTimeout(timer);session.attachModuleLifecycle(undefined);session.attachModuleTransport(undefined);};
 },[session,endpoint,room,active,mode,signature]);

}
