import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {AssistantSuggestion} from './suggestions';

export function AssistantSuggestions({items,disabled,onChoose}:{items:AssistantSuggestion[];disabled:(item:AssistantSuggestion)=>boolean;onChoose:(item:AssistantSuggestion)=>void}) {
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false),[position,setPosition]=useState<{left:number;top:number}>();
  const nativePopover=typeof HTMLElement.prototype.showPopover==='function'&&typeof HTMLElement.prototype.hidePopover==='function';
  const close=()=>{if(nativePopover)panel.current?.hidePopover();else{setOpen(false);setPosition(undefined);}};
  useEffect(()=>{
    if(!open||nativePopover)return;
    const outside=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))close();};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();trigger.current?.focus();}};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);};
  },[open,nativePopover]);
  useLayoutEffect(()=>{
    if(!open)return;
    const place=()=>{
      if(!trigger.current||!panel.current)return;
      const a=trigger.current.getBoundingClientRect(),b=panel.current.getBoundingClientRect(),pad=10;
      if(!a.width){close();return;}
      setPosition({left:Math.max(pad,Math.min(a.left,innerWidth-b.width-pad)),top:Math.max(pad,Math.min(a.top-b.height-7,innerHeight-b.height-pad))});
    };
    place();const observer=new ResizeObserver(place);observer.observe(panel.current!);observer.observe(trigger.current!);
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  return <>
    <div className="assistant-suggestions" aria-label="Suggested actions">{items.map(item=><button type="button" key={item.id} disabled={disabled(item)} onClick={()=>onChoose(item)}>{item.label}</button>)}</div>
    <div className="assistant-suggestions-compact"><button ref={trigger} type="button" popoverTarget={nativePopover?id:undefined} aria-expanded={open} aria-controls={id} aria-label="Assistant suggestions" title="Suggested actions" onClick={()=>{if(!nativePopover){setPosition(undefined);setOpen(value=>!value);}}}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg>Ideas<span aria-hidden="true">⌃</span></button></div>
    {createPortal(<div ref={panel} popover={nativePopover?'auto':undefined} data-fallback={!nativePopover||undefined} data-over-stage id={id} role="group" aria-label="Assistant suggestions" className="assistant-suggestion-popover" style={{display:!nativePopover&&!open?'none':undefined,left:position?.left??0,top:position?.top??0,visibility:position?'visible':'hidden'}} onToggle={event=>{if(!nativePopover)return;const opened=event.newState==='open';setOpen(opened);if(!opened)setPosition(undefined);}}>
      <span>Suggested next steps</span>{items.map(item=><button key={item.id} type="button" disabled={disabled(item)} onClick={()=>{close();onChoose(item);}}>{item.label}<span aria-hidden="true">↗</span></button>)}
    </div>,document.body)}
  </>;
}
