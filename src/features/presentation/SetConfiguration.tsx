import {SetPicker} from './SetPicker';
import {MediaAssetsDialog} from './MediaAssetsDialog';
import {ipc} from '../../lib/ipc';
import {PACKAGE_BYTES} from './assets';
import { useEffect, useMemo, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { BUILTIN_SETS } from './catalog';
import { PackageAuthoringDialog, type AuthoringIntent } from './PackageAuthoringDialog';
import { RehearsalSession } from './rehearsal';
import type { PresentationPackage } from './schema';
import type { SetOutputControls } from './useSetOutput';
import './presentation.css';

export function SetConfiguration({ session, onChange, output, hideOutputAction=false, actions }: {
  actions?:ReactNode; hideOutputAction?:boolean; output?:SetOutputControls; session: RehearsalSession; onChange: (doc: PresentationPackage) => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const rehearsing = state.workspaceMode === 'rehearsal';
  const optionsId=useId(),filesId=useId();
  const [position,setPosition]=useState({left:8,top:80});
  const trigger = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [library,setLibrary]=useState<Array<{file:string;id:string;name:string}>>([]);
  const [selectedFile,setSelectedFile]=useState('');
  const refreshLibrary=async()=>{try{setLibrary(await ipc.setLibraryList());}catch(e){setError(String(e));}};
  useEffect(()=>{void refreshLibrary();},[session.package.id]);
  const loadLibrary=async(file:string)=>{try{const next=new RehearsalSession(JSON.parse(await ipc.setLibraryRead(file)),undefined,'prepare');onChange(next.package);setSelectedFile(file);setError('');}catch(e){setError(String(e));}};
  const saveImported=async(doc:PresentationPackage)=>{await ipc.setLibrarySave(JSON.stringify(doc));await refreshLibrary();};
  const [media,setMedia]=useState(false);
  const [help, setHelp] = useState(false);
  const [authoring, setAuthoring] = useState<{ intent: AuthoringIntent; doc: PresentationPackage } | null>(null);
  const edit = (intent: AuthoringIntent) => { setAuthoring({ intent, doc: session.exportPreparedPackage() }); };
  async function importFile(input: File | undefined) {
    if (!input) return;
    try {
      if (input.size > PACKAGE_BYTES) throw new Error('Set package exceeds 40 MB.');
      const next = new RehearsalSession(JSON.parse(await input.text()), undefined, 'prepare');
      await saveImported(next.package);setSelectedFile('');
      onChange(next.package); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to import set.'); }
    finally { if (file.current) file.current.value = ''; }
  }
  const choices=useMemo(()=>[
    ...BUILTIN_SETS.filter(doc=>!library.some(entry=>entry.id===doc.id)).map(doc=>({value:`builtin:${doc.id}`,label:doc.name,group:'Built-in sets',load:async()=>doc})),
    ...library.map(entry=>({value:`file:${entry.file}`,label:entry.name+(library.filter(other=>other.name===entry.name).length>1?` · ${entry.file}`:''),group:'Saved sets',load:async()=>JSON.parse(await ipc.setLibraryRead(entry.file)) as PresentationPackage})),
    ...(!BUILTIN_SETS.map(doc=>doc.id).includes(session.package.id)&&!library.some(entry=>entry.id===session.package.id)?[{value:'imported',label:session.package.name,group:'Current set',load:async()=>session.package}]:[]),
  ],[library,session.package]);
  return <>
    <section className="set-configuration" role="toolbar" aria-label="Set configuration">
      <div className="set-menu-section">
      <span className="set-picker-label">Choose set</span><SetPicker value={library.some(entry=>entry.file===selectedFile&&entry.id===session.package.id)?`file:${selectedFile}`:library.some(entry=>entry.id===session.package.id)?`file:${library.find(entry=>entry.id===session.package.id)!.file}`:BUILTIN_SETS.map(doc=>doc.id).includes(session.package.id)?`builtin:${session.package.id}`:'imported'}
        options={choices}
        onSelect={value=>{if(value.startsWith('file:'))void loadLibrary(value.slice(5));else {const next=BUILTIN_SETS.find(doc=>`builtin:${doc.id}`===value);if(next){setSelectedFile('');setError('');onChange(next);}}}}/>


      </div>
      <button ref={trigger} type="button" popoverTarget={filesId} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(r.left,innerWidth-228)),top:r.bottom+6});}}>Files ▾</button>
      <div id={filesId} popover="auto" className="set-configuration-popover set-files-popover" style={{left:position.left,top:position.top}}>
        <button onClick={()=>{document.getElementById(filesId)?.hidePopover();setError('');file.current?.click();}}>Import set</button>
        <button onClick={()=>{document.getElementById(filesId)?.hidePopover();edit('export');}}>Export set</button>
        <button onClick={()=>{document.getElementById(filesId)?.hidePopover();setMedia(true);}}>Media assets</button>
      </div>
      {output&&!hideOutputAction&&<button disabled={output.busy} onClick={()=>void(output.active||output.busy?output.returnToRoom():output.apply())}>{output.active||output.busy?'Show room scene':'Show set'}</button>}
      <button type="button" popoverTarget={optionsId} aria-label="Set options" onClick={e=>{const r=e.currentTarget.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(r.right-320,innerWidth-328)),top:r.bottom+6});}}>Set options ▾</button>
      <div id={optionsId} popover="auto" className="set-configuration-popover" style={{left:position.left,top:position.top,maxHeight:`calc(100dvh - ${position.top+12}px)`}}>
      <strong>Set options</strong>
      {!hideOutputAction&&output?.renderer==='native'&&<label className="set-selection-preference"><input type="checkbox" checked={!!output.selectToShow} onChange={e=>output.setSelectToShow?.(e.target.checked)}/>Show configured sets when selected</label>}
      <details className="set-menu-advanced"><summary>Advanced</summary><div className="set-menu-advanced-body">
      {library.some(entry=>entry.id===session.package.id)&&<button onClick={()=>{const entry=library.find(entry=>entry.file===selectedFile&&entry.id===session.package.id)??library.find(entry=>entry.id===session.package.id);if(entry)void loadLibrary(entry.file);}}>Reload saved set</button>}
      <div className="set-menu-agent"><button onClick={() => edit('edit-set')}>Edit set with agent</button>
        <button className="set-agent-help" aria-label="About editing sets and shows with an agent" aria-expanded={help} onClick={() => setHelp(!help)}>?</button></div>
      {help && <p>Edit the set design and optional show with an agent. Export your configured set and brief, then import the updated JSON and rehearse it.</p>}
      {!session.package.show && <button aria-haspopup="dialog" onClick={() => edit('add-show')}>Add show with agent</button>}


      {!!Object.keys(session.package.set.feeds).length && <details className="set-test-data"><summary>Test data</summary>
        <p>Manual inputs for data connected to this set, such as headlines or meters. These are simulated values, not guest video or audience responses.</p>
        {!rehearsing && <p>Enter rehearsal to test changes. Exiting rehearsal restores your prepared values.</p>}
        <div className="set-controls-fields">{Object.entries(session.package.set.feeds).map(([key, def]) => <label key={key}>{key}<input aria-label={`Test ${key}`} disabled={!rehearsing}
          type={def.type === 'number' ? 'range' : def.type === 'boolean' ? 'checkbox' : 'text'}
          value={def.type === 'boolean' ? undefined : String(state.feeds[key])} checked={def.type === 'boolean' ? !!state.feeds[key] : undefined}
          min={def.type === 'number' ? def.min : undefined} max={def.type === 'number' ? def.max : undefined} step="0.01"
          maxLength={def.type === 'text' ? def.maxLength : undefined}
          onChange={e => session.send({ type: 'feed', key, value: def.type === 'boolean' ? e.target.checked : def.type === 'number' ? Number(e.target.value) : e.target.value })} /></label>)}</div>
      </details>}
      <details className="set-trace"><summary>Activity</summary><ol>{state.trace.map((entry, i) => <li key={`${i}-${entry.at}`}>{Math.round(entry.at / 1000)}s · {entry.message}</li>)}</ol></details>
      </div></details>
      </div>
      {actions}
      {error && <p role="alert">{error}</p>}
    </section>
    <input ref={file} className="set-file-input" type="file" accept=".json,application/json" aria-label="Import set package" onChange={e => void importFile(e.target.files?.[0])} />
    {media&&<MediaAssetsDialog doc={session.exportPreparedPackage()} layoutId={state.layoutId} onLoad={onChange} onClose={()=>setMedia(false)}/>}
    {authoring && <PackageAuthoringDialog {...authoring} returnFocus={trigger.current} onLoad={doc => {void saveImported(doc).then(()=>{setSelectedFile('');onChange(doc);}).catch(e=>{setError(String(e));});}} onClose={() => setAuthoring(null)} />}
  </>;
}
