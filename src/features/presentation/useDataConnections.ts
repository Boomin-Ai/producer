import {useEffect,useRef,useState} from 'react';
import {dataIntegrations,type SavedConnection} from '../../lib/dataIntegrations';
/** Saved integrations recover independently of the Set draft and runtime. */
export function useDataConnections(endpoint:string|undefined){
 const [state,setState]=useState<{endpoint?:string;connections:SavedConnection[];error:string}>({endpoint,connections:[],error:''});
 const retry=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let disposed=false,busy=false,failures=0,timer:ReturnType<typeof setTimeout>|undefined;
  const load=async()=>{
   if(disposed||busy||!endpoint)return;busy=true;clearTimeout(timer);
   try{const result=await dataIntegrations.list(endpoint);if(!disposed){failures=0;setState({endpoint,connections:result.connections,error:''});}}
   catch(error){if(!disposed){setState(old=>({endpoint,connections:old.endpoint===endpoint?old.connections:[],error:String(error)}));timer=setTimeout(()=>void load(),Math.min(15000,1000*2**Math.min(failures++,4)));}}
   finally{busy=false;}
  };
  const refresh=()=>{clearTimeout(timer);void load();};retry.current=refresh;
  if(endpoint)void load();else setState({endpoint,connections:[],error:''});
  window.addEventListener('focus',refresh);
  return()=>{disposed=true;clearTimeout(timer);window.removeEventListener('focus',refresh);retry.current=()=>{};};
 },[endpoint]);
 return {connections:state.endpoint===endpoint?state.connections:[],connectionError:state.endpoint===endpoint?state.error:'',retryConnections:()=>retry.current()};
}
