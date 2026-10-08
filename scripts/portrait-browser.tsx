import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OutputSettings,RoomOutputView,type OutputView,type PortraitMonitor} from '../src/features/presentation/OutputSettings';
import {PortraitCanvas} from '../src/features/presentation/PortraitCanvas';
import {RehearsalSession} from '../src/features/presentation/rehearsal';
import {AFTER_HOURS} from '../src/features/presentation/fixtures';
import {ipc,type LiveSources} from '../src/lib/ipc';
import type {SetOutputControls} from '../src/features/presentation/useSetOutput';
import '../src/App.css';
const proof={requests:[] as unknown[],stops:0,previews:[] as unknown[],transforms:[] as unknown[],roomStarts:0,jpegCalls:0,landscapeEdits:0};Object.assign(window,{portraitProof:proof});
ipc.liveSetStatus=async()=>({generation:3,lease:null,revision:0});
ipc.livePortraitApply=async request=>{proof.requests.push(request);};
ipc.livePortraitFrame=async()=>{proof.jpegCalls++;throw new Error('JPEG polling must not render the room');};
ipc.liveSetSelection=async()=>{};
ipc.liveSetTransform=async()=>{proof.landscapeEdits++;};
ipc.livePortraitStop=async()=>{proof.stops++;};
const sources={items:[{id:'camera',label:'Camera',kind:'camera',visible:true,has_frame:true,src_w:1920,src_h:1080,x:40,y:400,w:640,h:360,rot:0,z:0,crop_left:0,crop_top:0,crop_right:0,crop_bottom:0}]} as LiveSources;
ipc.livePortraitRoom=async()=>{proof.roomStarts++;return structuredClone(sources);};
ipc.livePortraitState=async()=>structuredClone(sources);
ipc.livePortraitTransform=async(id,patch)=>{proof.transforms.push({id,patch});Object.assign(sources.items!.find(s=>s.id===id)!,patch);return structuredClone(sources);};
ipc.livePortraitPreview=async rect=>{proof.previews.push(rect);return false;};
const output={active:false,busy:false,error:'',bindings:{host:'camera'},framing:{},sources,bind:()=>{},frame:()=>{},apply:async()=>{},returnToRoom:async()=>true} as SetOutputControls;
function Harness(){
 const [view,setView]=useState<OutputView>('landscape');const [monitor,setMonitor]=useState<PortraitMonitor>({busy:false,error:''});
 const [selected,setSelected]=useState<string|null>(null);
 const [session]=useState(()=>{
 const doc=structuredClone(AFTER_HOURS);
 if(new URLSearchParams(location.search).has('paired')){doc.set.layouts=doc.set.layouts.slice(0,1).flatMap(l=>['opening','next'].flatMap(id=>[{...structuredClone(l),id:id+'-landscape',width:1280,height:720},{...structuredClone(l),id:id+'-portrait',width:720,height:1280,root:{...structuredClone(l.root),id:id+'-portrait-canvas'}}]));doc.set.initialLayout='opening-landscape';doc.set.controls=[];}
 return new RehearsalSession(doc,undefined,'prepare');});
 const [applied,setApplied]=useState(false);
 const paired=new URLSearchParams(location.search).has('paired');
 return <div style={{height:'90vh',display:'flex',flexDirection:'column',padding:20}}><RoomOutputView view={view} portrait={monitor} portraitContent={<PortraitCanvas monitor={monitor} selected={selected} onSelect={setSelected} onSources={sources=>setMonitor(old=>({...old,sources}))}/>}>{view!=='portrait'&&<div className="rm-landscape-monitor"><div className="live-preview" aria-label="Landscape room output" style={{background:'#26495c'}}>Landscape</div></div>}</RoomOutputView>{paired&&<><button onClick={()=>setApplied(true)}>Apply test set</button><button onClick={()=>session.send({type:'control',action:{type:'layout.select',layoutId:'next-landscape'}})}>Next layout</button></>}<OutputSettings icon="⚙" session={session} output={{...output,active:applied}} sourceNames={{camera:'Djayla'}} view={view} onViewChange={setView} onMonitor={setMonitor}/></div>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
