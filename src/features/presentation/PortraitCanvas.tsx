import {useEffect,useRef,useState} from 'react';
import {ipc,type LiveSources,type LiveTransformPatch} from '../../lib/ipc';
import {previewSession,setPreviewTransparency} from '../../lib/previewSession';
import {StageEditor} from '../../views/StageEditor';
import type {PortraitMonitor} from './OutputSettings';
export function PortraitCanvas({monitor,onSources,selected,onSelect,canvasWidth=720}:{canvasWidth?:number;monitor:PortraitMonitor;onSources:(sources:LiveSources)=>void;selected:string|null;onSelect:(id:string|null)=>void}){
 const ref=useRef<HTMLDivElement>(null);const [error,setError]=useState('');
 useEffect(()=>{
  const session=previewSession({attach:async r=>ipc.livePortraitPreview({x:r.x,y:r.y,w:r.width,h:r.height}),move:r=>ipc.livePortraitPreview({x:r.x,y:r.y,w:r.width,h:r.height}),detach:()=>ipc.livePortraitPreview(null)},transparent=>setPreviewTransparency('portrait',transparent));
  const measure=()=>{const r=ref.current?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:undefined;};
  const sync=()=>void session.sync(measure,true);const ro=new ResizeObserver(sync);if(ref.current)ro.observe(ref.current);window.addEventListener('resize',sync);window.addEventListener('scroll',sync,true);const timer=setInterval(sync,250);sync();
  return()=>{ro.disconnect();clearInterval(timer);window.removeEventListener('resize',sync);window.removeEventListener('scroll',sync,true);void session.close();};
 },[]);
 const patch=(id:string,patch:LiveTransformPatch)=>{void ipc.livePortraitTransform(id,patch).then(sources=>{setError('');onSources(sources);}).catch(e=>setError(String(e)));};
 return <div ref={ref} className="rm-portrait-native" aria-label="Native portrait canvas">
  {monitor.editing&&<StageEditor nativeTransforms={false} items={monitor.sources?.items??[]} baseW={canvasWidth} baseH={Math.round(canvasWidth*16/9)} disabled={false} selectId={selected} onSelect={onSelect} onLive={patch} onCommit={patch} onOrder={(id,dir)=>{const item=monitor.sources?.items?.find(s=>s.id===id);if(item)patch(id,{z:Math.max(0,item.z+dir)});}} onDelete={id=>patch(id,{visible:false})}/>}
  {error&&<div className="rm-portrait-error" role="alert">{error}</div>}
 </div>;
}

