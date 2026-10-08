import {useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {ipc,type LiveSources} from '../src/lib/ipc';
import {RehearsalSession} from '../src/features/presentation/rehearsal';
import {useSetOutput} from '../src/features/presentation/useSetOutput';
import {AFTER_HOURS} from '../src/features/presentation/fixtures';
const calls:Array<{kind:string;bytes:number}>=[];(globalThis as unknown as {calls:typeof calls}).calls=calls;
let status={generation:0,lease:null as string|null,revision:0};const cache:Record<string,unknown>={};
ipc.liveSetStatus=async()=>({...status});
ipc.liveSetWarm=async request=>{calls.push({kind:'warm',bytes:JSON.stringify(request).length});Object.assign(cache,request.projection.assets,request.preload?.assets);await new Promise(r=>setTimeout(r,10));};
ipc.liveSetApply=async request=>{calls.push({kind:'apply',bytes:JSON.stringify(request).length});Object.assign(cache,request.projection.assets,request.preload?.assets);const check=(node:typeof request.projection.root)=>{if(node.assetId&&!cache[node.assetId])throw new Error('Missing media asset or invalid media fit');node.children.forEach(check);};check(request.projection.root);if(Object.values(request.bindings).includes('camera'))throw new Error('Camera must be on the room output before assigning it');await new Promise(r=>setTimeout(r,10));status={generation:status.generation,lease:request.lease,revision:request.projection.revision};return {...status};};
ipc.liveSetReturn=async()=>{status={generation:status.generation+1,lease:null,revision:0};for(const id of Object.keys(cache))delete cache[id];return {...status};};
const sources={items:[{id:'camera',kind:'camera',visible:false,has_frame:true},{id:'camera-2',kind:'camera',visible:true,has_frame:true}]} as unknown as LiveSources;
function App(){
 const [session,setSession]=useState(()=>new RehearsalSession(AFTER_HOURS,undefined,'prepare'));
 const state=useSyncExternalStore(session.subscribe,session.snapshot),output=useSetOutput(session,'speed-test-room',sources,true,{host:'camera'});
 return <main><input aria-label="Load speed package" type="file" onChange={async e=>{const file=e.target.files?.[0];if(file)setSession(new RehearsalSession(JSON.parse(await file.text()),undefined,'prepare'));}}/>
 <button onClick={()=>void output.apply()}>Send to output</button><button onClick={()=>session.send({type:'field',key:'briefTitle',value:'Immediate content edit'})}>Edit title</button><button onClick={()=>session.mediaCommand('hero','pause')}>Pause clip</button>
 <button onClick={()=>{for(const id of Object.keys(cache))delete cache[id];status={generation:status.generation+1,lease:null,revision:0};}}>Change room scene</button>
 <button onClick={()=>{for(const id of Object.keys(cache))delete cache[id];}}>Discard preparation cache</button>
 <span data-testid="active">{String(output.active)}</span><span role="alert">{output.error}</span><span>{state.values.briefTitle}</span></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
