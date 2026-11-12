import {useCallback,useSyncExternalStore} from 'react';
import {dj,type DJStatus,type DJAction} from './dj';
type State={status?:DJStatus;error:string;pending:boolean};
let state:State={error:'',pending:false},timer:ReturnType<typeof setTimeout>|undefined,epoch=0,revision=0;
const listeners=new Set<()=>void>();
function update(next:State){state=next;for(const fn of listeners)fn();}
async function poll(generation:number){
  const version=revision;
  try{const status=await dj.control({kind:'status'});if(generation!==epoch)return;if(version===revision)update({...state,status,error:status.error??''});}
  catch(error){if(generation===epoch)update({...state,error:String(error)});}
  if(generation===epoch)timer=setTimeout(()=>void poll(generation),state.error?1000:350);
}
export function observeDjStatus(listener:()=>void){listeners.add(listener);if(listeners.size===1)void poll(++epoch);return()=>{listeners.delete(listener);if(!listeners.size){++epoch;clearTimeout(timer);}};}
export const djSnapshot=()=>state;
const EMPTY:State={error:'',pending:false};
export const useDjStatus=(enabled=true)=>useSyncExternalStore(useCallback((fn:()=>void)=>enabled?observeDjStatus(fn):()=>{},[enabled]),enabled?djSnapshot:()=>EMPTY);
/** One action owner across expanded/minimized controls. Mix changes use fresh state. */
export async function commandDj(make:DJAction|((status:DJStatus)=>DJAction)){
  if(state.pending)throw Error('Music is updating. Try again in a moment.');
  ++revision;update({...state,pending:true,error:''});
  try{const current=await dj.control({kind:'status'}),action=typeof make==='function'?make(current):make;
    const status=await dj.control(action);if(status.error)throw Error(status.error);update({status,pending:false,error:''});return status;
  }catch(error){update({...state,pending:false,error:String(error)});throw error;}
}
