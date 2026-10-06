import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ipc } from '../../lib/ipc';
import type { LiveSources } from '../../lib/ipc';
import { outputProjection, type OutputProjection } from './projection';
import { RehearsalSession } from './rehearsal';

export interface SetOutputStatus { generation:number; lease:string|null; revision:number }
export interface SetOutputControls {
  framing:Record<string,import('./schema').SlotFraming>; frame:(slot:string,value:import('./schema').SlotFraming)=>void;
  active:boolean; busy:boolean; error:string; bindings:Record<string,string>; sources:LiveSources;
  bind:(slot:string,source:string)=>void; apply:()=>Promise<void>; returnToRoom:()=>Promise<boolean>;
}
export function setOutputProjection(session:RehearsalSession, revision:number):OutputProjection {
  if (session.snapshot().workspaceMode!=='prepare') throw new Error('Exit rehearsal before applying a set.');
  const projection=outputProjection(session.package,session.snapshot());
  projection.revision=revision;
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
export function useSetOutput(session:RehearsalSession,roomId:string|null,sources:LiveSources,enabled:boolean,
  initialBindings:Record<string,string>={},onBindings?:(bindings:Record<string,string>)=>void,initialFraming:Record<string,import('./schema').SlotFraming>={},onFraming?:(framing:Record<string,import('./schema').SlotFraming>)=>void):SetOutputControls {
  const state=useSyncExternalStore(session.subscribe,session.snapshot);
  const [bindings,setBindings]=useState(initialBindings);
  const [framing,setFraming]=useState(initialFraming);
  const [active,setActive]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const owner=useRef<string|null>(null),generation=useRef(0),revision=useRef(0),operation=useRef(0),inFlight=useRef(false);
  const latest=useRef({session,bindings,framing,sources,enabled,roomId});latest.current={session,bindings,framing,sources,enabled,roomId};
  const acknowledged=useRef('');
  const project=(current:typeof latest.current,rev:number)=>{const p=setOutputProjection(current.session,rev);const visit=(n:OutputProjection['root'])=>{if(n.slotId && current.framing[n.slotId])n.framing=current.framing[n.slotId];n.children.forEach(visit);};visit(p.root);return p;};
  const sourceDimensions=(current:typeof latest.current)=>Object.values(current.bindings).map(id=>{const item=current.sources.items?.find(s=>s.id===id);return [id,item?.src_w,item?.src_h];});
  const fingerprint=()=>JSON.stringify({projection:project(latest.current,0),bindings:latest.current.bindings,dimensions:sourceDimensions(latest.current)});
  const returnToRoom=async()=> {
    ++operation.current;
    const lease=owner.current;owner.current=null;acknowledged.current='';setActive(false);
    if (!lease)return true;
    try {const status=await ipc.liveSetReturn(lease);generation.current=status.generation;setError('');return true;}
    catch(e){owner.current=lease;setActive(true);setError(String(e));return false;}
  };
  const apply=async()=> {
    if (!latest.current.enabled || inFlight.current)return;
    const current=latest.current;
    if (current.session.snapshot().workspaceMode!=='prepare'){setError('Exit rehearsal before applying the set.');return;}
    const ticket=++operation.current;inFlight.current=true;setBusy(true);setError('');
    let lease=owner.current;
    try {
      const status=await ipc.liveSetStatus();
      if(ticket!==operation.current)return;
      if(status.lease && status.lease!==lease)throw new Error('Another set owns the output. Return to room before replacing it.');
      generation.current=status.generation;
      lease ??= crypto.randomUUID();owner.current=lease;
      const projection=project(current,++revision.current);
      const declared=new Set<string>();const visit=(n:OutputProjection['root'])=>{if(n.slotId)declared.add(n.slotId);n.children.forEach(visit);};visit(projection.root);
      const resolved=Object.fromEntries(Object.entries(current.bindings).filter(([slot])=>declared.has(slot)));
      const signature=JSON.stringify({projection:{...projection,revision:0},bindings:current.bindings,dimensions:sourceDimensions(current)});
      await ipc.liveSetApply({generation:status.generation,lease,projection,bindings:resolved});
      if(ticket!==operation.current || latest.current.roomId!==current.roomId){await ipc.liveSetReturn(lease);return;}
      acknowledged.current=signature;setActive(true);
    } catch(e) {
      if(ticket===operation.current) {
        setError(String(e));
        const status=await ipc.liveSetStatus().catch(()=>null);
        if(status?.lease!==owner.current){owner.current=null;setActive(false);}
      }
    } finally {inFlight.current=false;setBusy(false);}
  };
  useEffect(()=> {
    owner.current=null;acknowledged.current='';setActive(false);setBindings(initialBindings);setFraming(initialFraming);setError('');
    return ()=> {++operation.current;const lease=owner.current;owner.current=null;if(lease)void ipc.liveSetReturn(lease).catch(()=>{});};
  },[roomId]);
  useEffect(()=> {setError('');},[state.layoutId,state.values,state.feeds,bindings,framing]);
  useEffect(()=> {
    if(!active || state.workspaceMode!=='prepare' || busy || error)return;
    const timer=setTimeout(()=> {try {if(fingerprint()!==acknowledged.current)void apply();}catch(e){setError(String(e));}},450);
    return()=>clearTimeout(timer);
  },[active,state,bindings,framing,busy,error,JSON.stringify(sourceDimensions(latest.current))]);
  useEffect(()=> {
    if(!enabled)return;
    let stopped=false;
    const timer=setInterval(()=> {if(inFlight.current)return;void ipc.liveSetStatus().then(status=>{if(stopped)return;if(status.lease && !owner.current){owner.current=status.lease;revision.current=Math.max(revision.current,status.revision);setActive(true);}else if(status.lease!==owner.current){owner.current=null;setActive(false);}}).catch(()=>{});},1000);
    return()=>{stopped=true;clearInterval(timer);};
  },[enabled]);
  return {framing,frame:(slot,value)=>{const next={...framing,[slot]:value};setFraming(next);onFraming?.(next);},active,busy,error,bindings,sources,apply,returnToRoom,bind:(slot,source)=>{
    const next={...bindings};if(source)next[slot]=source;else delete next[slot];setBindings(next);onBindings?.(next);
  }};
}
