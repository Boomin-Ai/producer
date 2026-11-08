import {useEffect} from 'react';
import {requestModuleData,type ModuleBindings} from './moduleConnections';
import type {RehearsalSession} from './rehearsal';
import type {SavedConnection} from '../../lib/dataIntegrations';
/** Rehearsal reads the same trusted connector but never changes the room's runtime. */
export function useSocialRehearsal(session:RehearsalSession,endpoint:string|undefined,bindings:ModuleBindings,connections:SavedConnection[],mode:string){
 const signature=JSON.stringify([bindings,connections.map(c=>[c.connection.id,c.revision])]);
 useEffect(()=>{if(mode!=='rehearsal'||!endpoint)return;let cancelled=false,busy=false;const poll=async()=>{if(cancelled||busy)return;busy=true;try{for(const instance of session.package.runtime.instances){const b=session.package.runtime.definitions[instance.definition].behavior,m=session.moduleSnapshot().modules[instance.id];if(b?.type==='social'&&m?.execution==='running'&&bindings[b.integrationRole]?.id){if(cancelled)return;await requestModuleData(session,instance.id,'',endpoint,undefined,bindings,connections).catch(()=>{});}}}finally{busy=false;}};void poll();const timer=setInterval(()=>void poll(),3000);return()=>{cancelled=true;clearInterval(timer);};},[session,endpoint,signature,mode]);
}
