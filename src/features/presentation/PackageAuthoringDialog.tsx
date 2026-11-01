import {discoverAuthoringTarget} from './authoring/discovery';
import {designContext,packageRevision} from './authoring/compiler';
import {compileDesignPlan,applyDesignEdits} from './authoring/compiler';
import {AUTHORING_CATALOG} from './authoring/catalog';
import {designBrief} from './authoring/brief';
import { useEffect, useMemo, useRef, useState,useSyncExternalStore } from 'react';
import {activeEndpointId,WORKSPACE_EVENT} from '../../lib/workspace';
import {dataIntegrations} from '../../lib/dataIntegrations';
import {useDataConnections} from './useDataConnections';
import {SetAuthoringDraft,authoringBaseIssue} from './setAuthoring';
import {SetPreview} from './SetPreview';
import {RehearsalSession} from './rehearsal';
import { createPortal } from 'react-dom';
import { copyText } from '../../lib/roomLink';
import { presentationJsonSchema, type PresentationPackage } from './schema';

export type AuthoringIntent = 'edit-set' | 'add-show' | 'export';
const titles: Record<AuthoringIntent, string> = {
  'edit-set': 'Generate Set draft', 'add-show': 'Add show', export: 'Export set package',
};

const subscribeWorkspace=(listener:()=>void)=>{window.addEventListener(WORKSPACE_EVENT,listener);window.addEventListener('storage',listener);return()=>{window.removeEventListener(WORKSPACE_EVENT,listener);window.removeEventListener('storage',listener);};};
export function PackageAuthoringDialog({ doc, intent, onLoad, onClose, returnFocus }: {
  doc: PresentationPackage; intent: AuthoringIntent; onLoad: (doc: PresentationPackage) => void;
  onClose: () => void; returnFocus: HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const currentDoc=useRef(doc);currentDoc.current=doc;
  const [request, setRequest] = useState('');
  const endpoint=useSyncExternalStore(subscribeWorkspace,activeEndpointId,()=>null);
  const {connections,connectionError,retryConnections}=useDataConnections(intent==='edit-set'?endpoint??undefined:undefined);
  const [designMode,setDesignMode]=useState(false);
  const [target,setTarget]=useState<import('./authoring/catalog').AuthoringTarget>();
  const [capabilityError,setCapabilityError]=useState('');
  useEffect(()=>{let disposed=false;setTarget(undefined);setCapabilityError('');if(!designMode||!endpoint)return;void dataIntegrations.authoringCapabilities(endpoint).then(discoverAuthoringTarget).then(value=>{if(!disposed)setTarget(value);}).catch(e=>{if(!disposed)setCapabilityError(e instanceof Error?e.message:String(e));});return()=>{disposed=true;};},[designMode,endpoint]);
  const [connectionId,setConnectionId]=useState(''),[useBase,setUseBase]=useState(false);
  const agents=connections.filter(saved=>saved.connection.kind==='agent'&&saved.connection.provider==='anthropic'&&saved.hasSecret);
  const selected=agents.find(saved=>saved.connection.id===connectionId)||(connectionId?undefined:agents[0]);
  const authoring=useMemo(()=>new SetAuthoringDraft(input=>{if(!endpoint)throw Error('Connect a workspace to generate a Set.');const {connectionId,...body}=input;
    if(!designMode)return dataIntegrations.authorSet(endpoint,connectionId,body);
    if(!target)throw Error('Wait for compatible app and workspace capabilities.');
    return (async()=>{
      const base=body.package;
      const reply=await dataIntegrations.authorDesign(endpoint,connectionId,{expectedRevision:body.expectedRevision,prompt:body.prompt,target,...(base?{context:designContext(base),baseRevision:await packageRevision(base)}:{})});
      const candidate=base?await applyDesignEdits(base,reply.document,target):compileDesignPlan(reply.document,target);
      return {...reply,package:candidate};
    })();
  }),[endpoint,designMode,target]);
  const draft=useSyncExternalStore(authoring.subscribe,authoring.snapshot);
  const baseIssue=useMemo(()=>designMode?undefined:authoringBaseIssue(doc),[doc,designMode]);
  const generationPrompt=(intent==='add-show'?'Include an optional Show with the requested segment sequence. ':'')+request.trim();
  useEffect(()=>{authoring.cancel();return()=>authoring.cancel();},[authoring,doc,selected?.connection.id,selected?.revision]);
  const close=()=>{authoring.cancel();onClose();};
  const generate=()=>{if(!selected||!request.trim()||useBase&&baseIssue||designMode&&!target)return;setNotice('');void authoring.generate({connectionId:selected.connection.id,expectedRevision:selected.revision,prompt:generationPrompt,...(useBase?{package:doc}:{}),requireShow:intent==='add-show'});};
  const [notice, setNotice] = useState('');
  const compilePlan=async()=>{
    const original=draft.text,base=doc;
    try{
      const input=JSON.parse(original),target={catalogRevision:AUTHORING_CATALOG.revision,features:[...AUTHORING_CATALOG.features]};
      const compiled=input.schema==='producer.set-edit/1'?await applyDesignEdits(base,input,target):compileDesignPlan(input,target,base.set.assets);
      if(currentDoc.current!==base||authoring.snapshot().text!==original||!ref.current?.open)return;
      authoring.editCandidate(JSON.stringify(compiled,null,2));authoring.validate();setNotice('Design compiled. Review both layouts before loading preparation.');
    }catch(e){setNotice(e instanceof Error?e.message:'Design compilation failed.');}
  };
  const packageJson = useMemo(()=>JSON.stringify(doc,null,2),[doc]);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); returnFocus?.focus(); };
  }, [returnFocus]);
  const brief = () => [
    `Update this Producer set package: ${doc.name}. Task: ${titles[intent]}.`,
    request.trim() || (intent === 'add-show' ? 'Attach a show with a clear segment sequence using the supported schema. Keep the existing set design.' : 'Preserve the existing design and show unless my requested change requires it.'),
    'Return a complete JSON package only, within 40 MB (including embedded assets). Keep stable source slot IDs and preserve configured fields unless instructed otherwise.',
    'The set is independent of its optional show. Never add dummy contestants or votes to a standalone set. A show is an optional sequence of segments, each referencing an authored set layout. A sequence without voting needs no choices. Only include choices and collectMs for voting steps. Standalone room voting does not require a show. Do not invent unsupported actions.',
    'Use only the schema below. No scripts, HTML, URLs, credentials, camera/microphone activation, recording or streaming commands. Producer owns Stop and recovery. The updated package will be validated and rehearsed before live integration.',
    'GPU effects use shader nodes with aurora, edgeGlow, lightSweep, plasma, silk, rings, grid, stars, petals, contours, prism, borderFlare, rain, snow, clouds, voiceBars or voiceRing presets. voiceRing draws a connected circular outline with smooth voice-driven waves around a camera: use a square shader centered on the slot, radius equal to half the camera width, and at least 90px of padding. voiceBars visualizes existing microphone-bus level, not a PCM waveform; native output uses existing mic levels and browser preview is explicitly simulated. intensity controls sensitivity and scale controls bar density. Never activate audio devices or provide an audioLevel override. Put up to four shader nodes directly under a relative layout root whose numeric width/height match the canvas; root styles are position, width, height, background and overflow only. Shader nodes use numeric absolute left/top/width/height, three #RRGGBB colors, speed 0–4, intensity 0–2, scale 0.25–4, opacity 0–1, radius 0–960, quality low/medium, and clock show/segment. Shader planes sit above the root background and below cameras and foreground graphics; reserve a padded rectangle around a camera for edgeGlow. Use shader.intensity or shader.scale keyframe tracks to animate parameters. No imported shader code. Author separate landscape and portrait layouts.',
    'Configured package (no rehearsal results or participant identities):', packageJson,
    'JSON Schema (Producer also checks cross-references, bindings and expansion limits):', JSON.stringify(presentationJsonSchema),
  ].join('\n\n');
  async function copy(text: string, label: string) {
    setNotice(await copyText(text) ? `${label} copied.` : 'Copy failed. Select the JSON below and copy it manually.');
  }
  function load() {if(!draft.package)return;onLoad(draft.package);close();}
  return createPortal(<dialog ref={ref} className="set-authoring-dialog" aria-label={titles[intent]}
    onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }}>
    <header><div><strong>{titles[intent]}</strong><span>{doc.name} · Agent authoring</span></div><button onClick={close}>Close</button></header>
    <p>Describe a Set, validate the draft, and preview it before loading it into preparation. Loading a draft does not put it on air.</p>
    {intent !== 'export' && <label>Changes to request<textarea autoFocus value={request} onChange={e => {setRequest(e.target.value);authoring.cancel();setNotice('');}} placeholder={intent === 'add-show' ? 'Describe the segments, timing and interactions you want…' : 'Describe the design or show changes you want…'} maxLength={4000} /></label>}
    {intent==='edit-set'&&<section className="set-authoring-generate" aria-label="Generate a Set">
      {import.meta.env.DEV&&<label><input type="checkbox" checked={designMode} onChange={e=>setDesignMode(e.target.checked)}/>Use design compiler</label>}
      {designMode&&<p>{capabilityError||(!target?'Checking app and workspace compatibility…':'Design compiler ready. Existing assets stay on this device; edits preserve the current Set.')}</p>}
      {!designMode&&<p>Generate text and camera layouts, including microphone-reactive voice bars. Browser voice-bar previews use simulated levels; native output uses the existing microphone bus. Automated 3D, data bindings, and Show generation are not supported yet; the manual workflow still supports the full Set schema.</p>}
      <label>Saved Claude connection<select aria-label="Saved Claude connection" value={selected?.connection.id??''} onChange={e=>{setConnectionId(e.target.value);authoring.cancel();}}><option value="" disabled>Choose a saved Claude connection</option>{agents.map(saved=><option key={saved.connection.id} value={saved.connection.id}>{saved.connection.name} · {saved.connection.kind==='agent'?saved.connection.model:''}</option>)}</select></label>
      {!endpoint?<p>Connect a workspace to use a saved Claude connection.</p>:!agents.length&&!connectionError?<p>Add a Claude connection with an API key in Data connections, then return here.</p>:null}
      {connectionError&&<p role="alert">{connectionError} <button onClick={retryConnections}>Retry connections</button></p>}
      {selected?.connection.kind==='agent'&&<p>Output limit: {selected.connection.maxOutputTokens.toLocaleString()} tokens. {designMode?'Compact plans reduce repeated JSON; complex requests can still exceed this limit.':'Two layouts may need 4,096 tokens; adjust the saved connection in Data connections, or request one simple layout.'}</p>}
      <label className="set-authoring-base"><input type="checkbox" checked={useBase} disabled={!!baseIssue} onChange={e=>{setUseBase(e.target.checked);authoring.cancel();}}/>Use current Set as starting point</label>
      {baseIssue&&<p>{baseIssue}</p>}
      <p>{useBase?(designMode?'The prompt and asset-free design context will be sent to your saved Claude connection.':'The prompt and current Set package will be sent to your saved Claude connection.'):'Generate a fresh draft from this prompt using your saved Claude connection.'} Each Generate request uses your provider account.</p>
      <div className="set-authoring-actions"><button disabled={draft.status==='generating'||designMode&&!target||!selected||!request.trim()||generationPrompt.length>4000||!!(useBase&&baseIssue)} onClick={generate}>{draft.status==='generating'?'Generating draft…':'Generate draft'}</button>{draft.status==='generating'&&<button onClick={()=>{authoring.cancel();setNotice('Draft request canceled here. The provider may still finish the request.');}}>Cancel generation</button>}</div>
    </section>}
    {intent==='add-show'&&<p>Automated Show generation is not available yet. Use the manual agent workflow below to create and validate a Show.</p>}
    {import.meta.env.DEV&&intent==='edit-set'&&<section aria-label="Design plan compiler">
      <p>Design plan preview: copy a compact brief, paste your agent’s plan or targeted edits in the manual workflow, then compile and review. This dev profile targets the current renderer; installed-engine compatibility negotiation is still pending.</p>
      <button onClick={()=>void designBrief(doc,request).then(value=>copy(value,'Design brief'))}>Copy design brief</button>
      <button disabled={!draft.text.trim()||draft.status==='generating'} onClick={()=>void compilePlan()}>Compile design plan</button>
    </section>}
    <details><summary>Manual agent workflow</summary>
    <div className="set-authoring-actions"><button onClick={() => void copy(packageJson, 'Package JSON')}>Copy package JSON</button>
      <button onClick={() => void copy(brief(), 'Agent brief')}>Copy agent brief</button></div>
    <details><summary>Configured package JSON</summary><textarea aria-label="Configured package JSON" value={packageJson} readOnly /></details>
    {intent !== 'export' && <><label>Updated package JSON<textarea aria-label="Updated package JSON" value={draft.text} onChange={e => authoring.editCandidate(e.target.value)} placeholder="Paste the complete JSON returned by your agent." /></label><button disabled={!draft.text.trim()} onClick={()=>authoring.validate(intent==='add-show')}>Validate draft</button></>}
    </details>
    {draft.error&&<p role="alert">{draft.error}</p>}
    {draft.package&&<DraftPreview key={draft.package.id+draft.text.length} doc={draft.package} model={draft.model}/>}
    {notice && <p role="status">{notice}</p>}
    <footer><span>Validate → Preview → Load preparation → Rehearse</span>{intent !== 'export' && <button disabled={!draft.package||draft.status!=='ready'} onClick={load}>Load preparation</button>}</footer>
  </dialog>, document.body);
}

function DraftPreview({doc,model}:{doc:PresentationPackage;model?:string}){
 const session=useMemo(()=>new RehearsalSession(doc,undefined,'prepare'),[doc]);
 const state=useSyncExternalStore(session.subscribe,session.snapshot);
 return <section className="set-authoring-preview" aria-label="Validated draft preview"><h3>{doc.name}</h3><p>Validated draft{model?` · ${model}`:''} · {doc.set.layouts.length} layouts · {doc.set.slots.length} source slots · {doc.runtime.instances.length} modules{doc.show?` · ${doc.show.phases.length} Show segments`:''}</p><label>Preview layout<select aria-label="Preview layout" value={state.layoutId} onChange={e=>session.send({type:'control',action:{type:'layout.select',layoutId:e.target.value}})}>{doc.set.layouts.map(layout=><option key={layout.id} value={layout.id}>{layout.label}</option>)}</select></label><SetPreview doc={doc} state={state}/><p>Sources are placeholders. Load into preparation to rehearse and check output readiness.</p></section>;
}
