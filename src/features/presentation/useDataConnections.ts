import {parseAdapterManifest} from '../../../shared/set-runtime/dataAdapters';
import {useEffect,useRef,useState} from 'react';
import {dataIntegrations,type SavedConnection} from '../../lib/dataIntegrations';
/** Saved integrations recover independently of the Set draft and runtime. */
export function useDataConnections(endpoint:string|undefined){
 const [state,setState]=useState<{endpoint?:string;connections:SavedConnection[];adapters:import('../../../shared/set-runtime/dataAdapters').DataAdapterManifest[];error:string}>({endpoint,connections:[],adapters:[],error:''});
 const retry=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let disposed=false,busy=false,failures=0,timer:ReturnType<typeof setTimeout>|undefined;
  const load=async()=>{
   if(disposed||busy||!endpoint)return;busy=true;clearTimeout(timer);
   try{const result=await dataIntegrations.list(endpoint);if(result.adapters&&(!Array.isArray(result.adapters)||result.adapters.length>128))throw Error('Workspace adapter catalog is invalid.');const adapters=(result.adapters??[]).map(parseAdapterManifest);if(!disposed){failures=0;setState({endpoint,connections:result.connections,adapters,error:''});}}
   catch(error){if(!disposed){setState(old=>({endpoint,connections:old.endpoint===endpoint?old.connections:[],adapters:old.endpoint===endpoint?old.adapters:[],error:String(error)}));timer=setTimeout(()=>void load(),Math.min(15000,1000*2**Math.min(failures++,4)));}}
   finally{busy=false;}
  };
  const refresh=()=>{clearTimeout(timer);void load();};retry.current=refresh;
  if(endpoint)void load();else setState({endpoint,connections:[],adapters:[],error:''});
  window.addEventListener('focus',refresh);window.addEventListener('producer:data-connections-changed',refresh);
  return()=>{disposed=true;clearTimeout(timer);window.removeEventListener('focus',refresh);window.removeEventListener('producer:data-connections-changed',refresh);retry.current=()=>{};};
 },[endpoint]);
 return {adapters:state.endpoint===endpoint?state.adapters:[],connections:state.endpoint===endpoint?state.connections:[],connectionError:state.endpoint===endpoint?state.error:'',retryConnections:()=>retry.current()};
}
