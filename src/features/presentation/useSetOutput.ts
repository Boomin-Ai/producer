import {AssetTransport} from './assetTransport';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ipc } from '../../lib/ipc';
import type { LiveSources } from '../../lib/ipc';
import { outputProjection, type OutputProjection } from './projection';
import { RehearsalSession } from './rehearsal';
import {enterMedia,mediaPosition} from './playback';

export interface SetOutputStatus { generation:number; lease:string|null; revision:number }
export function resolveRoomBindings(bindings:Record<string,string>,sources:LiveSources):Record<string,string>{
  const cameras=(sources.items??[]).filter(item=>item.kind==='camera'&&item.visible&&item.has_frame);
  const next={...bindings};
  for(const [slot,id] of Object.entries(bindings)){
    const old=sources.items?.find(item=>item.id===id);
    if((old?.kind==='camera'||id==='camera')&&(!old?.visible||!old.has_frame)&&cameras.length===1)next[slot]=cameras[0].id;
  }
  return next;
}
export interface SetOutputControls {
  framing:Record<string,import('./schema').SlotFraming>; frame:(slot:string,value:import('./schema').SlotFraming)=>void;
  active:boolean; busy:boolean; error:string; bindings:Record<string,string>; sources:LiveSources;
  bind:(slot:string,source:string)=>void; apply:()=>Promise<void>; returnToRoom:()=>Promise<boolean>;
}
export function setOutputProjection(session:RehearsalSession, revision:number,layoutId?:string):OutputProjection {
  const projection=outputProjection(session.package,{...session.snapshot(),...(layoutId?{layoutId}:{})});
  // Prime the bounded native asset cache once, before any segment needs it.
  // Browser delivery still includes only assets used by the current layout.
  projection.assets=Object.fromEntries(Object.entries(session.package.set.assets??{}).map(([id,{name,mime,data}])=>[id,{name,mime,data}]));
  projection.revision=revision;
  return normalizeSlotAppearance(projection);
}
function normalizeSlotAppearance(projection:OutputProjection):OutputProjection{
  const visit=(node:OutputProjection['root'])=> {
    if (node.type==='slot' && !node.appearance) {
      const radius=node.styles.borderRadius;
      const parsed=typeof radius==='number'?radius:typeof radius==='string' && /^\d+(\.\d+)?px$/.test(radius)?parseFloat(radius):0;
      if (parsed) node.appearance={shape:'rectangle',cornerRadius:parsed,outlineWidth:0,outlineColor:'#ffffff',grayscale:0,opacity:1};
    }
    node.children.forEach(visit);
  };
  visit(projection.root);return projection;
}
export function nextSetProjection(session:RehearsalSession,layoutId?:string,framing:Record<string,import('./schema').SlotFraming>={}):OutputProjection|undefined{
 const state=session.snapshot(),doc=session.package,phase=doc.show?.phases.find(p=>p.id===(state.running?state.show.phase:doc.show?.initialPhase));
 const next=doc.show?.phases.find(p=>p.id===phase?.next);if(!next)return;
 const portrait=doc.set.layouts.find(l=>l.id===(layoutId??state.layoutId));
 const id=portrait&&portrait.height>portrait.width?next.layoutId.replace(/-landscape$/,'-portrait'):next.layoutId;
 const target=doc.set.layouts.find(l=>l.id===id);if(!target||target.width!==portrait?.width||target.height!==portrait?.height)return;
 const predicted=structuredClone(state);delete predicted.layoutMotion;delete predicted.layoutMotionId;predicted.layoutId=next.layoutId;predicted.show.phase=next.id;predicted.running=true;predicted.paused=false;
 if(predicted.animationClock)predicted.animationClock={...predicted.animationClock,running:false,segmentMs:0,anchorMs:Date.now()};
 predicted.show.remainingMs=next.collectMs??0;predicted.show.collecting=!!next.collectMs;
 if(next.collectMs){predicted.show.total=0;predicted.show.revealed=false;predicted.show.winner='';predicted.show.result='';predicted.show.ballot=1;Object.keys(predicted.counts).forEach(k=>predicted.counts[k]=0);}
 predicted.media??={};enterMedia(doc,state.layoutId,next.layoutId,predicted.media,Date.now(),state,predicted);
 const projection=outputProjection(doc,{...predicted,layoutId:id});
 // Decode the intended entry frame without running next-segment media early.
 const pause=(n:OutputProjection['root'])=>{if(n.slotId&&framing[n.slotId])n.framing=framing[n.slotId];if(n.playback)n.playback={playing:false,positionMs:mediaPosition(n.playback),anchorMs:Date.now()};if(n.type==='media')n.autoplay=false;n.children.forEach(pause);};pause(projection.root);
 return normalizeSlotAppearance(projection);
}
export function useSetOutput(session:RehearsalSession,roomId:string|null,sources:LiveSources,enabled:boolean,
  initialBindings:Record<string,string>={},onBindings?:(bindings:Record<string,string>)=>void,initialFraming:Record<string,import('./schema').SlotFraming>={},onFraming?:(framing:Record<string,import('./schema').SlotFraming>)=>void):SetOutputControls {
  const state=useSyncExternalStore(session.subscribe,session.snapshot);
  const [bindings,setBindings]=useState(initialBindings);
  const [framing,setFraming]=useState(initialFraming);
  const [active,setActive]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const owner=useRef<string|null>(null),generation=useRef(0),revision=useRef(0),operation=useRef(0),inFlight=useRef(false);
  const latest=useRef({session,bindings,framing,sources,enabled,roomId});latest.current={session,bindings,framing,sources,enabled,roomId};
  const warmFlight=useRef<Promise<void>|null>(null),warmLease=useRef<string|null>(null),warmed=useRef('');const [warmVersion,setWarmVersion]=useState(0);
  const acknowledged=useRef('');const media=useRef(new AssetTransport());
  const project=(current:typeof latest.current,rev:number)=>{const p=setOutputProjection(current.session,rev);const visit=(n:OutputProjection['root'])=>{if(n.slotId && current.framing[n.slotId])n.framing=current.framing[n.slotId];n.children.forEach(visit);};visit(p.root);return p;};
  const sourceDimensions=(current:typeof latest.current)=>Object.values(current.bindings).map(id=>{const item=current.sources.items?.find(s=>s.id===id);return [id,item?.src_w,item?.src_h];});
  const fingerprint=()=>JSON.stringify({projection:media.current.signature(project(latest.current,0)),bindings:latest.current.bindings,dimensions:sourceDimensions(latest.current)});
  const returnToRoom=async()=> {
    ++operation.current;
    const lease=owner.current;owner.current=null;acknowledged.current='';media.current.clear();setActive(false);
    if (!lease)return true;
    try {const status=await ipc.liveSetReturn(lease);generation.current=status.generation;setError('');return true;}
    catch(e){owner.current=lease;setActive(true);setError(String(e));return false;}
  };
  const apply=async()=> {
    if (!latest.current.enabled || inFlight.current)return;
    const ticket=++operation.current;inFlight.current=true;setBusy(true);setError('');
    let lease=owner.current;
    try {
      if(warmFlight.current)await warmFlight.current;
      const current={...latest.current,bindings:resolveRoomBindings(latest.current.bindings,latest.current.sources)};lease??=warmLease.current;
      const status=await ipc.liveSetStatus();
      if(ticket!==operation.current)return;
      if(status.generation!==generation.current){media.current.clear();warmed.current='';}
      if(status.lease && status.lease!==lease)throw new Error('Another set owns the output. Choose Show room scene before replacing it.');
      generation.current=status.generation;
      lease ??= crypto.randomUUID();owner.current=lease;warmLease.current=null;
      const projection=project(current,++revision.current);const preload=nextSetProjection(current.session,undefined,current.framing);if(preload)preload.revision=projection.revision;
      const declared=new Set<string>();const visit=(n:OutputProjection['root'])=>{if(n.slotId)declared.add(n.slotId);n.children.forEach(visit);};visit(projection.root);
      const resolved=Object.fromEntries(Object.entries(current.bindings).filter(([slot])=>declared.has(slot)));
      const signature=JSON.stringify({projection:media.current.signature(projection),bindings:current.bindings,dimensions:sourceDimensions(current)});
      const send=()=>ipc.liveSetApply({assetIds:Object.keys(current.session.package.set.assets??{}),generation:status.generation,lease:lease!,projection:media.current.compact(projection),preload:preload?media.current.compact(preload):undefined,bindings:resolved});
      try{await send();}catch(e){
        if(!String(e).includes('Missing media asset'))throw e;
        // A cancelled native preparation may have discarded its cache without
        // changing the room generation. Refill it once with complete assets.
        media.current.clear();await send();
      }
      if(ticket!==operation.current || latest.current.roomId!==current.roomId){await ipc.liveSetReturn(lease);return;}
      media.current.acknowledge(projection);if(preload)media.current.acknowledge(preload);acknowledged.current=signature;setActive(true);
    } catch(e) {
      if(ticket===operation.current) {
        setError(String(e));
        media.current.clear();warmed.current='';
        const status=await ipc.liveSetStatus().catch(()=>null);
        if(status?.lease!==owner.current){owner.current=null;setActive(false);}
      }
    } finally {inFlight.current=false;setBusy(false);}
  };
  useEffect(()=> {
    owner.current=null;warmLease.current=null;warmed.current='';acknowledged.current='';media.current.clear();setActive(false);setBindings(initialBindings);setFraming(initialFraming);setError('');
    return ()=> {++operation.current;const lease=owner.current??warmLease.current;owner.current=null;warmLease.current=null;warmed.current='';if(lease)void ipc.liveSetReturn(lease).catch(()=>{});};
  },[roomId]);
  useEffect(()=>{media.current.clear();warmed.current='';},[session.package.id]);
  useEffect(()=>{
    const next=resolveRoomBindings(bindings,sources);
    if(JSON.stringify(next)!==JSON.stringify(bindings)){setBindings(next);onBindings?.(next);}
  },[bindings,sources]);
  useEffect(()=> {setError('');},[state.layoutId,state.values,state.feeds,bindings,framing]);
  useEffect(()=> {
    if(!active || busy || error)return;
    const timer=setTimeout(()=> {try {if(fingerprint()!==acknowledged.current)void apply();}catch(e){setError(String(e));}},0);
    return()=>clearTimeout(timer);
  },[active,state,bindings,framing,busy,error,JSON.stringify(sourceDimensions(latest.current))]);
  useEffect(()=>{
    if(active||busy||!enabled||inFlight.current||warmFlight.current)return;
    const timer=setTimeout(()=>{
      const work=async()=>{
        const current=latest.current;const projection=project(current,0),key=JSON.stringify({projection:media.current.signature(projection),bindings:current.bindings});if(key===warmed.current)return;
        if(projection.timeline)projection.timeline={...projection.timeline,clock:{...projection.timeline.clock,running:false}};
        const status=await ipc.liveSetStatus();if(status.lease||inFlight.current)return;
        if(status.generation!==generation.current){media.current.clear();warmed.current='';}
        const lease=warmLease.current??crypto.randomUUID();warmLease.current=lease;generation.current=status.generation;projection.revision=++revision.current;
        const preload=nextSetProjection(current.session,undefined,current.framing);if(preload)preload.revision=projection.revision;
        const visible=new Set<string>();const visit=(n:OutputProjection['root'])=>{if(n.slotId)visible.add(n.slotId);n.children.forEach(visit);};visit(projection.root);
        const resolved=Object.fromEntries(Object.entries(current.bindings).filter(([slot,id])=>visible.has(slot)&&current.sources.items?.some(s=>s.id===id&&s.has_frame&&s.visible)));
        await ipc.liveSetWarm({assetIds:Object.keys(current.session.package.set.assets??{}),generation:status.generation,lease,projection:media.current.compact(projection),preload:preload?media.current.compact(preload):undefined,bindings:resolved});
        if(latest.current.roomId!==current.roomId||warmLease.current!==lease)return;
        media.current.acknowledge(projection);if(preload)media.current.acknowledge(preload);warmed.current=key;
      };
      warmFlight.current=work().catch(()=>{try{warmed.current=JSON.stringify({projection:media.current.signature(project(latest.current,0)),bindings:latest.current.bindings});}catch{}}).finally(()=>{warmFlight.current=null;setWarmVersion(v=>v+1);});
    },100);
    return()=>clearTimeout(timer);
  },[active,busy,enabled,state.layoutId,state.values,state.feeds,session.package,bindings,framing,warmVersion]);
  useEffect(()=> {
    if(!enabled)return;
    let stopped=false;
    const timer=setInterval(()=> {if(inFlight.current)return;void ipc.liveSetStatus().then(status=>{if(stopped)return;if(generation.current!==status.generation){media.current.clear();warmed.current='';}generation.current=status.generation;if(status.lease && !owner.current){media.current.clear();owner.current=status.lease;revision.current=Math.max(revision.current,status.revision);setActive(true);}else if(status.lease!==owner.current){owner.current=null;setActive(false);}}).catch(()=>{});},1000);
    return()=>{stopped=true;clearInterval(timer);};
  },[enabled]);
  return {framing,frame:(slot,value)=>{const next={...framing,[slot]:value};setFraming(next);onFraming?.(next);},active,busy,error,bindings,sources,apply,returnToRoom,bind:(slot,source)=>{
    const next={...bindings};if(source)next[slot]=source;else delete next[slot];setBindings(next);onBindings?.(next);
  }};
}
