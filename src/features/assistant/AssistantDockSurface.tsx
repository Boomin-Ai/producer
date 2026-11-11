import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

export interface AssistantCompletion {id:string;text:string;kind:'complete'|'error'}
type Dock={target:HTMLElement|null;compact:boolean;onExpand():void};

/** Views only: the parent retains the request, prompt and private draft owner. */
export function AssistantDockSurface({dock,parking,reviewOpen,busy,connected,status,summary,conversation,composer,completion,onRead,dismissKey}: {
  dock:Dock;parking:HTMLElement;reviewOpen:boolean;busy:boolean;connected:boolean;status:string;summary:string;
  conversation:ReactNode;composer:ReactNode;completion?:AssistantCompletion;onRead():void;dismissKey?:string;
}) {
  const [shallow,setShallow]=useState(false),[open,setOpen]=useState(false);
  const [position,setPosition]=useState<{left:number;top:number}>(),[toastPosition,setToastPosition]=useState<{left:number;top:number}>();
  const panel=useRef<HTMLDivElement>(null),toast=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const compact=dock.compact||shallow||reviewOpen;
  const unread=!!completion;
  const label=busy?'Working…':unread?(completion.kind==='error'?'Needs attention':'Reply ready'):status;
  const openConversation=()=>{if(reviewOpen)return;setPosition(undefined);setOpen(true);onRead();};
  const close=()=>{setOpen(false);trigger.current?.focus();};
  useEffect(()=>setOpen(false),[dismissKey]);
  useLayoutEffect(()=>{
    if(!dock.target)return;
    const update=()=>{const height=dock.target!.getBoundingClientRect().height;setShallow(height>40&&height<320);};
    update();const observer=new ResizeObserver(update);observer.observe(dock.target);return()=>observer.disconnect();
  },[dock.target]);
  useEffect(()=>{if(!compact||reviewOpen)setOpen(false);if(!compact||open||reviewOpen)onRead();},[compact,open,reviewOpen,completion?.id]);
  const showToast=compact&&!reviewOpen&&!open&&!!completion;
  useLayoutEffect(()=>{
    if(!open&&!showToast)return;
    const place=()=>{
      const anchor=dock.target?.getBoundingClientRect();if(!anchor)return;
      const locate=(element:HTMLElement|null)=>{
        if(!element)return;const box=element.getBoundingClientRect(),pad=10;
        return {left:Math.max(pad,Math.min(anchor.left,innerWidth-box.width-pad)),top:Math.max(pad,Math.min(anchor.top>=box.height+pad+7?anchor.top-box.height-7:anchor.bottom+7,innerHeight-box.height-pad))};
      };
      if(open)setPosition(locate(panel.current));if(showToast)setToastPosition(locate(toast.current));
    };
    place();const observer=new ResizeObserver(place);if(dock.target)observer.observe(dock.target);if(panel.current)observer.observe(panel.current);if(toast.current)observer.observe(toast.current);
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open,showToast,dock.target,completion?.id]);
  useEffect(()=>{
    if(!open)return;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!dock.target?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);};
  },[open,dock.target]);
  const dot=<span className={`assistant-connected-dot${busy?' working':''}${!connected?' disconnected':''}`}/>;
  const expand=<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 4h6v6m0-6-7 7M10 20H4v-6m0 6 7-7"/></svg>;
  const mini=<div className={`assistant-mini${shallow&&!dock.compact?' assistant-tight':''}`}>
    <button ref={trigger} className="assistant-mini-open" type="button" aria-label={`Assistant · ${label}`} aria-haspopup="dialog" aria-expanded={open} title="Open conversation" onClick={openConversation}>{dot}<strong>{busy?'Working':unread?(completion.kind==='error'?'Needs attention':'Reply ready'):'Assistant'}</strong>{!busy&&!unread&&<span className="assistant-mini-status">{label}</span>}</button>
    {shallow&&!dock.compact&&<button type="button" className="assistant-tight-summary" onClick={openConversation}>{summary||'Ask Producer. Your conversation opens in a full-size panel.'}</button>}
    {!reviewOpen&&!open&&composer}
    <button className="assistant-mini-expand" type="button" aria-label="Expand Assistant" aria-haspopup="dialog" aria-expanded={open} title="Open full conversation" onClick={openConversation}>{expand}</button>
  </div>;
  return <>
    {createPortal(<section className={`assistant-workspace assistant-docked${compact?' assistant-docked-mini':''}`} aria-label="Room Assistant">{compact?mini:conversation}</section>,dock.target??parking)}
    {open&&compact&&!reviewOpen&&createPortal(<div ref={panel} role="dialog" aria-modal="false" aria-label="Assistant conversation panel" className="assistant-workspace assistant-floating" data-over-stage style={{left:position?.left??0,top:position?.top??0,visibility:position?'visible':'hidden'}}>
      <div className="assistant-floating-tools"><button type="button" onClick={()=>{setOpen(false);dock.onExpand();}}>Expand dock</button><button type="button" aria-label="Close Assistant conversation" onClick={close}>×</button></div>{conversation}
    </div>,document.body)}
    {showToast&&createPortal(<div ref={toast} className="assistant-task-toast" role={completion.kind==='error'?'alert':'status'} data-over-stage style={{left:toastPosition?.left??0,top:toastPosition?.top??0,visibility:toastPosition?'visible':'hidden'}}>
      <div><strong>{completion.kind==='error'?'Assistant needs attention':'Assistant finished'}</strong><button type="button" aria-label="Dismiss Assistant notification" onClick={onRead}>×</button></div><p>{completion.text}</p><button type="button" onClick={openConversation}>View reply ↗</button>
    </div>,document.body)}
  </>;
}
