import {useEffect,useId,useLayoutEffect,useRef,useState,type CSSProperties} from 'react';
import '../../components/ControlSlider.css';
import './NumberSlider.css';

type Props={
  owner:object;label:string;value:number;min:number;max:number;step?:number;
  unit?:string;defaultValue?:number;disabled?:boolean;pending?:boolean;isPending?:()=>boolean;onCommit:(value:number)=>boolean|void|Promise<unknown>;
};
const releaseKeys=new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown']);

/** Dragging is private. Only a release queues a final value for this owner. */
export function NumberSlider({owner,label,value,min,max,step,unit,defaultValue,disabled=false,pending=false,isPending,onCommit}:Props){
  const id=useId(),[draft,setDraft]=useState(value),[error,setError]=useState('');
  const live=useRef({owner,value,min,max,disabled,pending,isPending,onCommit});
  const active=useRef(false),generation=useRef(0),draftValue=useRef(value),previousValue=useRef(value);
  const edits=useRef(0),released=useRef(0);
  const pointerActive=useRef(false),keyboardActive=useRef(false);
  const queued=useRef<{value:number;generation:number}|undefined>(undefined);
  const flight=useRef<object|undefined>(undefined);
  useLayoutEffect(()=>{live.current={owner,value,min,max,disabled,pending,isPending,onCommit};});
  useLayoutEffect(()=>{
    active.current=true;++generation.current;queued.current=undefined;flight.current=undefined;
    pointerActive.current=false;keyboardActive.current=false;
    edits.current=0;released.current=0;draftValue.current=value;previousValue.current=value;setDraft(value);setError('');
    return()=>{active.current=false;++generation.current;queued.current=undefined;flight.current=undefined;};
  },[owner,disabled]);
  useLayoutEffect(()=>{
    const previous=previousValue.current;previousValue.current=value;
    if(draftValue.current===previous){draftValue.current=value;setDraft(value);}
  },[value]);

  const flush=async()=>{
    const next=queued.current,current=live.current;
    if(!next||!active.current||current.disabled||current.pending||current.isPending?.()||flight.current)return;
    queued.current=undefined;
    if(next.generation!==generation.current||next.value===current.value)return;
    if(!Number.isFinite(next.value)||next.value<current.min||next.value>current.max)return;
    const token={},epoch=generation.current,requestedOwner=current.owner;
    flight.current=token;setError('');
    const valid=()=>active.current&&generation.current===epoch&&live.current.owner===requestedOwner&&!live.current.disabled;
    try{
      if(await current.onCommit(next.value)===false)throw Error('The room did not accept this edit.');
    }catch(reason){
      if(valid())setError(reason instanceof Error?reason.message:'The value could not be updated.');
    }finally{
      if(valid()&&flight.current===token){flight.current=undefined;void flush();}
    }
  };
  useEffect(()=>{if(!pending&&!disabled)void flush();},[pending,disabled,owner,value,isPending]);
  const release=()=>{
    const current=live.current;
    if(!active.current||current.owner!==owner||current.disabled||released.current===edits.current)return;
    released.current=edits.current;queued.current={value:draftValue.current,generation:generation.current};void flush();
  };
  return <div className="set-number-slider" aria-busy={pending}>
    <label htmlFor={id}>{label}</label><span className="set-slider-readout"><output htmlFor={id}>{Number(draft.toFixed(3))}{unit&&<small>{unit}</small>}</output>{defaultValue!==undefined&&<button type="button" className="set-slider-reset" aria-label={`Reset ${label}`} title={`Reset to ${defaultValue}${unit??''}`} disabled={disabled||draft===defaultValue} onClick={()=>{draftValue.current=defaultValue;setDraft(defaultValue);++edits.current;release();}}>↺</button>}</span>
    <input id={id} className="producer-range" style={{'--slider-fill':`${100*(draft-min)/(max-min||1)}%`} as CSSProperties} aria-label={label} aria-valuetext={`${draft}${unit??''}`} type="range" min={min} max={max} step={step??Math.min(.01,max-min)} disabled={disabled} value={draft}
      onChange={event=>{const next=event.currentTarget.valueAsNumber;if(Number.isFinite(next)&&next>=min&&next<=max){++edits.current;draftValue.current=next;setDraft(next);if(!pointerActive.current&&!keyboardActive.current)release();}}}
      onPointerDown={event=>{pointerActive.current=true;try{event.currentTarget.setPointerCapture(event.pointerId);}catch{/* A synthetic event may have no active pointer. */}}}
      onPointerUp={()=>{pointerActive.current=false;release();}}
      onPointerCancel={()=>{pointerActive.current=false;keyboardActive.current=false;queued.current=undefined;released.current=edits.current;draftValue.current=live.current.value;setDraft(live.current.value);}}
      onKeyDown={event=>{if(releaseKeys.has(event.key))keyboardActive.current=true;}}
      onKeyUp={event=>{if(releaseKeys.has(event.key)){keyboardActive.current=false;release();}}}
      onBlur={()=>{pointerActive.current=false;keyboardActive.current=false;release();}}/>
    {error&&<p role="alert">{error}</p>}
  </div>;
}
