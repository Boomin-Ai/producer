import {useEffect,useId,useMemo,useRef,useState,type Dispatch,type SetStateAction} from 'react';
import {createPortal} from 'react-dom';
import type {PresentationPackage} from './schema';
import {arrangementCatalog,createArrangementPreferences,reconcileArrangementPreferences,resolveArrangement} from './controlArrangements';

type Preferences=ReturnType<typeof createArrangementPreferences>;
const changed='producer:control-arrangement-changed';
function read(key:string):unknown {try{return JSON.parse(localStorage.getItem(key)??'null');}catch{return null;}}
/** Personal to this browser/device; never writes shared package or room authority. */
export function useControlArrangement(doc:PresentationPackage,scope:string){
 const catalog=useMemo(()=>arrangementCatalog(doc),[doc]);
 const key=JSON.stringify(['producer.control-arrangement',1,scope,doc.id]);
 const [saved,setSaved]=useState<{key:string;value:unknown}>(()=>({key,value:read(key)}));
 const [error,setError]=useState('');
 useEffect(()=>{const refresh=()=>setSaved({key,value:read(key)});refresh();window.addEventListener('storage',refresh);window.addEventListener(changed,refresh);return()=>{window.removeEventListener('storage',refresh);window.removeEventListener(changed,refresh);};},[key]);
 const preferences=reconcileArrangementPreferences(catalog,saved.key===key?saved.value:read(key));
 const update:Dispatch<SetStateAction<Preferences>>=next=>{
  const value=reconcileArrangementPreferences(catalog,typeof next==='function'?next(preferences):next);
  setSaved({key,value});
  try{localStorage.setItem(key,JSON.stringify(value));setError('');window.dispatchEvent(new Event(changed));}
  catch{setError('Arrangement works for this session, but could not be saved on this device.');}
 };
 return {catalog,preferences,arrangement:resolveArrangement(catalog,preferences),update,error,reset:()=>update(createArrangementPreferences(catalog))};
}
export type ControlArrangementState=ReturnType<typeof useControlArrangement>;
function move(ids:string[],id:string,delta:number){const next=[...ids],index=next.indexOf(id),target=index+delta;if(index<0||target<0||target>=next.length)return next;[next[index],next[target]]=[next[target],next[index]];return next;}

export function ControlArrangementEditor({value}:{value:ControlArrangementState}){
 const {catalog,preferences,arrangement,update,error,reset}=value;
 const id=useId(),trigger=useRef<HTMLButtonElement>(null);
 const [position,setPosition]=useState({left:12,top:12});
 const label=(ref:string)=>catalog.controls.find(c=>c.id===ref)?.label??ref;
 const orderButtons=(ids:string[],ref:string,surface:string,onMove:(ids:string[])=>void)=><span className="set-arrangement-move"><button type="button" aria-label={`Move ${label(ref)} earlier in ${surface}`} disabled={ids.indexOf(ref)===0} onClick={()=>onMove(move(ids,ref,-1))}>↑</button><button type="button" aria-label={`Move ${label(ref)} later in ${surface}`} disabled={ids.indexOf(ref)===ids.length-1} onClick={()=>onMove(move(ids,ref,1))}>↓</button></span>;
 return <><button type="button" ref={trigger} popoverTarget={id} aria-label="Arrange controls" className="set-arrangement-trigger" onClick={()=>{const rect=trigger.current!.getBoundingClientRect();setPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-452)),top:Math.max(12,Math.min(rect.top,window.innerHeight-560))});}}>Arrange</button>
 {createPortal(<div id={id} popover="auto" role="dialog" aria-label="Arrange set controls" className="set-controls set-arrangement-editor" style={position}>
  <header><strong>Arrange controls</strong><button type="button" popoverTarget={id} popoverTargetAction="hide" aria-label="Close control arrangements">×</button></header>
  <p>Personal to this device and room. Your Set and other operators stay unchanged.</p>
  <h3>Minimized bar</h3><p>Choose the controls you want within reach. Only selected controls appear.</p>
  <div className="set-arrangement-choices">{catalog.controls.map(c=><label key={c.id}><input type="checkbox" aria-label={`Show ${c.label} in minimized bar`} checked={arrangement.minimized.includes(c.id)} onChange={e=>update({...preferences,minimized:{...preferences.minimized,[c.id]:e.target.checked}})}/><span>{c.label}</span></label>)}</div>
  {arrangement.minimized.length?<ol aria-label="Minimized control order">{arrangement.minimized.map(ref=><li key={ref}><span>{label(ref)}</span>{orderButtons(arrangement.minimized,ref,'minimized bar',ids=>update({...preferences,minimizedOrder:ids}))}</li>)}</ol>:<p>No controls selected.</p>}
  <h3>Expanded panel</h3><p>Order sections and their controls independently of the minimized bar.</p>
  <ol aria-label="Expanded section order">{arrangement.sections.map((section,index)=><li className="set-arrangement-section-editor" key={section.id}>
   <div><strong>{section.label}</strong><span className="set-arrangement-move"><button type="button" aria-label={`Move ${section.label} section earlier`} disabled={index===0} onClick={()=>update({...preferences,sectionOrder:move(arrangement.sections.map(s=>s.id),section.id,-1)})}>↑</button><button type="button" aria-label={`Move ${section.label} section later`} disabled={index===arrangement.sections.length-1} onClick={()=>update({...preferences,sectionOrder:move(arrangement.sections.map(s=>s.id),section.id,1)})}>↓</button></span></div>
   <label><input type="checkbox" aria-label={`Collapse ${section.label}`} checked={section.collapsed} onChange={e=>update({...preferences,collapsed:{...preferences.collapsed,[section.id]:e.target.checked}})}/>Collapse section</label>
   <ol>{section.controls.map(ref=><li key={ref}><span>{label(ref)}</span>{orderButtons(section.controls,ref,'expanded panel',ids=>update({...preferences,controlOrder:{...preferences.controlOrder,[section.id]:ids}}))}</li>)}</ol>
  </li>)}</ol>
  {error&&<p role="alert">{error}</p>}<button type="button" onClick={reset}>Reset to Set defaults</button>
 </div>,document.body)}</>;
}
