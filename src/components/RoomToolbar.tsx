import {forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import './RoomToolbar.css';

type ToolbarButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  tooltip?: string;
  tooltipAlign?: 'start'|'end';
};

/** Visible symbols, explicit accessible names, and the same hint on hover or focus. */
export const ToolbarButton = forwardRef<HTMLButtonElement,ToolbarButtonProps>(function ToolbarButton(
  {label,tooltip=label,tooltipAlign,children,className='',...props}, ref,
) {
  const hint=useId();
  const anchor=useRef<HTMLSpanElement>(null),tip=useRef<HTMLSpanElement>(null),timer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const [hintOpen,setHintOpen]=useState(false),[hintPosition,setHintPosition]=useState<{top:number;left:number}>();
  const dismissHint=()=>{clearTimeout(timer.current);setHintOpen(false);};
  const showHint=(keyboard=false)=>{clearTimeout(timer.current);if(props['aria-expanded']===true)return;setHintPosition(undefined);if(keyboard)setHintOpen(true);else timer.current=setTimeout(()=>setHintOpen(true),350);};
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  useEffect(()=>{if(props['aria-expanded']===true)dismissHint();},[props['aria-expanded']]);
  useLayoutEffect(()=>{
    if(!hintOpen||!tip.current||!anchor.current)return;
    const place=()=>{
      const a=anchor.current!.getBoundingClientRect(),b=tip.current!.getBoundingClientRect(),pad=8;
      const left=tooltipAlign==='start'?a.left:tooltipAlign==='end'?a.right-b.width:a.left+(a.width-b.width)/2;
      const top=a.bottom+9+b.height>window.innerHeight-pad?a.top-b.height-9:a.bottom+9;
      setHintPosition({left:Math.max(pad,Math.min(left,window.innerWidth-b.width-pad)),top:Math.max(pad,top)});
    };
    place();const observer=new ResizeObserver(place);observer.observe(tip.current);
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[hintOpen,tooltip,tooltipAlign]);
  return <span ref={anchor} className="rm-toolbar-action" data-open={props['aria-expanded']===true} onPointerEnter={()=>showHint()} onPointerLeave={dismissHint} onFocusCapture={()=>showHint(true)} onBlurCapture={dismissHint} onPointerDown={dismissHint} onKeyDown={event=>{if(event.key==='Escape')dismissHint();}}>
    <button {...props} ref={ref} type={props.type??'button'} className={`rm-toolbar-button ${className}`} aria-label={label} aria-describedby={hintOpen?hint:undefined}>{children}</button>
    {hintOpen&&props['aria-expanded']!==true&&createPortal(<span ref={tip} id={hint} role="tooltip" className="rm-toolbar-tooltip" data-over-stage style={{top:hintPosition?.top??0,left:hintPosition?.left??0,visibility:hintPosition?'visible':'hidden'}}>{tooltip}</span>,document.body)}
  </span>;
});

type TransportAction = () => Promise<boolean|void>;
export type RoomTransportProps = {
  visible: boolean;
  recording: boolean;
  recordingPath: string|null;
  recordingElapsed: string;
  recordingBusy: boolean;
  recordDisabled: boolean;
  recordReason?: string;
  streaming: boolean;
  streamBusy: boolean;
  streamDisabled: boolean;
  streamReason?: string;
  destinations: {id:string;label:string;icon:ReactNode}[];
  audienceLabel?: string;
  program: string;
  streamFormat: string;
  recordFormat: string;
  recordingFolder: string;
  recordRequest?: number;
  onOpen?: () => void;
  onRecord: TransportAction;
  onStream: TransportAction;
  onStopStream: TransportAction;
};

/** A non-modal, anchored review. Opening or dismissing it never starts output. */
export function RoomTransportControls(props:RoomTransportProps) {
  const [menu,setMenu]=useState<'record'|'stream'|null>(null);
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const flight=useRef(false),mounted=useRef(true);
  const recordTrigger=useRef<HTMLButtonElement>(null),streamTrigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const id=useId();
  const [position,setPosition]=useState<{top:number;left:number}>();
  const record=menu==='record',running=record?props.recording:props.streaming;
  const busy=pending||(record?props.recordingBusy:props.streamBusy);
  const disabled=record?props.recordDisabled:props.streamDisabled;
  const title=record?(running?'Stop recording?':'Record this room?'):(running?'End this stream?':'Ready to go live?');
  const close=(restoreFocus=false)=>{setMenu(null);setError('');if(restoreFocus)(record?recordTrigger:streamTrigger).current?.focus();};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(!props.visible)setMenu(null);},[props.visible]);
  useEffect(()=>{if(props.recordRequest&&props.visible&&!flight.current){props.onOpen?.();setError('');setMenu('record');}},[props.recordRequest]);
  useLayoutEffect(()=>{
    if(!menu)return;
    const trigger=(menu==='record'?recordTrigger:streamTrigger).current,element=panel.current;
    if(!trigger||!element)return;
    const place=()=>{
      const anchor=trigger.getBoundingClientRect(),box=element.getBoundingClientRect(),pad=10;
      setPosition({left:Math.max(pad,Math.min(anchor.right-box.width,window.innerWidth-box.width-pad)),top:Math.max(pad,Math.min(anchor.bottom+9,window.innerHeight-box.height-pad))});
    };
    place();element.focus();
    const observer=new ResizeObserver(place);observer.observe(element);
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[menu]);
  useEffect(()=>{
    if(!menu)return;
    const outside=(event:PointerEvent)=>{if(flight.current)return;const target=event.target as Node;if(!panel.current?.contains(target)&&!recordTrigger.current?.contains(target)&&!streamTrigger.current?.contains(target))close();};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!flight.current){event.preventDefault();event.stopPropagation();close(true);}};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);};
  },[menu]);
  const open=(next:'record'|'stream')=>{if(flight.current)return;props.onOpen?.();setError('');setPosition(undefined);setMenu(old=>old===next?null:next);};
  const confirm=async()=>{
    if(flight.current||busy||disabled||!menu)return;
    flight.current=true;setPending(true);setError('');
    try {
      const result=await(record?props.onRecord():running?props.onStopStream():props.onStream());
      if(!mounted.current)return;
      if(result===false)setError('The output could not be changed. Check Activity, then try again.');
      else close(true);
    } catch {if(mounted.current)setError('The output could not be changed. Check Activity, then try again.');}
    finally{flight.current=false;if(mounted.current)setPending(false);}
  };
  return <>
    <ToolbarButton ref={recordTrigger} label={props.recording?'Stop recording':'Record'} tooltip={props.recordReason??(props.recording?`Recording · ${props.recordingElapsed} · Review before stopping`:'Record locally · Review format and save location')} className={`rm-toolbar-record${props.recording?' is-active':''}`} disabled={props.recordDisabled||props.recordingBusy||pending} aria-haspopup="dialog" aria-expanded={menu==='record'} aria-controls={menu==='record'?id:undefined} onClick={()=>open('record')}>
      <span className={props.recording?'rm-toolbar-stop':'rm-toolbar-record-dot'} aria-hidden="true"/>
    </ToolbarButton>
    <ToolbarButton ref={streamTrigger} label={props.streaming?'End stream':'Go live'} tooltip={props.streamReason??(props.streaming?'Live · Review before ending the stream':'Go live · Review streaming destinations')} tooltipAlign="end" className={`rm-toolbar-live${props.streaming?' is-active':''}`} disabled={props.streamDisabled||props.streamBusy||pending} aria-haspopup="dialog" aria-expanded={menu==='stream'} aria-controls={menu==='stream'?id:undefined} onClick={()=>open('stream')}>
      {props.streaming?<span className="rm-toolbar-stop" aria-hidden="true"/>:<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4-8.4a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>}
    </ToolbarButton>
    {menu&&createPortal(<div ref={panel} id={id} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} tabIndex={-1} className="rm-pop rm-pop-portal rm-output-confirmation" style={{position:'fixed',top:position?.top??0,left:position?.left??0,visibility:position?'visible':'hidden'}}>
      <header><span className={`rm-output-symbol ${record?'record':'live'}`} aria-hidden="true">{record?'●':'◉'}</span><div><h2 id={`${id}-title`}>{title}</h2><p>{record?(running?`Recorded ${props.recordingElapsed}`:'Saved on this device'):(running?'Your selected channels are live':'Your room will stream to')}</p></div></header>
      {!record&&<ul className="rm-output-destinations" aria-label="Streaming destinations">{props.destinations.map(destination=><li key={destination.id}><span aria-hidden="true">{destination.icon}</span><strong>{destination.label}</strong></li>)}</ul>}
      {!record&&!props.destinations.length&&<p className="rm-output-note">Choose an external channel in Channels before streaming.</p>}
      {!record&&props.audienceLabel&&<p className="rm-output-note">{props.audienceLabel} audience access is already open, independently of this stream.</p>}
      <dl><div><dt>Output</dt><dd>{props.program}</dd></div><div><dt>Video</dt><dd>{record?props.recordFormat:props.streamFormat}</dd></div>{record&&<div><dt>{running?'File':'Save to'}</dt><dd>{running?props.recordingPath?.split(/[\\/]/).pop():props.recordingFolder}</dd></div>}</dl>
      {error&&<p className="rm-output-error" role="alert">{error}</p>}
      <footer><button type="button" className="rm-output-cancel" disabled={pending} onClick={()=>close(true)}>Cancel</button><button type="button" className="rm-output-confirm" disabled={busy||disabled} onClick={()=>void confirm()}>{busy?'Please wait…':record?(running?'Stop and save':'Start recording'):(running?'End stream':'Start streaming')}</button></footer>
    </div>,document.body)}
  </>;
}
