import {useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {revealItemInDir} from '@tauri-apps/plugin-opener';
import {convertFileSrc} from '../../lib/nativeInvoke';
import type {ClipFile, ClipSettings, SavedClip} from './clips';
import type {ClipsController} from './useClips';
import './ClipsPanel.css';

function Icon({kind}:{kind:'clip'|'save'|'folder'|'settings'|'close'|'more'}) {
 const paths = {
  clip:<><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M8 4l4 5m3-5 4 5"/></>,
  save:<path d="M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4"/>,
  folder:<path d="M3 7V5h7l2 2h9v13H3V7Z"/>,
  settings:<><path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 3v6m8 0v6m-6 0v6" strokeWidth="2.5"/></>,
  close:<path d="m6 6 12 12M6 18 18 6"/>,
  more:<path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3"/>,
 };
 return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

const time=(seconds:number)=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds)%60).padStart(2,'0')}`;
const label=(seconds:number)=>seconds<60?`${seconds}s`:`${+(seconds/60).toFixed(1)}m`;
const clipWindows=[15,30,60,120];
const dateLabel=(ms:number)=>new Date(ms).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const formatLabel=(output:ClipSettings['output'])=>output==='portrait'?'Vertical':output==='landscape'?'Landscape':'Both';
const safely=(result:Promise<unknown>)=>void result.catch(()=>{});

function ClipThumbnail({file}:{file:ClipFile}) {
 const element=useRef<HTMLSpanElement>(null);
 const [visible,setVisible]=useState(false);
 const [loaded,setLoaded]=useState(false);
 useEffect(()=>{
  if(!element.current)return;
  const observer=new IntersectionObserver(([entry])=>{
   setVisible(entry.isIntersecting);
   if(!entry.isIntersecting)setLoaded(false);
  });
  observer.observe(element.current);
  return ()=>observer.disconnect();
 },[]);
 return <span className="clips-thumbnail" ref={element} aria-hidden="true">
  <Icon kind="clip"/>
  {visible&&<video muted playsInline tabIndex={-1} preload="auto" src={`${convertFileSrc(file.path)}#t=0.1`} data-loaded={loaded}
   onLoadedData={()=>setLoaded(true)} onError={()=>setLoaded(false)} />}
 </span>;
}

