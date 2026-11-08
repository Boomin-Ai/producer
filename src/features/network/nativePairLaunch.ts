/** A single explicitly configured local dev run. A persisted nonce prevents
 * reload/HMR or reopening the app from sending another invitation. */
import {getIdentifier} from '@tauri-apps/api/app';
import {reportNetworkDevResult} from './networkDevReport';
import {validateNativePairFixture,type NativePairFixture,type NativePairProof} from './nativePairProof';

const APP='ai.boomin.producer.sets-v2-dev';
const CONSUMED_KEY='producer:dev:native-pair:last-consumed-run';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Launch={version:1;runId:string;fixture:NativePairFixture};
type Outcome='completed'|'refused'|'cancelled'|'not_ready'|'already_consumed'|'invalid_launch'|'storage_unavailable';
type Dependencies={
 document:Document;storage:Pick<Storage,'getItem'|'setItem'>;now:()=>number;
 driver:()=>NativePairProof|undefined;diagnosticsReady:()=>boolean;
 delay:(ms:number)=>Promise<void>;current:()=>boolean;
 onStart?:(driver:NativePairProof)=>void;
 report:(value:unknown)=>Promise<unknown>;
};

export function parseNativePairLaunch(raw:unknown):Launch|null {
 if(typeof raw!=='string'||raw.length>4096)return null;
 try{
  const value=JSON.parse(raw);
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||!UUID.test(value.runId)||
   Object.keys(value).some(key=>!['version','runId','fixture'].includes(key)))return null;
  const fixture=validateNativePairFixture(value.fixture);return fixture?{version:1,runId:value.runId,fixture}:null;
 }catch{return null;}
}

/** No media/engine APIs here. The existing real-UI driver enforces workspace,
 * ownership, output inactivity and admission at the moment of each action. */
export async function runConfiguredNativePair(raw:unknown,deps:Dependencies):Promise<Outcome>{
 const launch=parseNativePairLaunch(raw);if(!launch)return 'invalid_launch';
 try{
  const stored=deps.storage.getItem(CONSUMED_KEY);
  if(stored&&stored.length>4096)return 'storage_unavailable';
  const consumed:string[]=!stored?[]:UUID.test(stored)?[stored]:JSON.parse(stored);
  if(!Array.isArray(consumed)||consumed.length>64||consumed.some(value=>typeof value!=='string'||!UUID.test(value)))return 'storage_unavailable';
  if(consumed.includes(launch.runId))return 'already_consumed';
  // Keep a bounded replay history. A full ledger refuses new runs until the
  // developer explicitly archives/resets it; old launches never become live.
  if(consumed.length===64)return 'storage_unavailable';
  // Consume before waiting or any UI action. Cancellation and failed starts
  // require an intentional new nonce, never an automatic retry.
  const saved=JSON.stringify([...consumed,launch.runId]);deps.storage.setItem(CONSUMED_KEY,saved);
  if(deps.storage.getItem(CONSUMED_KEY)!==saved)return 'storage_unavailable';
 }catch{return 'storage_unavailable';}
 const end=deps.now()+30000;
 for(;;){
  if(!deps.current())return 'cancelled';
  if(deps.document.visibilityState==='visible'&&deps.diagnosticsReady()&&deps.driver()&&
   deps.document.querySelector('#sec-livenow button[data-producer-network-room-id]'))break;
  if(deps.now()>=end)return 'not_ready';
  await deps.delay(200);
 }
 if(!deps.current())return 'cancelled';
 const driver=deps.driver();if(!driver||driver.status().phase!=='idle'||driver.status().attempted)return 'not_ready';
 let result:Awaited<ReturnType<NativePairProof['run']>>;
 try{deps.onStart?.(driver);result=await driver.run(launch.fixture);}catch{return 'refused';}
 if(!deps.current())return 'cancelled';
 // Only the allowlisted numeric/enum report is persisted. No fixture IDs,
 // token, invite, account metadata or raw PCM is included.
 const diagnostics=result.diagnostics;
 await deps.report({...result,diagnostics:diagnostics?{...diagnostics,samples:diagnostics.samples.slice(-8)}:null}).catch(()=>{});
 return result.reason==='completed'?'completed':'refused';
}

let disposed=false,started=false,activeDriver:NativePairProof|undefined;
export async function launchNativePairFromEnvironment():Promise<void>{
 if(started||disposed||!import.meta.env.DEV||import.meta.env.VITE_PRODUCER_NATIVE_PAIR_PROOF!=='1'||
  import.meta.env.VITE_PRODUCER_NETWORK_DIAGNOSTICS!=='1'||!('__TAURI_INTERNALS__' in window)||
  !parseNativePairLaunch(import.meta.env.VITE_PRODUCER_NATIVE_PAIR_RUN))return;
 started=true;
 if(await getIdentifier().catch(()=>null)!==APP||disposed)return;
 let storage:Storage;try{storage=window.localStorage;}catch{return;}
 const outcome=await runConfiguredNativePair(import.meta.env.VITE_PRODUCER_NATIVE_PAIR_RUN,{
  document,storage,now:()=>performance.now(),driver:()=>window.__producerNativePairProof,onStart:driver=>{activeDriver=driver;},
  diagnosticsReady:()=>!!window.__producerNetworkDiagnostics,delay:ms=>new Promise(resolve=>setTimeout(resolve,ms)),current:()=>!disposed,
  report:reportNetworkDevResult,
 });
 if(!disposed&&outcome!=='completed'&&outcome!=='refused'){
  await reportNetworkDevResult({kind:'producer-native-pair-launch',version:1,outcome}).catch(()=>{});
 }
}
import.meta.hot?.dispose(()=>{disposed=true;activeDriver?.cancel();});
