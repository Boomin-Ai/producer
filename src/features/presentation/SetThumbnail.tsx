import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {outputProjection,type OutputProjection,type RenderNode} from './projection';
import {RehearsalSession} from './rehearsal';
import type {PresentationPackage} from './schema';

/** Lightweight opening-layout still: no source leases, media playback or animation clocks. */
export function SetThumbnail({load}:{load:()=>Promise<PresentationPackage>}) {
 const host=useRef<HTMLSpanElement>(null);
 const [visible,setVisible]=useState(false),[projection,setProjection]=useState<OutputProjection>();
 const [failed,setFailed]=useState(false);
 useEffect(()=>{const observer=new IntersectionObserver(entries=>setVisible(entries[0].isIntersecting));observer.observe(host.current!);return()=>observer.disconnect();},[]);
 useEffect(()=>{
  if(!visible)return;
  let cancelled=false;
  void load().then(doc=>{
   const session=new RehearsalSession(doc,undefined,'prepare');
   const next=outputProjection(session.package,session.snapshot());
   if(!cancelled){setProjection(next);setFailed(false);}
  }).catch(()=>{if(!cancelled)setFailed(true);});
  return()=>{cancelled=true;setProjection(undefined);};
 },[visible,load]);
 const render=(node:RenderNode):React.ReactNode=>{
  const style={...node.styles} as CSSProperties;
  if(node.type==='shader')Object.assign(style,{background:`linear-gradient(135deg,${node.shader!.colors.join(',')})`,opacity:node.shader!.opacity});
  if(node.type==='slot')Object.assign(style,{background:'#283242',border:style.border??'2px solid #627185'});
  const asset=node.assetId?projection?.assets?.[node.assetId]:undefined;
  return <div key={node.id} style={style}>{node.type==='text'?node.text:asset?.mime.startsWith('image/')&&asset.data.startsWith('data:')?<img src={asset.data} alt="" style={{width:'100%',height:'100%',objectFit:node.fit??'contain'}}/>:null}{node.children.map(render)}</div>;
 };
 const scale=projection?Math.min(88/projection.width,52/projection.height):1;
 return <span ref={host} className="set-choice-thumbnail" aria-hidden="true">
  {projection?<span className="set-choice-thumbnail-canvas" style={{width:projection.width,height:projection.height,left:(88-projection.width*scale)/2,top:(52-projection.height*scale)/2,transform:`scale(${scale})`}}>{render(projection.root)}</span>:<span className="set-choice-thumbnail-placeholder">{failed?'◇':'▧'}</span>}
 </span>;
}