export function ClipsPanel({controller:c,compact=false,horizontal=false}:{controller:ClipsController;compact?:boolean;horizontal?:boolean}) {
 const [expanded,setExpanded]=useState(false);
 const [settingsOpen,setSettingsOpen]=useState(false);
 const [preview,setPreview]=useState<{clip:SavedClip;file:ClipFile}|null>(null);
 const [editing,setEditing]=useState<string|null>(null);
 const [name,setName]=useState('');
 const [renaming,setRenaming]=useState(false);
 const [menu,setMenu]=useState<string|null>(null);
 const [fileError,setFileError]=useState('');
 const dialog=useRef<HTMLDialogElement>(null),previewDialog=useRef<HTMLDialogElement>(null),scroll=useRef<HTMLDivElement>(null);
 const titleId=useId(),previewId=useId(),settingsId=useId();
 const previewOpen=preview!==null;
 useEffect(()=>{
  if(!expanded||!compact)return;
  const element=dialog.current;
  element?.showModal();
  return()=>element?.close();
 },[expanded,compact]);
 useEffect(()=>{
  if(!previewOpen)return;
  const element=previewDialog.current;
  element?.showModal();
  return()=>element?.close();
 },[previewOpen]);

 const saving=c.pending==='save'||c.capture.saving;
 const active=c.capture.enabled;
 const locked=active||saving||!!c.pending;
 const canSave=active&&!saving&&!c.pending&&c.capture.elapsed_seconds>=2&&c.capture.video_frames>0;
 const waiting=active&&(c.capture.elapsed_seconds<2||c.capture.video_frames===0);
 const stalled=active&&c.capture.elapsed_seconds>=10&&c.capture.video_frames===0;
 const problem=c.error||(stalled?'Capture is not receiving video. Restart rolling capture to try again.':'');
 const status=saving?'Saving…':c.pending==='capture'?'Starting…':problem?'Needs attention':!c.ready?'Preparing…':waiting?'Buffering':active?'Rolling':'Off';
 const saveHint=!c.ready?'Preparing room…':problem?'See capture details below.':!active?'Turn on rolling capture.':waiting?'Waiting for video…':'';
 const update=(next:Partial<ClipSettings>)=>safely(c.configure({...c.settings,...next}));
 const savedClips=c.recent.filter(clip=>clip.status==='ready');
 const count=savedClips.length;
 const latest=savedClips.find(clip=>clip.files.length>0);
 const latestFile=latest?.files[0];
 const folder=c.directory.split(/[\\/]/).filter(Boolean).pop()||'Recording folder';
 const folderUnavailable=/recording folder.*unavailable|connect the drive/i.test(problem);
 const clipName=(clip:SavedClip)=>c.clipNames[clip.id]||`Clip · ${dateLabel(clip.created_ms)}`;
 const toggle=<button type="button" className="clips-switch" role="switch" aria-checked={active} aria-label="Rolling capture"
   title="Rolling capture" disabled={!c.ready||!!c.pending||saving} onClick={()=>safely(c.toggle())}><span/></button>;
 const saveLabel=saving?'Saving…':`Save last ${label(c.settings.seconds)}`;
 const save=(short=false)=><button type="button" className="clips-save" aria-label={saveLabel} title={!canSave?saveHint||status:saveLabel} disabled={!canSave} onClick={()=>safely(c.save())}>
   <Icon kind="save"/><span className="clips-save-label">{short&&!saving?'Save clip':saveLabel}</span>
  </button>;
 const captureWindow=<label className="clips-console-window" title={active?'Turn off rolling capture to change the capture window.':'Capture window'}>
  <select aria-label="Capture window" disabled={locked||!c.ready} value={c.settings.seconds}
   onChange={event=>update({seconds:Number(event.target.value)})}>
   {!clipWindows.includes(c.settings.seconds)&&<option value={c.settings.seconds}>{label(c.settings.seconds)}</option>}
   {clipWindows.map(seconds=><option key={seconds} value={seconds}>{label(seconds)}</option>)}
  </select>
 </label>;

 async function rename(id:string) {
  setRenaming(true);
  setFileError('');
  try {
   await c.rename(id,name);
   setEditing(null);
  } catch(error) {setFileError(String(error));}
  finally {setRenaming(false);}
 }

 function body(inDialog=false) {
  const row=horizontal&&!inDialog;
  return <div className={`clips-body${row?' clips-body--horizontal':''}`}>
   <header className="clips-header">
    <h2 id={inDialog?titleId:undefined}>Clips</h2>
    <div className="clips-status-row">
     <span className="clips-status" title={status}><i data-on={active&&!waiting&&!problem} data-waiting={waiting&&!problem} data-error={!!problem}/><span role="status">{status}</span>{active&&!waiting&&!problem&&!saving&&<span className="clips-elapsed">{time(c.capture.elapsed_seconds)}</span>}</span>
     {toggle}
    </div>
    <button type="button" className="clips-icon-button clips-settings" aria-label="Clip settings" aria-expanded={settingsOpen}
     aria-controls={settingsOpen?settingsId:undefined} title="Clip settings" onClick={()=>{if(!settingsOpen&&scroll.current)scroll.current.scrollTop=0;setSettingsOpen(!settingsOpen);}}><Icon kind="settings"/></button>
    {inDialog&&<button type="button" className="clips-icon-button clips-close" aria-label="Close Clips" onClick={()=>setExpanded(false)}><Icon kind="close"/></button>}
   </header>
   <div className="clips-capture">
    <div className="clips-capture-actions">{save(true)}{captureWindow}</div>
    {waiting&&!problem&&<p className="clips-save-hint">{saveHint}</p>}
    {problem&&<div className="clips-error" role="alert">
     <span>{problem}</span>
     <button type="button" onClick={()=>safely(stalled?c.restart():active?c.save():c.setEnabled(true))}
      disabled={!!c.pending}>{stalled?'Restart capture':active?'Try saving again':'Try capture again'}</button>
    </div>}
   </div>
   <div className="clips-scroll" ref={scroll}>
    {settingsOpen&&<section id={settingsId} className="clips-options" aria-label="Clip settings">
     {active&&<p>Stop rolling capture to change settings.</p>}
     <fieldset disabled={locked||!c.ready}>
      <label className="clips-field">Custom duration <span><input aria-label="Buffer seconds" type="number" min="1" max="600" value={c.settings.seconds}
       onChange={e=>{const seconds=Number(e.target.value);if(Number.isInteger(seconds)&&seconds>=1&&seconds<=600)update({seconds});}}/> sec</span></label>
      <label className="clips-field">Output<select aria-label="Output" value={c.settings.output} onChange={e=>update({output:e.target.value as ClipSettings['output']})}>
       {(['landscape','portrait','both'] as const).map(output=><option key={output} value={output}>{formatLabel(output)}</option>)}</select></label>
      <label className="clips-field">Memory budget<select value={c.settings.memory_mb} onChange={e=>update({memory_mb:Number(e.target.value)})}>
       {[64,128,256,512,1024].map(mb=><option value={mb} key={mb}>{mb} MB</option>)}</select></label>
     </fieldset>
    </section>}
    <section className="clips-recent" aria-label="Saved clips">
     <h3>Saved clips <span>{count}</span></h3>
     {fileError&&<p className="clips-error" role="alert">{fileError}</p>}
     {c.recent.length===0?<p>No saved clips yet.</p>:<ul>{c.recent.map(clip=>{
      const first=clip.files[0];
      const title=clipName(clip);
      const detail=clip.status==='ready'&&first?`${clip.files.length>1?'Both formats':formatLabel(first.output)} · ${time(first.duration_ms/1000)}`
       :clip.status==='saving'?'Saving…':'Save needs attention';
      return <li key={clip.id}>
       <div className="clips-list-row">
        {first&&clip.status==='ready'?<>
         <button type="button" className="clips-record" onClick={()=>setPreview({clip,file:first})} aria-label={`Preview ${title}`}>
          <ClipThumbnail file={first}/>
          <span className="clips-record-copy"><strong>{title}</strong><small>{detail}</small>
           {c.clipNames[clip.id]&&<small>{dateLabel(clip.created_ms)}</small>}</span>
         </button>
         <button type="button" className="clips-icon-button clips-more" aria-label={`Actions for ${title}`} aria-expanded={menu===clip.id}
          onClick={()=>{setMenu(menu===clip.id?null:clip.id);setFileError('');}}><Icon kind="more"/></button>
        </>:<span className="clips-record-copy"><strong>{title}</strong><small>{clip.error||detail}</small></span>}
       </div>
       {menu===clip.id&&<div className="clips-row-actions">
        <button type="button" onClick={()=>{setEditing(clip.id);setName(c.clipNames[clip.id]||'');setMenu(null);}}>Rename clip</button>
        {clip.files.map(file=><button key={file.path} type="button"
         onClick={()=>{setMenu(null);void revealItemInDir(file.path).catch(error=>setFileError(String(error)));}}>
         {clip.files.length>1?`Reveal ${formatLabel(file.output).toLowerCase()} in folder`:'Reveal in folder'}
        </button>)}
       </div>}
       {editing===clip.id&&<form className="clips-row-actions" onSubmit={e=>{e.preventDefault();void rename(clip.id);}}>
        <input aria-label="Clip name" value={name} maxLength={80} placeholder={title} autoFocus onChange={e=>setName(e.target.value)}/>
        <button type="submit" disabled={renaming}>Save name</button>
        <button type="button" disabled={renaming} onClick={()=>setEditing(null)}>Cancel</button>
       </form>}
      </li>;
     })}</ul>}
    </section>
   </div>
   <footer className="clips-location">
    <Icon kind="folder"/><span title={c.directory}>{folderUnavailable?'Folder unavailable':folder}</span>
    <button type="button" aria-label="Choose recording and clip folder" disabled={!!c.pending||saving} onClick={()=>safely(c.chooseFolder())}>
     {folderUnavailable?'Choose folder':'Change'}
    </button>
   </footer>
  </div>;
 }
 return <div className={`clips-panel${compact?' clips-panel--compact':''}`}>
  {compact?<div className="clips-console">
   {save()}
   <button type="button" className="clips-console-toggle" role="switch" aria-label="Rolling capture" aria-checked={active}
    title={problem||`Rolling capture · ${status}`} disabled={!c.ready||!!c.pending||saving} onClick={()=>safely(c.toggle())}>
    <i className="clips-status-dot" data-on={active&&!waiting&&!problem} data-waiting={waiting&&!problem} data-error={!!problem}/>
    {active?'On':'Off'}
   </button>
   {captureWindow}
   <button type="button" className="clips-library" title={`Saved clips · ${count}`} aria-label={`Open Clips settings and saved clips, ${count} saved`} onClick={()=>setExpanded(true)}>
    <Icon kind="clip"/><span>{count}</span>
   </button>
   {latest&&latestFile&&<button type="button" className="clips-latest" aria-label={`Preview last clip: ${clipName(latest)}`}
    title={`Last clip · ${clipName(latest)}`} onClick={()=>setPreview({clip:latest,file:latestFile})}>
    <ClipThumbnail key={latestFile.path} file={latestFile}/>
    <span className="clips-latest-label">Last clip</span>
    <span className="clips-latest-duration">{time(latestFile.duration_ms/1000)}</span>
   </button>}
  </div>:body()}
  {compact&&expanded&&createPortal(<dialog ref={dialog} className="clips-dialog" aria-labelledby={titleId} onCancel={()=>setExpanded(false)}
   onClick={e=>{if(e.target===e.currentTarget)setExpanded(false);}}>{body(true)}</dialog>,document.body)}
  {preview&&createPortal(<dialog ref={previewDialog} className="clips-preview" aria-labelledby={previewId} onCancel={()=>setPreview(null)}>
   <header><h2 id={previewId}>{clipName(preview.clip)}</h2><button type="button" aria-label="Close clip preview" onClick={()=>setPreview(null)}><Icon kind="close"/></button></header>
   <video key={preview.file.path} src={convertFileSrc(preview.file.path)} controls autoPlay playsInline/>
   <div className="clips-preview-formats">
    {preview.clip.files.length>1&&preview.clip.files.map(file=><button key={file.path} type="button" aria-pressed={file.path===preview.file.path}
     onClick={()=>setPreview({...preview,file})}>{formatLabel(file.output)}</button>)}
    <span>{preview.clip.files.length===1&&`${formatLabel(preview.file.output)} · `}{time(preview.file.duration_ms/1000)}</span>
   </div>
  </dialog>,document.body)}
 </div>;
}
