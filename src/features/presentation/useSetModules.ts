import {subscribeModulePush} from './modulePush';
import {availableControlCatalog} from './controlCatalog';
import {uiLog} from '../../lib/ipc';
import {dataIntegrations} from '../../lib/dataIntegrations';
import {useEffect,useRef} from 'react';
import {moduleCall,type ModuleBindings} from './moduleConnections';
import type {RehearsalSession} from './rehearsal';
export function useSetModules(session:RehearsalSession,endpoint:string|undefined,room:string|undefined,active:boolean,mode:string,bindings:ModuleBindings,host=true){
 const queue=useRef<Promise<unknown>>(Promise.resolve());
 useEffect(()=>{if(import.meta.env.DEV)uiLog('[set-modules] '+JSON.stringify({set:session.package.id,active,mode,endpoint:!!endpoint,room:!!room}));if(host&&active&&mode==='prepare')session.enterLive();},[session,active,mode,host]);
 const signature=JSON.stringify([session.package.id,session.package.version,session.package.runtime,bindings]),generation=useRef(0);
 useEffect(()=>{
  const ticket=++generation.current;let disposed=false,replaced=false,timer:ReturnType<typeof setTimeout>;
  const valid=()=>!disposed&&!replaced&&ticket===generation.current;
  if(!host||mode!=='live')return;
  if(!endpoint||!room){session.attachModuleTransport(undefined,'Connect this room to a workspace to use live modules. Rehearsal is available in the editor.');return;}
  session.attachModuleTransport(undefined);
  let deployment='',lastLifecycle='',refreshing=false,refreshAgain=false,initialized=false,controlled=false;
  let weatherTimer:ReturnType<typeof setInterval>|undefined;
  const lifecycle=(value:{segment:string;running:boolean;paused:boolean})=>{const desired={setEpoch:session.moduleSnapshot().setEpoch,...value,showAttached:!!session.package.show,visible:active},identity=JSON.stringify(desired);if(identity===lastLifecycle)return;lastLifecycle=identity;queue.current=queue.current.catch(()=>{}).then(async()=>{if(!valid())return;const reply=await moduleCall(endpoint,room,'POST','/orchestrate',{lifecycle:desired});if(!valid())return;if(reply.snapshot)session.receiveModuleSnapshot(reply.snapshot,reply.serverNow);if(reply.result?.status==='rejected')throw Error(reply.result.error);}).catch(e=>{if(valid()){lastLifecycle='';session.attachModuleTransport(undefined,e instanceof Error?e.message:'Show module transition failed');}});};
  const weatherAttempts=new Map<string,number>(),weatherIntervals=new Map<string,number>();
  const pollWeather=()=>{for(const instance of session.package.runtime.instances){const b=session.package.runtime.definitions[instance.definition].behavior,m=session.moduleSnapshot().modules[instance.id];if(b?.type!=='weather'||m?.execution!=='running'||!bindings[b.integrationRole]?.id)continue;const now=Date.now(),interval=weatherIntervals.get(b.integrationRole)??60000,attemptKey=instance.id+':'+(m.weatherLocationRevision??0);if(now-(m.weather?.at??0)<interval||now-(weatherAttempts.get(attemptKey)??0)<Math.min(interval,5000))continue;weatherAttempts.set(attemptKey,now);const command={id:crypto.randomUUID(),setEpoch:session.moduleSnapshot().setEpoch,module:instance.id,epoch:m.epoch,op:'weather.refresh'};void moduleCall(endpoint,room,'POST',`/modules/${encodeURIComponent(instance.id)}/query`,{command}).then(reply=>{if(valid()&&reply.snapshot)session.receiveModuleSnapshot(reply.snapshot,reply.serverNow);}).catch(()=>{});}};
  const attach=()=>{session.attachModuleLifecycle(controlled?undefined:lifecycle);session.attachControlTransport(controlled?async command=>{if(!valid())throw Error('Set connection expired');const reply=await moduleCall(endpoint,room,'POST','/control',{command});if(!valid())throw Error('Set connection expired');if(reply.snapshot)session.receiveModuleSnapshot(reply.snapshot,reply.serverNow);if(!reply.result)throw Error('Missing control receipt');return reply.result;}:undefined,controlled);session.attachModuleTransport(async command=>{if(!valid())throw Error('Set connection expired');const result=await moduleCall(endpoint,room,'POST','/commands',{command});if(valid()&&result.snapshot)session.receiveModuleSnapshot(result.snapshot,result.serverNow);if(!result.result)throw Error('Missing command receipt');return result.result;});};
  const refresh=async()=>{
   if(!valid()||!initialized)return;if(refreshing){refreshAgain=true;return;}refreshing=true;clearTimeout(timer);
   try{const reply=await moduleCall(endpoint,room,'GET');if(!valid())return;if(reply.deployment!==deployment){replaced=true;session.attachModuleTransport(undefined,'The room’s set was replaced. Reload its configuration.');return;}if(reply.snapshot)session.receiveModuleSnapshot(reply.snapshot,reply.serverNow);attach();pollWeather();}
   catch(e){if(valid()){session.attachControlTransport(undefined);session.attachModuleTransport(undefined,e instanceof Error?e.message:String(e));}}
   finally{refreshing=false;if(valid()){if(refreshAgain){refreshAgain=false;void refresh();}else timer=setTimeout(()=>void refresh(),push.ready()?30000:1000);}}
  };
  const push=subscribeModulePush(endpoint,room,event=>{
   if(!valid()||!initialized)return;
   if(event.type==='presentation')return;
   if(event.type==='update'){
    if(event.setEpoch<session.moduleSnapshot().setEpoch)return;
    if(event.deployment!==deployment){replaced=true;session.attachModuleTransport(undefined,'The room’s set was replaced. Reload its configuration.');return;}
    if(event.snapshot){session.receiveModuleSnapshot(event.snapshot,event.serverNow);return;}
   }
   void refresh();
  });
  let connectionAttempts=0;
  const connect=async()=>{
   try{
    const catalog=availableControlCatalog(session.package),capabilities=catalog?await moduleCall(endpoint,room,'GET','/capabilities').catch(()=>undefined):undefined;
    controlled=!!catalog&&capabilities?.controlProtocol===1&&(!catalog.fields||capabilities.controlFieldsProtocol===1);
    if(!valid())return;
    session.attachControlTransport(undefined,controlled);
    const saved=await dataIntegrations.list(endpoint).catch(()=>({connections:[]}));for(const [role,binding]of Object.entries(bindings)){const c=saved.connections.find(c=>c.connection.id===binding.id)?.connection;if(c?.kind==='weather')weatherIntervals.set(role,c.pollSeconds*1000);}
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(controlled?JSON.stringify([session.package,bindings,catalog]):signature));deployment='set-'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
    const previous=await moduleCall(endpoint,room,'GET');if(!valid())return;
    const reply=previous.deployment===deployment?previous:await moduleCall(endpoint,room,'POST','',{deployment,definition:session.package.runtime,bindings,expectedEpoch:previous.snapshot?.setEpoch??0,...(controlled?{control:catalog}:{})});
    if(!valid())return;if(reply.snapshot)session.receiveModuleSnapshot(reply.snapshot,reply.serverNow);
    initialized=true;attach();
    if(!weatherTimer)weatherTimer=setInterval(()=>{if(valid()&&session.snapshot().moduleConnection==='live')pollWeather();},1000);
    void refresh();
   }catch(e){if(valid()){session.attachModuleTransport(undefined,e instanceof Error?e.message:String(e));timer=setTimeout(()=>void connect(),Math.min(15000,1000*2**Math.min(connectionAttempts++,4)));}}
  };
  void connect();
  return()=>{disposed=true;clearTimeout(timer);clearInterval(weatherTimer);push.close();session.attachControlTransport(undefined);session.attachModuleLifecycle(undefined);session.attachModuleTransport(undefined);};
 },[session,session.package,endpoint,room,active,mode,signature,host]);

}
