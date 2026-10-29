import type { Snapshot } from '../../../shared/set-runtime/runtime';
import {parsePresentationReceipt,type ConfirmedPresentation} from '../../../shared/set-runtime/presentationReceipt';
export type ModulePushEvent = { type:'ready'|'offline' } | {type:'presentation';deployment:string;presentation:ConfirmedPresentation} | { type:'update'; deployment:string; setEpoch:number; revision:number; snapshot?:Snapshot;serverNow?:number };
type Listener = (event:ModulePushEvent)=>void;
interface Channel { owner?:symbol; ready:boolean; listeners:Set<Listener> }
const channels = new Map<string,Channel>();
const key = (endpoint:string,room:string)=>JSON.stringify([endpoint,room]);
function channel(endpoint:string,room:string) {
  const id=key(endpoint,room);let c=channels.get(id);
  if(!c){c={ready:false,listeners:new Set()};channels.set(id,c);}return {id,c};
}
/** A scoped bridge from the existing room socket; never opens another connection.
 * Ownership fences late callbacks from an old socket after room replacement. */
export function modulePushPublisher(endpoint:string,room:string) {
  const {id,c}=channel(endpoint,room),owner=Symbol();c.owner=owner;c.ready=false;
  const emit=(event:ModulePushEvent)=>{if(c.owner===owner)for(const listener of [...c.listeners])listener(event);};
  emit({type:'offline'});
  return {
    frame(frame:Record<string,unknown>) {
      if(c.owner!==owner)return;
      if(frame.type==='set.runtime.ready'&&frame.protocol===1){c.ready=true;emit({type:'ready'});}
      else if(frame.type==='set.runtime.unavailable'){c.ready=false;emit({type:'offline'});}
      else if(frame.type==='set.presentation'&&c.ready&&typeof frame.deployment==='string'){
        try{const p=frame.presentation as ConfirmedPresentation,{at,publisher,...receipt}=p;parsePresentationReceipt(receipt);if(!Number.isFinite(at)||typeof publisher!=='string')return;emit({type:'presentation',deployment:frame.deployment,presentation:p});}catch{}
      }
      else if(frame.type==='set.runtime'&&c.ready&&typeof frame.deployment==='string'&&Number.isSafeInteger(frame.setEpoch)&&Number.isSafeInteger(frame.revision)&&(frame.setEpoch as number)>0&&(frame.revision as number)>=0){
        const snapshot=frame.snapshot as Snapshot|undefined;
        if(snapshot&&(!Number.isSafeInteger(snapshot.setEpoch)||!Number.isSafeInteger(snapshot.revision)||snapshot.setEpoch!==frame.setEpoch||snapshot.revision!==frame.revision||!snapshot.modules||typeof snapshot.modules!=='object'))return;
        emit({type:'update',deployment:frame.deployment,setEpoch:frame.setEpoch as number,revision:frame.revision as number,...(snapshot?{snapshot}:{} ),...(typeof frame.serverNow==='number'&&Number.isFinite(frame.serverNow)?{serverNow:frame.serverNow}:{})});
      }
    },
    offline(){if(c.owner===owner){c.ready=false;emit({type:'offline'});}},
    close(){if(c.owner!==owner)return;c.ready=false;emit({type:'offline'});delete c.owner;if(!c.listeners.size)channels.delete(id);},
  };
}
export function subscribeModulePush(endpoint:string,room:string,listener:Listener) {
  const {id,c}=channel(endpoint,room);c.listeners.add(listener);
  return { ready:()=>c.ready, close:()=>{c.listeners.delete(listener);if(!c.owner&&!c.listeners.size)channels.delete(id);} };
}
