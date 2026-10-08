import {AssetTransport} from './assetTransport';
import {useEffect,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {ipc} from '../../lib/ipc';
import {sharedProgramCapture} from '../../lib/programCapture';
import {RehearsalSession} from './rehearsal';
import {setOutputProjection,nextSetProjection,type SetOutputControls} from './useSetOutput';

export type OutputView = 'landscape'|'portrait'|'both';
export type PortraitMonitor = {busy:boolean;error:string;sources?:import('../../lib/ipc').LiveSources;editing?:boolean};
export function RoomOutputView({view,portrait,portraitContent,children}:{view:OutputView;portrait:PortraitMonitor;portraitContent?:ReactNode;children:ReactNode}){
 return <div className={`rm-canvas output-view-${view}`}>{children}{view!=='landscape'&&<div className="rm-portrait-monitor" aria-label="Portrait room output">
  {portraitContent??<div role="status">{portrait.error||'Native portrait canvas'}</div>}
  {portrait.error&&<div className="rm-portrait-error" role="alert">{portrait.error}</div>}
 </div>}</div>;
}
export function OutputSettings({icon,session,output,sourceNames,view='landscape',onViewChange,onMonitor}:{icon:ReactNode;session:RehearsalSession;output:SetOutputControls;sourceNames:Record<string,string>;view?:OutputView;onViewChange?:(view:OutputView)=>void;onMonitor?:(monitor:PortraitMonitor)=>void}){
 const pop=useRef<HTMLElement>(null);
 const state=useSyncExternalStore(session.subscribe,session.snapshot);
 const [active,setActive]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [layout,setLayout]=useState('auto');const [sources,setSources]=useState<import('../../lib/ipc').LiveSources>();
 const media=useRef(new AssetTransport());
 const cacheGeneration=useRef<number|null>(null);
 const checkGeneration=(generation:number)=>{if(cacheGeneration.current!==generation){media.current.clear();warmed.current='';cacheGeneration.current=generation;}};
 const lease=useRef(crypto.randomUUID()),revision=useRef(0),flight=useRef(false),fingerprint=useRef('');
 const portraits=session.package.set.layouts.filter(l=>l.height>l.width);
 const pairedId=state.layoutId.replace(/-landscape$/,'-portrait');
 const matched=portraits.find(l=>l.id===pairedId)?.id??(portraits.length===1?portraits[0].id:undefined);
 const effectiveLayout=layout==='auto'?matched:layout;
 const authored=output.active&&effectiveLayout!=='room'&&portraits.some(l=>l.id===effectiveLayout);
 const warmed=useRef('');
 const wake=useRef<()=>void>(()=>{}),pending=useRef(false);
 const latest=useRef({session,output,layout:effectiveLayout,state,authored});latest.current={session,output,layout:effectiveLayout,state,authored};
 useEffect(()=>{const reset=()=>{fingerprint.current='';warmed.current='';media.current.clear();pending.current=true;wake.current();};window.addEventListener('producer.video-changed',reset);return()=>window.removeEventListener('producer.video-changed',reset);},[]);
 useEffect(()=>{onMonitor?.({busy,error,sources,editing:!authored});},[busy,error,sources,authored,onMonitor]);
 useEffect(()=>()=>{void ipc.livePortraitStop().catch(()=>{});},[]);
 useEffect(()=>{
  if(!active&&!authored)return;
  let alive=true;
  const update=async()=>{
   if(flight.current){pending.current=true;return;}flight.current=true;
   try{
    const current=latest.current;
    if(!current.authored){
     if(fingerprint.current!=='room'){setBusy(true);const sources=await ipc.livePortraitRoom();if(alive){setSources(sources);fingerprint.current='room';media.current.clear();}}
     else{const sources=await ipc.livePortraitState();if(alive)setSources(sources);}
     if(!current.output.active&&current.layout&&current.session.package.set.layouts.some(l=>l.id===current.layout&&l.height>l.width)&&alive){
      const projection=setOutputProjection(current.session,0,current.layout),visible=new Set<string>();if(projection.timeline)projection.timeline={...projection.timeline,clock:{...projection.timeline.clock,running:false}};const visit=(n:typeof projection.root)=>{if(n.slotId)visible.add(n.slotId);n.children.forEach(visit);};visit(projection.root);
      const bindings=Object.fromEntries(Object.entries(current.output.bindings).filter(([slot,id])=>visible.has(slot)&&current.output.sources.items?.some(s=>s.id===id&&s.has_frame&&s.visible)));
      const key=JSON.stringify({projection:media.current.signature(projection),bindings});
      if(key!==warmed.current){const status=await ipc.liveSetStatus();checkGeneration(status.generation);warmed.current=key;projection.revision=++revision.current;const preload=nextSetProjection(current.session,current.layout,current.output.framing);if(preload)preload.revision=projection.revision;
       await ipc.livePortraitWarm({assetIds:Object.keys(current.session.package.set.assets??{}),generation:status.generation,lease:lease.current,projection:media.current.compact(projection),preload:preload?media.current.compact(preload):undefined,bindings});media.current.acknowledge(projection);if(preload)media.current.acknowledge(preload);
      }
     }
    }else{
     const projection=setOutputProjection(current.session,0,current.layout!);
     const visible=new Set<string>();const visit=(n:typeof projection.root)=>{if(n.slotId){visible.add(n.slotId);if(current.output.framing[n.slotId])n.framing=current.output.framing[n.slotId];}n.children.forEach(visit);};visit(projection.root);
     const bindings=Object.fromEntries(Object.entries(current.output.bindings).filter(([slot])=>visible.has(slot)));
     const next=JSON.stringify({projection:media.current.signature(projection),bindings});
     if(next!==fingerprint.current){setBusy(true);const status=await ipc.liveSetStatus();checkGeneration(status.generation);projection.revision=++revision.current;const preload=nextSetProjection(current.session,current.layout,current.output.framing);if(preload)preload.revision=projection.revision;await ipc.livePortraitApply({assetIds:Object.keys(current.session.package.set.assets??{}),generation:status.generation,lease:lease.current,projection:media.current.compact(projection),preload:preload?media.current.compact(preload):undefined,bindings});media.current.acknowledge(projection);if(preload)media.current.acknowledge(preload);if(alive){fingerprint.current=next;setSources(undefined);}}
    }
    if(alive)setError('');
   }catch(e){media.current.clear();warmed.current='';if(alive){setError(String(e));fingerprint.current='';}}finally{flight.current=false;if(alive)setBusy(false);if(pending.current){pending.current=false;queueMicrotask(()=>wake.current());}}
  };
  wake.current=()=>{void update();};void update();const timer=setInterval(()=>void update(),1000);return()=>{alive=false;wake.current=()=>{};clearInterval(timer);};
 },[active,authored]);
 useEffect(()=>{wake.current();},[state,output.bindings,output.framing,effectiveLayout]);
 useEffect(()=>{if(!authored){media.current.clear();warmed.current='';fingerprint.current='';}},[authored]);
 const choose=async(next:OutputView)=>{try{await ipc.liveSelectOutput(next==='portrait');sharedProgramCapture.setPortrait(next==='portrait');onViewChange?.(next);setActive(next!=='landscape');setError('');}catch(e){setError(String(e));}};
 return <>
  <button className="stg-btn" title="Output settings" aria-label="Output settings" aria-haspopup="dialog" onClick={e=>{if(!pop.current)return;const a=e.currentTarget.getBoundingClientRect();pop.current.style.left=`${Math.max(8,Math.min(innerWidth-348,a.left-140))}px`;pop.current.style.top=`${Math.max(8,Math.min(innerHeight-380,a.top-340))}px`;pop.current.togglePopover();}}>{icon}</button>
  <section ref={pop} popover="auto" role="dialog" aria-label="Output settings" className="rm-output-settings">
   <header><strong>Output settings</strong><button aria-label="Close output settings" onClick={()=>pop.current?.hidePopover()}>×</button></header>
   {<>
    <div className="rm-output-views" role="group" aria-label="Room output view">{(['landscape','portrait','both'] as const).map(mode=><button key={mode} aria-pressed={view===mode} onClick={()=>choose(mode)}>{mode==='landscape'?'Landscape':mode==='portrait'?'Portrait':'Both'}</button>)}</div>
    {output.active&&portraits.length>0&&<label>Portrait composition<select aria-label="Portrait layout" value={layout} onChange={e=>setLayout(e.target.value)}><option value="auto">Follow set / segment</option><option value="room">Room canvas</option>{portraits.map(l=><option key={l.id} value={l.id}>{l.label}</option>)}</select></label>}
    <p className="rm-output-settings-note">{authored?(layout==='auto'?'Portrait follows the matching set / segment layout.':'Portrait uses the selected set layout.'):'Portrait uses room sources. Drag, resize, crop and arrange them directly on its canvas.'}</p>
    {active&&!authored&&sources?.items?.length?<details className="rm-portrait-sources"><summary>Portrait sources</summary>{sources.items.map(source=><button key={source.id} aria-pressed={source.visible} aria-label={`${source.visible?'Hide':'Show'} ${sourceNames[source.id]??source.label} on portrait`} onClick={()=>void ipc.livePortraitTransform(source.id,{visible:!source.visible}).then(setSources).catch(e=>setError(String(e)))}><span>{sourceNames[source.id]??source.label}</span><span>{source.visible?'Shown':'Hidden'}</span></button>)}</details>:null}
    {busy&&<p role="status">Preparing portrait…</p>}{error&&<p role="alert">{error}</p>}
    <p className="rm-output-settings-note">Both records separate landscape and portrait files. Portrait sends the vertical canvas to streams and guests. Both sends landscape and records both canvases.</p>
   </>}
  </section>
 </>;
}
