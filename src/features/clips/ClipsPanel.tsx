import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {convertFileSrc} from '../../lib/nativeInvoke';
import {recording} from '../../lib/ipc';
import type {ClipFile,ClipSettings} from './clips';
import type {ClipsController} from './useClips';
import './ClipsPanel.css';
function Icon({kind}:{kind:'clip'|'save'|'folder'|'expand'|'close'}){return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{kind==='clip'?<><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 4l4 5m3-5 4 5"/></>:kind==='save'?<><path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/></>:kind==='folder'?<path d="M3 7V5h7l2 2h9v13H3V7Z"/>:kind==='close'?<path d="m6 6 12 12M6 18 18 6"/>:<path d="M14 3h7v7M3 14v7h7M21 3l-7 7M3 21l7-7"/>}</svg>}
const time=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds)%60).padStart(2,'0')}`;
const label=(seconds:number)=>seconds<60?`${seconds}s`:`${+(seconds/60).toFixed(1)}m`;
const safely=(result:Promise<unknown>)=>void result.catch(()=>{});
export function ClipsPanel({controller:c,compact=false}:{controller:ClipsController;compact?:boolean}) {
 const [expanded,setExpanded]=useState(false),[preview,setPreview]=useState<ClipFile|null>(null);
 const dialog=useRef<HTMLDialogElement>(null),previewDialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const titleId=useId(),previewId=useId();
 useEffect(()=>{if(!expanded)return;dialog.current?.showModal();return()=>{dialog.current?.close();trigger.current?.focus();};},[expanded]);
 useEffect(()=>{if(!preview)return;previewDialog.current?.showModal();return()=>{previewDialog.current?.close();};},[preview]);
 const saving=c.pending==='save'||c.capture.saving;
 const active=c.capture.enabled;
 const locked=active||saving||!!c.pending;
 const canSave=active&&!saving&&!c.pending&&c.capture.elapsed_seconds>=2&&c.capture.video_frames>0;
 const update=(next:Partial<ClipSettings>)=>safely(c.configure({...c.settings,...next}));
 const toggle=<button type="button" className="clips-switch" role="switch" aria-checked={active} aria-label="Rolling capture" disabled={!c.ready||!!c.pending||saving} onClick={()=>safely(c.toggle())}><span/><span className="clips-switch-label">{active?'On':'Off'}</span></button>;
 const save=<button type="button" className="clips-save" disabled={!canSave} onClick={()=>safely(c.save())}><Icon kind="save"/><span>{saving?'Saving…':`Save last ${label(c.settings.seconds)}`}</span></button>;
 const body=<div className="clips-body">
  <header className="clips-header"><span className="clips-heading"><Icon kind="clip"/><strong>Clips</strong></span>{toggle}</header>
  <div className="clips-capture"><div className="clips-status"><i data-on={active}/><span>{saving?'Saving clip to your folder':active?`Rolling · ${time(c.capture.elapsed_seconds)} elapsed`:'Rolling capture is off'}</span></div>{save}<p>{active?'Only future moments are buffered. Save keeps up to the window below.':'Turn on rolling capture to keep recent moments, then save them when something happens.'}</p></div>
  <div className="clips-options"><fieldset disabled={locked||!c.ready}><legend>Keep up to</legend><div className="clips-times">{[15,30,60,120].map(seconds=><button type="button" key={seconds} aria-pressed={c.settings.seconds===seconds} onClick={()=>update({seconds})}>{label(seconds)}</button>)}</div><label className="clips-field">Custom window <span><input aria-label="Buffer seconds" type="number" min="1" max="600" value={c.settings.seconds} onChange={e=>{const seconds=Number(e.target.value);if(Number.isInteger(seconds)&&seconds>=1&&seconds<=600)update({seconds});}}/> sec</span></label></fieldset>
  <fieldset disabled={locked||!c.ready}><legend>Output</legend><div className="clips-formats">{(['landscape','portrait','both'] as const).map(output=><button type="button" key={output} aria-pressed={c.settings.output===output} onClick={()=>update({output})}>{output==='both'?'Both':output==='landscape'?'Landscape':'Vertical'}</button>)}</div><label className="clips-field">Memory budget<select aria-label="Clips memory budget" value={c.settings.memory_mb} onChange={e=>update({memory_mb:Number(e.target.value)})}>{[64,128,256,512,1024].map(mb=><option value={mb} key={mb}>{mb} MB</option>)}</select></label></fieldset></div>
  <p className="clips-note">{active?'Stop rolling capture to adjust settings. ':''}The memory limit and keyframes can shorten the saved window. Both saves two MP4 files. Streaming and full recordings run independently.</p>
  <div className="clips-location"><Icon kind="folder"/><div><small>Recording & clip folder</small><span title={c.directory}>{c.directory||'Your recording folder'}</span></div><button type="button" disabled={!!c.pending||saving} onClick={()=>safely(c.chooseFolder())}>Change</button></div>
  {c.error&&<div className="clips-error" role="status">{c.error}<button type="button" onClick={()=>safely(c.refresh())} disabled={!!c.pending}>Check again</button></div>}
  <section className="clips-recent" aria-label="Saved clips"><h3>Recent clips <span>{c.recent.filter(clip=>clip.status==='ready').length}</span></h3>{c.recent.length===0?<p>Saved moments appear here. Files stay on this device until you choose to upload.</p>:<ul>{c.recent.map(clip=><li key={clip.id}><div><strong>{new Date(clip.created_ms).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</strong><span>{clip.status==='ready'?clip.files.map(file=>`${file.output==='portrait'?'Vertical':'Landscape'} · ${time(file.duration_ms/1000)}`).join(' + '):clip.status==='saving'?'Saving…':'Save needs attention'}</span>{clip.error&&<small>{clip.error}</small>}</div>{clip.files.map(file=><span className="clips-file-actions" key={file.path}><button type="button" onClick={()=>setPreview(file)} aria-label={`Preview ${file.output} clip`}>Play</button><button type="button" onClick={()=>safely(recording.reveal(file.path))} aria-label={`Show ${file.output} clip in folder`}><Icon kind="folder"/></button></span>)}</li>)}</ul>}</section>
 </div>;
 return <div className={`clips-panel${compact?' clips-panel--compact':''}`}>
  {compact?<div className="clips-console"><button type="button" className="clips-arm" aria-label={active?'Stop rolling capture':'Enable rolling capture'} title={active?'Stop rolling capture':'Enable rolling capture'} data-on={active} disabled={!c.ready||!!c.pending||saving} onClick={()=>safely(c.toggle())}><Icon kind="clip"/><i/></button>{save}<button type="button" className="clips-expand" ref={trigger} aria-label="Open Clips settings and saved clips" title="Clips settings & saved clips" onClick={()=>setExpanded(true)}><Icon kind="expand"/></button>{c.error&&<span className="clips-console-error" title={c.error} role="status">!</span>}</div>:body}
  {expanded&&createPortal(<dialog ref={dialog} className="clips-dialog" aria-labelledby={titleId} onCancel={()=>setExpanded(false)} onClick={e=>{if(e.target===e.currentTarget)setExpanded(false);}}><div className="clips-dialog-title"><h2 id={titleId}>Clips</h2><button type="button" aria-label="Close Clips" onClick={()=>setExpanded(false)}><Icon kind="close"/></button></div>{body}</dialog>,document.body)}
  {preview&&createPortal(<dialog ref={previewDialog} className="clips-preview" aria-labelledby={previewId} onCancel={()=>setPreview(null)}><header><h2 id={previewId}>Saved clip</h2><button type="button" aria-label="Close clip preview" onClick={()=>setPreview(null)}><Icon kind="close"/></button></header><video src={convertFileSrc(preview.path)} controls autoPlay playsInline/><p>{preview.output==='portrait'?'Vertical':'Landscape'} · {time(preview.duration_ms/1000)}</p></dialog>,document.body)}
 </div>;
}
