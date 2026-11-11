import {useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {AssistantSuggestion} from './suggestions';

export function AssistantSuggestions({items,disabled,onChoose}:{items:AssistantSuggestion[];disabled:(item:AssistantSuggestion)=>boolean;onChoose:(item:AssistantSuggestion)=>void}) {
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false),[position,setPosition]=useState<{left:number;top:number}>();
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{
      if(!trigger.current||!panel.current)return;
      const a=trigger.current.getBoundingClientRect(),b=panel.current.getBoundingClientRect(),pad=10;
      if(!a.width){panel.current.hidePopover();return;}
      setPosition({left:Math.max(pad,Math.min(a.left,innerWidth-b.width-pad)),top:Math.max(pad,Math.min(a.top-b.height-7,innerHeight-b.height-pad))});
    };
    place();const observer=new ResizeObserver(place);observer.observe(panel.current!);observer.observe(trigger.current!);
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  return <>
    <div className="assistant-suggestions" aria-label="Suggested actions">{items.map(item=><button type="button" key={item.id} disabled={disabled(item)} onClick={()=>onChoose(item)}>{item.label}</button>)}</div>
    <div className="assistant-suggestions-compact"><button ref={trigger} type="button" popoverTarget={id} aria-expanded={open} aria-label="Assistant suggestions" title="Suggested actions"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg>Ideas<span aria-hidden="true">⌃</span></button></div>
    {createPortal(<div ref={panel} popover="auto" id={id} role="group" aria-label="Assistant suggestions" className="assistant-suggestion-popover" style={{left:position?.left??0,top:position?.top??0,visibility:position?'visible':'hidden'}} onToggle={event=>{const opened=event.newState==='open';setOpen(opened);if(!opened)setPosition(undefined);}}>
      <span>Suggested next steps</span>{items.map(item=><button key={item.id} type="button" disabled={disabled(item)} onClick={()=>{panel.current?.hidePopover();onChoose(item);}}>{item.label}<span aria-hidden="true">↗</span></button>)}
    </div>,document.body)}
  </>;
}
