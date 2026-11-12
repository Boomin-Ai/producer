import type {AssistantEditorRequest} from '../assistant/roomBridge';
import {useSocialRehearsal} from './useSocialRehearsal';
import {SetIntegrationConnections} from './SetIntegrationConnections';
import {integrationRequirements} from './integrationRequirements';
import {layoutViews,preferredViewLayout,viewForLayout} from './layoutViews';
import {useDataConnections} from './useDataConnections';
import {requestModuleData,type ModuleBindings} from './moduleConnections';
import {dataIntegrations,type SavedConnection} from '../../lib/dataIntegrations';
import {OperatorPanel} from '../../../shared/set-runtime/OperatorPanel';
import {ParticipantPanel} from '../../../shared/set-runtime/ParticipantPanel';
import {evaluate as evaluateModule} from '../../../shared/set-runtime/contract';
import '../../../shared/set-runtime/panels.css';
import {ModuleConfiguration} from './ModuleConfiguration';
import {useShowClock} from './showClock';
import {layoutMedia,mediaConfig} from './playback';
import {MediaPlaybackControls} from './MediaPlaybackControls';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type CSSProperties } from 'react';
import { evaluate, RehearsalSession, voteLeaders } from './rehearsal';
import { RehearsalPreview } from './RehearsalPreview';
import {SetPreview} from './SetPreview';
import { outputProjection } from './projection';
import { layoutFieldKeys } from './layoutFields';
import { rundown, timeLabel } from './rundown';
import type { PresentationPackage, SetControl, SlotFraming } from './schema';
import type { SetOutputControls } from './useSetOutput';
import './presentation.css';
import {SetSourceCreator} from './SetSourceCreator';
import {SetSourceRecovery} from './SetSourceRecovery';
import {SetRecoveryNotice} from './SetRecoveryNotice';
import {SetConfiguration} from './SetConfiguration';
import {ControlArrangementEditor,useControlArrangement} from './ControlArrangementEditor';
import {CommittedField} from './CommittedField';
import {NumberSlider} from './NumberSlider';
import {SetMusicControls} from './SetMusicControls';
import {CameraBackgroundControls} from './CameraBackgroundControls';

export type SetEditorTake = {
  phase: string;
  layout: string;
  bindings: Record<string, string>;
  framing: Record<string, SlotFraming>;
};

type PanelProps={
  assistantEditorRequest?:AssistantEditorRequest; onAssistantEditorOpened?:(id:string)=>void;
  endpoint?:string;serverRoomId?:string;preferenceRoomId?:string;moduleBindings?:ModuleBindings;
  voting?:ReactNode; sourceNames?: Record<string,string>; onFieldEdit?: (key:string)=>void; output?: SetOutputControls; session: RehearsalSession; blocked?: boolean; blockedReason?: string;
  onChange: (doc: PresentationPackage, moduleBindings?: ModuleBindings, take?: SetEditorTake) => void | RehearsalSession | Promise<void | RehearsalSession>;
};

type PublishRequest = { previous: RehearsalSession; installed?: RehearsalSession; take: SetEditorTake };
function designIdentity(doc:PresentationPackage) {
  const definitions=(values:PresentationPackage['set']['values'])=>Object.fromEntries(Object.entries(values).map(([key,{default:_,...definition}])=>[key,definition]));
  return JSON.stringify({...doc,set:{...doc.set,initialLayout:'',values:definitions(doc.set.values),feeds:definitions(doc.set.feeds)}});
}
function recordIdentity(record:Record<string,unknown>){return JSON.stringify(Object.entries(record).filter(([,value])=>value!==''&&value!==undefined).sort(([a],[b])=>a.localeCompare(b)));}
function DraftPreparation({session,output,bindings,framing}:{session:RehearsalSession;output?:SetOutputControls;bindings:Record<string,string>;framing:Record<string,import('./schema').SlotFraming>}){
  const state=useSyncExternalStore(session.subscribe,session.snapshot);
  useEffect(()=>{
    if (state.workspaceMode === 'prepare') output?.prepareDraft?.(session.preparedPackage(), bindings, framing, state.show.phase);
  },[session.package,state.workspaceMode,state.layoutId,state.show.phase,JSON.stringify(state.values),JSON.stringify(state.feeds),JSON.stringify(bindings),JSON.stringify(framing)]);
  useEffect(()=>()=>output?.clearDraftPreparation?.(),[]);
  return null;
}
/** Same authored controls on a private session; no output or connection owner. */
export function SetAuthoringControlSurface({session}:{session:RehearsalSession}) {
  return <SetControlsPanelView session={session} preferenceRoomId={`assistant:${session.package.id}`} onChange={()=>{}}/>;
}
export function SetControlsPanel(props:PanelProps) {
  const [assistantRequestReady,setAssistantRequestReady]=useState<string>();
  const [draft,setDraft]=useState(()=>new RehearsalSession(props.session.preparedPackage(),undefined,'prepare'));
  const [moduleBindings,setModuleBindings]=useState<ModuleBindings>(props.moduleBindings??{});
  const {connections,adapters,connectionError,retryConnections}=useDataConnections(props.endpoint);
  const [bindings,setBindings]=useState({...props.output?.bindings});
  const [framing,setFraming]=useState({...props.output?.framing});
  const [requested,setRequested]=useState<PublishRequest>();
  const handled=useRef<PublishRequest>(undefined);
  const publishingRef=useRef(false);
  const [publishError,setPublishError]=useState(''),[publishing,setPublishing]=useState(false);
  const draftState=useSyncExternalStore(draft.subscribe,draft.snapshot);
  const roomState=useSyncExternalStore(props.session.subscribe,props.session.snapshot);
  const sameDesign=useMemo(()=>draft.package===props.session.package||designIdentity(draft.package)===designIdentity(props.session.package),[draft.package,props.session.package]);
  const matches=recordIdentity(moduleBindings)===recordIdentity(props.moduleBindings??{})&&sameDesign&&draftState.layoutId===roomState.layoutId&&draftState.show.phase===roomState.show.phase&&recordIdentity(draftState.values)===recordIdentity(roomState.values)&&recordIdentity(draftState.feeds)===recordIdentity(roomState.feeds)&&recordIdentity(bindings)===recordIdentity(props.output?.bindings??{})&&recordIdentity(framing)===recordIdentity(props.output?.framing??{});
  const onOutput = props.output?.currentPresented ?? props.output?.active;
  const editorStatus=publishing||props.output?.busy&&matches?'applying':publishError||props.output?.error?'error':onOutput&&matches?'applied':'changed';
  useEffect(()=>{
    const next=new RehearsalSession(props.session.preparedPackage(),undefined,'prepare');
    const phase=props.session.snapshot().show.phase;
    const layout=props.session.snapshot().layoutId;
    if(phase)next.send({type:'segment.select',phaseId:phase});
    if(next.snapshot().layoutId!==layout)next.send({type:'control',action:{type:'layout.select',layoutId:layout}});
    setDraft(next);
    setModuleBindings(props.moduleBindings??{});setBindings({...props.output?.bindings});setFraming({...props.output?.framing});
  },[props.session]);
  useEffect(()=>{
    const request=props.assistantEditorRequest;
    if(!request)return;
    setDraft(new RehearsalSession(request.document,undefined,'prepare'));
    // An Assistant return to this same private Set must retain the editor's
    // local source/connection choices, including framing not yet on output.
    if(request.document.id!==draft.package.id){setModuleBindings(props.moduleBindings??{});setBindings({...props.output?.bindings});setFraming({...props.output?.framing});}
    setPublishError('');setAssistantRequestReady(request.id);
  },[props.assistantEditorRequest?.id]);
  const finishPublish = (error?: unknown) => {
    publishingRef.current = false;
    setPublishing(false);
    if (error !== undefined) setPublishError(String(error));
  };
  useEffect(() => {
    if (!requested || handled.current === requested || props.session === requested.previous) return;
    handled.current = requested;
    const output = props.output;
    if (!output || (requested.installed && props.session !== requested.installed)) {
      finishPublish(new Error('The room Set changed before it could be shown. Try again.'));
      return;
    }
    if (!requested.installed) {
      const {phase, layout} = requested.take;
      if (phase) props.session.send({type:'segment.select',phaseId:phase});
      if (props.session.snapshot().layoutId !== layout) props.session.send({type:'control',action:{type:'layout.select',layoutId:layout}});
    }
    void Promise.resolve().then(() => (output.applyConfirmed ?? output.apply)())
      .then(() => finishPublish(), finishPublish);
  }, [requested, props.session, props.output]);
  useEffect(() => {
    if (!requested) return;
    const timer = setTimeout(() => {
      if (handled.current === requested) return;
      handled.current = requested;
      finishPublish(new Error('The room did not load the Set. Try again.'));
    }, 8000);
    return () => clearTimeout(timer);
  }, [requested]);
  const previewOutput=props.output?{...props.output,active:false,busy:false,error:'',bindings,framing,
    bind:(slot:string,id:string)=>setBindings(old=>({...old,[slot]:id})),
    frame:(slot:string,value:import('./schema').SlotFraming)=>setFraming(old=>({...old,[slot]:value})),
    apply:async()=>{},returnToRoom:async()=>true,
    createSource:props.output.createSource?async(slot:string,spec:import('../../lib/sourceSpec').ExtraSpec,label:string)=>{
      const id=await props.output!.createSource!(slot,spec,label,false);if(id)setBindings(old=>({...old,[slot]:id}));
    }:undefined,
  }:undefined;
  const publish=async()=>{
    const state=draft.snapshot();
    const output=props.output;
    if(state.workspaceMode==='rehearsal'||!output||publishingRef.current)return;
    publishingRef.current=true;
    setPublishError('');
    setPublishing(true);
    try {
      const doc=draft.preparedPackage();
      const take = {
        phase: state.show.phase,
        layout: state.layoutId,
        bindings: Object.fromEntries(Object.entries(bindings).filter(([, id]) => !!id)),
        framing,
      };
      if (!output.setAssignments) {
        for(const [key,definition] of Object.entries(doc.set.values))if(definition.default!==props.session.snapshot().values[key])props.onFieldEdit?.(key);
        for(const slot of doc.set.slots){output.bind(slot.id,bindings[slot.id]??'');if(framing[slot.id])output.frame(slot.id,framing[slot.id]);}
      }
      const installed=await props.onChange(doc,moduleBindings,take);
      setRequested({previous:props.session,installed:installed??undefined,take});
    } catch (error) {
      finishPublish(error);
    }
  };
  const workspace = (onClose: () => void) => <>
    <DraftPreparation session={draft} output={props.output} bindings={bindings} framing={framing} />
    <SetControlsPanelView {...props} moduleBindings={moduleBindings} connections={connections} adapters={adapters}
      connectionError={connectionError} onRetryConnections={retryConnections}
      onModuleBinding={(role,binding)=>setModuleBindings(old=>({...old,[role]:binding}))}
      session={draft} output={previewOutput} onFieldEdit={undefined}
      onChange={doc=>setDraft(new RehearsalSession(doc,undefined,'prepare'))} editorOnly
      onPublish={publish} publishError={publishError||props.output?.error||''}
      editorStatus={editorStatus} workspaceBusy={publishing} onWorkspaceClose={onClose} />
  </>;
  return <SetControlsPanelView {...props} connections={connections} adapters={adapters} connectionError={connectionError}
    onRetryConnections={retryConnections} editorOpenRequest={assistantRequestReady===props.assistantEditorRequest?.id?assistantRequestReady:undefined} onEditorRequestOpened={props.onAssistantEditorOpened} workspace={workspace} workspaceBusy={publishing}
    onWorkspaceClose={()=>draft.exitRehearsal()} />;
}
function SetControlsPanelView({ session, blocked = false, blockedReason, onChange, output, sourceNames = {}, voting, onFieldEdit, workspace, workspaceBusy=false, editorOnly=false,onPublish,publishError,onWorkspaceClose,editorStatus='changed',editorOpenRequest,onEditorRequestOpened,endpoint,serverRoomId,preferenceRoomId,moduleBindings={},connections=[],adapters=[],connectionError='',onRetryConnections,onModuleBinding }: PanelProps & {connections?:SavedConnection[];adapters?:import('../../../shared/set-runtime/dataAdapters').DataAdapterManifest[];connectionError?:string;onRetryConnections?:()=>void;onModuleBinding?:(role:string,binding:ModuleBindings[string])=>void;} & {editorOpenRequest?:string;onEditorRequestOpened?:(id:string)=>void;editorStatus?:'changed'|'applying'|'applied'|'error';onWorkspaceClose?:()=>void;workspace?:(onClose:()=>void)=>ReactNode;workspaceBusy?:boolean;editorOnly?:boolean;onPublish?:()=>void;publishError?:string}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const arrangements=useControlArrangement(session.package,JSON.stringify([endpoint??'local',serverRoomId??preferenceRoomId??'preview']));
  const [player, setPlayer] = useState('player-1');
  const rundownId = useId();
  const layoutMenuId = useId();
  const [layoutMenuPosition,setLayoutMenuPosition]=useState({left:12,top:64});
  useShowClock(session);
  useSocialRehearsal(session,endpoint,moduleBindings,connections,state.workspaceMode);
  // Fast Refresh can retain a session built by the previous runtime module.
  // Replace that rehearsal instance while retaining its prepared configuration.
  const staleSession = !(session instanceof RehearsalSession);
  useEffect(() => {
    if (staleSession) onChange((session as RehearsalSession).exportPreparedPackage());
  }, [staleSession, session, onChange]);
  if (staleSession) return <div className="set-controls"><p role="status">Updating rehearsal controls…</p></div>;
  const doc = session.package;
  const missingConnections = useMemo(
    () => integrationRequirements(doc).filter(requirement => !requirement.optional && !moduleBindings[requirement.role]?.id),
    [doc, moduleBindings],
  );
  const views=layoutViews(doc.set),selectedView=viewForLayout(doc.set,state.layoutId);
  const viewReadiness=(view:typeof views[number])=>{const statuses=[...new Set(output?.requiredOrientations?output.requiredOrientations.map(o=>view.variants[o]??preferredViewLayout(view)):Object.values(view.variants))].map(id=>output?.layoutReadiness?.[id]);return statuses.find(s=>s?.state==='error')??statuses.find(s=>s&&s.state!=='ready')??statuses.find(Boolean);};
  const hasHostMedia=[...layoutMedia(doc,state.layoutId,false,state)].some(id=>mediaConfig(doc,id).hostControls);
  const rehearsing = state.workspaceMode === 'rehearsal';
  const modulesReady=!doc.runtime.instances.length||state.moduleConnection==='live';
  const canRun = editorOnly || !!output?.active&&modulesReady;
  const outputStatus = output?.active
    ? output.busy && output.pendingChange === 'set' ? 'Switching set…'
      : output.busy && output.pendingChange === 'segment' ? 'Switching segment…'
      : 'Set on output'
    : output?.busy ? 'Preparing set…' : 'Room scene on output';
  const canReturnToScene = output?.active || output?.busy;
  const outputAction = canReturnToScene ? 'Show room scene' : 'Show set';
  const showControls = doc.set.controls.filter(c => c.type === 'button' && c.action.type.startsWith('show.'));
  const layoutControls = doc.set.controls.filter(c => c.type === 'button' && !c.action.type.startsWith('show.'));
  const actionControls=layoutControls.filter(c=>c.type==='button'&&c.action.type!=='layout.select');
  const fields = doc.set.controls.filter(c => c.type !== 'button');
  const activeFieldKeys=layoutFieldKeys(doc,state.layoutId);
  const layoutFields=fields.filter(c=>activeFieldKeys.has(c.key));
  const visualControls=actionControls.filter(c=>c.type==='button'&&c.action.type==='value.set'&&activeFieldKeys.has(c.action.key));
  const activeLayout=doc.set.layouts.find(layout=>layout.id===state.layoutId);
  const stopped = !state.running && state.trace.some(entry => entry.message.startsWith('Show started'));
  const phase = doc.show?.phases.find(p => p.id === state.show.phase);
  const nextPhase = doc.show?.phases.find(p => p.id === phase?.next);
  const previousPhase = doc.show?.phases.find(p => p.next === phase?.id);
  const navigateDisabled=blocked||!editorOnly&&!modulesReady||!state.running||state.paused||state.show.collecting||!!phase?.collectMs&&!state.show.revealed;
  const restart=()=>{if(state.workspaceMode==='prepare'){if(editorOnly)session.enterRehearsal();else session.enterLive();}session.send({type:'reset'});session.send({type:'control',action:{type:'show.start'}});};
  const startShow=()=>{
    if(!canRun)return;
    if(state.workspaceMode==='prepare'){if(editorOnly)session.enterRehearsal();else session.enterLive();}
    const initial=doc.show?.phases.find(p=>p.id===doc.show?.initialPhase);
    if(initial?.layoutId)session.send({type:'control',action:{type:'layout.select',layoutId:initial.layoutId}});
    session.send({type:'control',action:{type:'show.start'}});
  };
  const transport=<div className="set-transport" role="group" aria-label="Show playback">
    <button title="Previous segment" aria-label="Previous segment" disabled={navigateDisabled||!previousPhase} onClick={()=>session.send({type:'control',action:{type:'show.previous'}})}>⏮</button>
    <button className="set-transport-play" title={!canRun?'Show the set on room output first':state.running&&!state.paused?'Pause':'Play'} aria-label={!canRun?'Show the set on room output first':state.running&&!state.paused?'Pause':state.running?'Resume':'Start show'} disabled={blocked||!canRun} onClick={()=>{if(!state.running)startShow();else session.send({type:'pause',paused:!state.paused});}}>{state.running&&!state.paused?'Ⅱ':'▶'}</button>
    <button title="Next segment" aria-label="Next" disabled={navigateDisabled||!nextPhase} onClick={()=>session.send({type:'control',action:{type:'show.next'}})}>⏭</button>
    <button className="set-transport-stop" title="Stop run" aria-label="Stop run" disabled={!state.running||blocked} onClick={()=>session.send({type:'stop'})}>■</button>
    <button title="Restart show" aria-label="Restart show" disabled={blocked||!canRun} onClick={restart}>↻</button>
  </div>;
  const schedule = rundown(doc);
  const displayedStepIndex = schedule.phases.findIndex(p => p.id === phase?.id);
  const runStatus = state.running ? state.paused ? 'Paused' : 'Running' : stopped ? 'Run stopped' : rehearsing ? 'Ready to start' : 'Ready to start show';
  const needsRevealHint = state.running && !state.paused && phase?.collectMs && !state.show.collecting && !state.show.revealed;
  const collecting = state.running && !!phase?.collectMs && state.show.collecting;
  const tied = state.show.total > 0 && voteLeaders(state).length > 1;
  const unresolved = state.running && !!phase?.collectMs && !state.show.collecting && !state.show.revealed;
  const resultLabel = state.show.result === 'draw' ? 'Draw · No winner awarded' : `Winner · ${state.show.winner}`;
  const segmentControls = showControls.filter(c => c.type === 'button' &&
    (c.action.type === 'show.reveal' ? unresolved && !tied : ['show.reopen', 'show.tiebreak', 'show.draw'].includes(c.action.type) ? false :
      ['show.vote', 'show.react'].includes(c.action.type) && collecting));
  const runControls = showControls.filter(c => c.type === 'button' &&
    (c.action.type === 'show.start' ? !state.running : c.action.type === 'show.next' && state.running && !!phase?.next &&
      !state.show.collecting && (!phase.collectMs || state.show.revealed)));
  if(doc.show&&!showControls.some(c=>c.type==='button'&&c.action.type==='show.start')&&!state.running)runControls.push({id:'builtin-show-start',type:'button',label:'Start show',action:{type:'show.start'}});
  if(doc.show&&!showControls.some(c=>c.type==='button'&&c.action.type==='show.next')&&state.running&&phase?.next&&!state.show.collecting&&(!phase.collectMs||state.show.revealed))runControls.push({id:'builtin-show-next',type:'button',label:'Next',action:{type:'show.next'}});
  const hint = tied ? 'Tied vote. Reopen voting, start a fresh tie-break, or reveal a draw to continue.' : state.show.total ? 'Voting is closed. Reveal the winner or reopen voting.' : 'No votes yet. Reopen voting to collect responses.';
  function renderControl(c: SetControl) {
    if (c.when !== undefined && !evaluate(c.when, state, {}, 64, doc.set.tokens)) return null;
    if (c.type === 'button') {
      let disabled = blocked || !!state.controlPending || c.enabled !== undefined && !evaluate(c.enabled, state, {}, 64, doc.set.tokens);
      if (c.action.type === 'show.start') disabled ||= state.running;
      if (c.action.type === 'show.next') disabled ||= !state.running || state.paused || state.show.collecting ||
        !doc.show?.phases.find(p => p.id === state.show.phase)?.next ||
        !!doc.show.phases.find(p => p.id === state.show.phase)?.collectMs && !state.show.revealed;
      if (c.action.type === 'show.reveal') disabled ||= !state.running || state.paused || state.show.collecting || state.show.revealed || !state.show.total;
      return <button key={c.id} className={c.action.type.startsWith('show.') ? 'set-show-action' : undefined}
        aria-label={c.label} aria-pressed={c.action.type === 'layout.select' ? state.layoutId === c.action.layoutId : c.action.type==='value.set'?state.values[c.action.key]===c.action.value:undefined} disabled={disabled} onClick={() => session.send({ type: 'control', action: c.action })}>
        {c.label}</button>;
    }
    const def = doc.set.values[c.key];
    if(c.type==='number'&&c.presentation==='slider'&&def.type==='number')return <NumberSlider key={c.id} owner={session} label={c.label} value={Number(state.values[c.key])} min={def.min} max={def.max} step={c.step} unit={c.unit} defaultValue={def.default} disabled={blocked} pending={!!state.controlPending} isPending={()=>!!session.snapshot().controlPending}
      onCommit={value=>{onFieldEdit?.(c.key);return session.send({type:'field',key:c.key,value});}}/>;
    if(c.type==='text'&&c.presentation==='color')return <CommittedField key={c.id} label={c.label} presentation="color" field={session.package.set.values[c.key]} value={state.values[c.key]} disabled={blocked} pending={!!state.controlPending} onApply={value=>{onFieldEdit?.(c.key);return session.send({type:'field',key:c.key,value});}}/>;
    if(session.hasRoomControl())return <CommittedField key={c.id} label={c.label} field={def} value={state.values[c.key]} disabled={blocked} pending={!!state.controlPending} onApply={value=>{onFieldEdit?.(c.key);return session.send({type:'field',key:c.key,value});}}/>;
    return <label key={c.id}>{c.label}<input aria-label={c.label} type={c.type === 'number' ? 'number' : 'text'}
      disabled={blocked} value={String(state.values[c.key])} maxLength={def.type === 'text' ? def.maxLength : undefined}
      min={def.type === 'number' ? def.min : undefined} max={def.type === 'number' ? def.max : undefined}
      onChange={e => { onFieldEdit?.(c.key); session.send({ type: 'field', key: c.key, value: c.type === 'number' ? Number(e.target.value) : e.target.value }); }} /></label>;
  }
  function control(c: SetControl) {
    try { return renderControl(c); }
    catch { return <span key={c.id} className="set-error">{c.label}: binding unavailable.</span>; }
  }
  const visibleSlots = new Set<string>();
  const visit = (node:ReturnType<typeof outputProjection>['root']) => { if(node.slotId)visibleSlots.add(node.slotId);node.children.forEach(visit); };
  try { visit(outputProjection(doc,state).root); } catch { /* Preview surfaces binding errors. */ }
  const sourceEditor = <details className="set-source-slots" open><summary>Source slots <span>{visibleSlots.size}</span></summary>
              {output ? <div className="set-editor-sources">{doc.set.slots.filter(slot=>visibleSlots.has(slot.id)).map((slot,index) => <div className="set-source-card" key={slot.id}><h4><span>{index+1}</span>{slot.label}</h4><div className="set-source-picker"><select aria-label={`${slot.label} source`} disabled={output.busy&&!output.active} value={output.bindings[slot.id] ?? ''} onChange={e => output.bind(slot.id,e.target.value)}>
                <option value="">Empty slot</option>
                {(output.sources.items ?? []).filter(item => item.kind!=='mic').map(item => <option key={item.id} value={item.id} disabled={output.renderer!=='native'&&(!item.visible || !item.has_frame)}>{sourceNames[item.id] ?? item.label}{!item.visible ? ' · off scene' : !item.has_frame ? ' · waiting for video' : ''}</option>)}
              </select>{output.createSource&&<SetSourceCreator slot={slot.id} label={slot.label} create={output.createSource}/>}</div><SlotFramingControls label={slot.label} value={output.framing[slot.id] ?? findSlotFraming(doc.set.layouts.find(l=>l.id===state.layoutId)?.root,slot.id)} disabled={output.busy&&!output.active} onChange={value=>output.frame(slot.id,value)} /></div>)}</div> : <ul>{doc.set.slots.filter(slot=>visibleSlots.has(slot.id)).map(slot => <li key={slot.id}><strong>{slot.label}</strong><span>Sample video</span></li>)}</ul>}
              <p className="set-section-note">{output ? output.renderer==='native'?'Choose a source or add one here. Creating a source does not place it on the room scene. Audio follows the room mixer.':'Assign sources already on the room output. Empty slots stay empty; audio follows the room mixer.' : 'This preview uses sample video.'}</p>
            </details>;
  const editorSegments=[...schedule.phases,...(doc.show?.phases??[]).filter(p=>!schedule.phases.some(known=>known.id===p.id))];
  const editorIndex=editorSegments.findIndex(p=>p.id===state.show.phase);
  const editSegment=(id:string)=>{session.send({type:'segment.select',phaseId:id});};
  const ready=(layout:string)=>output?.layoutReadiness?.[layout];
  const readinessLabel=(layout:string)=>{const status=ready(layout);return !status?'':status.state==='ready'?'Ready':status.state==='error'?'Layout needs attention — see recovery details':'Loading layout';};
  const segmentList = (compact = false) => <ol>{schedule.phases.map((step, index) =>
    <li key={step.id} aria-current={index === displayedStepIndex ? 'step' : undefined}
      data-readiness={ready(step.layoutId)?.state} title={readinessLabel(step.layoutId)}
      className={index === displayedStepIndex ? 'current' : state.running && index < displayedStepIndex ? 'passed' : ''}>
      <button type="button" className="set-segment-select" onClick={event => {
        editSegment(step.id);
        if (compact) event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
      }}>
        <span className="set-step-number">{String(index + 1).padStart(2, '0')}</span>
        <span>{step.label}</span>
        <small>{step.collectMs ? `${timeLabel(step.collectMs)} vote` : 'Manual'}</small>
      </button>
    </li>)}</ol>;
  const modulePanel=(controlRefs?:readonly string[],compact=false,includeRuntimeControls=controlRefs===undefined)=><OperatorPanel controlRefs={controlRefs} compact={compact} includeRuntimeControls={includeRuntimeControls} definition={doc.runtime} snapshot={session.moduleSnapshot()} segment={state.show.phase} disabled={blocked||state.workspaceMode==='prepare'||state.moduleConnection==='connecting'||state.moduleConnection==='error'} send={session.sendModule} searchWeatherLocations={endpoint?async query=>(await dataIntegrations.locations(endpoint,query)).locations:undefined} simulateWeather={rehearsing?async(module,condition,isDay)=>{const snapshot=session.moduleSnapshot(),now=Date.now();return session.receiveModuleData({id:crypto.randomUUID(),setEpoch:snapshot.setEpoch,module,epoch:snapshot.modules[module].epoch,op:'weather.update',input:{locationRevision:snapshot.modules[module].weatherLocationRevision??0,observedAt:now,temperature:condition==='snow'?-4:18,condition,isDay,wind:12,precipitation:['rain','snow','storm'].includes(condition)?3:0,provider:'Rehearsal',location:snapshot.modules[module].weather?.location??'Preview location',units:'celsius'}});}:undefined} requestAgent={endpoint?(module,question,refresh)=>requestModuleData(session,module,question,endpoint,serverRoomId,moduleBindings,connections,refresh):undefined}/>;
  const moduleControls=doc.runtime.instances.length>0&&<>
    {modulePanel()}
    {state.moduleError&&<p role="alert">{state.moduleError}</p>}
    {rehearsing&&<><label>Simulated participant<input value={player} onChange={e=>setPlayer(e.target.value)}/></label><button onClick={()=>setPlayer(`player-${crypto.randomUUID().slice(0,8)}`)}>New participant</button><ParticipantPanel snapshot={session.moduleParticipantSnapshot()} simulation onCommand={command=>session.sendModule(command.module,command.op,command.input,player)}/></>}
  </>;
  const controlVisible=(ref:string):boolean=>{
    if(ref==='builtin:layout')return true;
    const entry=arrangements.catalog.controls.find(c=>c.id===ref);
    if(!entry)return false;
    if(entry.kind==='operator'){const item=doc.set.operatorComponents?.find(c=>c.id===entry.controlId);return !!item&&(item.when===undefined||!!evaluate(item.when,state,{},64,doc.set.tokens));}
    if(entry.kind==='module'){
      const instance=doc.runtime.instances.find(i=>i.id===entry.moduleId),snapshot=session.moduleSnapshot();
      if(!instance||(instance.owner!=='set'&&instance.segment!==state.show.phase)||!snapshot.modules[instance.id])return false;
      if(entry.controlId.startsWith('$'))return true;
      const item=doc.runtime.definitions[instance.definition].controls.filter(g=>g.audience==='operator').flatMap(g=>g.controls).find(c=>c.id===entry.controlId);
      return !!item&&(!item.segment||item.segment===state.show.phase)&&(item.when===undefined||evaluateModule(item.when,snapshot.modules[instance.id].values,{},{})===true);
    }
    const item=doc.set.controls.find(c=>c.id===entry.controlId);
    if(!item||item.type!=='button'&&!activeFieldKeys.has(item.key))return false;
    if(item.type==='button'&&['show.vote','show.react'].includes(item.action.type)&&(!editorOnly||!collecting))return false;
    try{return item.when===undefined||!!evaluate(item.when,state,{},64,doc.set.tokens);}catch{return true;}
  };
  const arrangedControl=(ref:string,compact=false):ReactNode=>{
    if(!controlVisible(ref))return null;
    if(ref==='builtin:layout')return <div key={ref} className="set-layout-picker" role="group"
      aria-label={compact?'Minimized layouts':'Set layouts'} data-control-ref={ref}>
      {views.map(view => {
        const readiness = viewReadiness(view);
        const layoutId = preferredViewLayout(view);
        return <button key={view.id} type="button" aria-pressed={selectedView?.id === view.id}
          data-layout-id={layoutId} data-readiness={readiness?.state} disabled={blocked || !!state.controlPending}
          title={readiness?.state === 'error' ? `${view.label} · Needs attention` : readiness?.state === 'loading' ? `${view.label} · Loading…` : view.label}
          onClick={() => session.send({type:'control',action:{type:'layout.select',layoutId}})}>{view.label}</button>;
      })}
    </div>;
    const entry=arrangements.catalog.controls.find(c=>c.id===ref);
    if(!entry)return null;
    if(entry.kind==='operator'){const item=doc.set.operatorComponents!.find(c=>c.id===entry.controlId)!;return <div key={ref} className="set-arranged-operator" data-control-ref={ref}><SetMusicControls definition={item} compact={compact} disabled={blocked||editorOnly||rehearsing||!output}/></div>;}
    if(entry.kind==='module')return <div key={ref} className="set-arranged-module" data-control-ref={ref}>{modulePanel([ref],compact)}</div>;
    const item=doc.set.controls.find(c=>c.id===entry.controlId);
    if(!item)return null;
    if(item.type!=='button'&&!activeFieldKeys.has(item.key))return null;
    if(item.type==='button'&&['show.vote','show.react'].includes(item.action.type)&&(!editorOnly||!collecting))return null;
    return <div key={ref} className="set-arranged-control" data-control-ref={ref}>{control(item)}</div>;
  };
  const visibleLayoutIds = new Set(views.map(preferredViewLayout));
  const redundantLayoutControls = new Set(doc.set.controls.flatMap(item =>
    item.type === 'button' && item.action.type === 'layout.select' && item.when === undefined && item.enabled === undefined &&
    visibleLayoutIds.has(item.action.layoutId) ? [`set:${item.id}`] : []));
  const expandedControlVisible = (ref: string) => (doc.show || ref !== 'builtin:layout') && !redundantLayoutControls.has(ref) && controlVisible(ref);
  const arrangedExpanded=<div className="set-arranged-sections">{arrangements.arrangement.sections.filter(section=>section.controls.some(expandedControlVisible)).map(section=><section key={section.id} className="set-arranged-section" data-purpose={section.purpose} data-section-id={section.id}>
    <h4><button type="button" aria-expanded={!section.collapsed} aria-label={`${section.collapsed?'Expand':'Collapse'} ${section.label} section`} onClick={()=>arrangements.update({...arrangements.preferences,collapsed:{...arrangements.preferences.collapsed,[section.id]:!section.collapsed}})}><span>{section.collapsed?'▸':'▾'}</span>{section.label}</button></h4>
    <div className="set-arranged-section-controls" hidden={section.collapsed}>{section.controls.filter(expandedControlVisible).map(ref=>arrangedControl(ref))}</div>
  </section>)}</div>;
  const editor = <>
        <div className="set-editor-details-header"><strong>{doc.show?'Segment details':'Set details'}</strong><p>{editorOnly?'Changes stay in this preview until you show the set on output.':'Changes update room output.'}</p></div>
        <section className="set-editor-navigation" aria-label={doc.show?'Segment navigation':'Layout navigation'}>
          {doc.show&&<div className="set-editor-segment-row"><label>Segment<select aria-label="Edit segment" disabled={blocked} value={state.show.phase} onChange={e=>editSegment(e.target.value)}>{editorSegments.map((segment,i)=><option key={segment.id} value={segment.id}>{String(i+1).padStart(2,'0')} / {segment.label}</option>)}</select></label>
          <div className="set-editor-segment-buttons"><button type="button" aria-label="Edit previous segment" title="Previous segment" disabled={blocked||editorIndex<=0} onClick={()=>editSegment(editorSegments[editorIndex-1].id)}>←</button><button type="button" aria-label="Edit next segment" title="Next segment" disabled={blocked||editorIndex>=editorSegments.length-1} onClick={()=>editSegment(editorSegments[editorIndex+1].id)}>→</button></div></div>}
          {doc.set.layouts.length>1&&<label>Layout<select aria-label="Edit layout" disabled={blocked} value={state.layoutId} onChange={e=>session.send({type:'control',action:{type:'layout.select',layoutId:e.target.value}})}>{doc.set.layouts.map(layout=><option key={layout.id} value={layout.id}>{layout.label} · {layout.width>layout.height?'Landscape':layout.height>layout.width?'Portrait':'Square'}</option>)}</select></label>}
          {state.running&&<p className="set-section-note">{state.paused?'Rehearsal paused for editing.':'Choosing another segment pauses rehearsal.'}</p>}
        </section>
        {onModuleBinding&&<SetIntegrationConnections doc={doc} endpoint={endpoint} connections={connections} adapters={adapters} bindings={moduleBindings} onBind={onModuleBinding} error={connectionError} onRetry={onRetryConnections} disabled={rehearsing||blocked}/>}
        <ModuleConfiguration doc={doc} segment={state.show.phase||undefined} onChange={onChange} disabled={blocked||rehearsing}/>{state.workspaceMode==='prepare'&&doc.runtime.instances.some(i=>doc.runtime.definitions[i.definition].behavior?.type==='weather')&&<p className="set-section-note">Live module controls are available in the room. To change the live city, close Set edit and use Weather desk. Rehearse to test changes privately.</p>}{moduleControls}
        <section className="set-setup" aria-label="Set editing controls">
          <details key={`${state.sandboxId}-setup`} open><summary><strong>Content & sources</strong><span>Changes update the set</span></summary>
            {rehearsing&&<p className="set-section-note">Rehearsal edits reset on exit. Sources stay saved.</p>}
            <h3 className="set-editor-heading">Content <span>{activeLayout?.label}</span></h3>
            <div className="set-controls-fields">{layoutFields.map(control)}{!layoutFields.length&&!visualControls.length && <p className="set-section-note">This layout has no editable content.</p>}</div>
            {visualControls.length>0&&<section aria-label="Preview visual controls"><h3 className="set-editor-heading">Visual controls</h3><div className="set-layout-actions">{visualControls.map(control)}</div></section>}

            <MediaPlaybackControls session={session} edit />
            {doc.show&&activeLayout?.animation&&<details className="set-section"><summary>Animation</summary><p className="set-section-note">{doc.show?'Pause the show to scrub this segment. Reset rehearsal returns to the beginning.':'Animation follows the selected layout.'}</p><label>Animation position<input aria-label="Animation position" type="range" min="0" max={Math.max(1000,...activeLayout.animation.tracks.map(t=>(t.delayMs??0)+t.keyframes[t.keyframes.length-1].atMs))} step="10" value={state.animationClock?.segmentMs??0} disabled={!rehearsing||!state.running||!state.paused} onChange={e=>session.send({type:'seek',milliseconds:Number(e.target.value)})}/></label></details>}
          </details>
        </section>

  </>;
  if(editorOnly)return <>
    <SetConfiguration hideOutputAction session={session} onChange={onChange} output={output?{...output,apply:async()=>onPublish?.()}:undefined} actions={<div className="set-editor-top-actions">
      {(doc.show||doc.runtime.instances.length>0)&&<button type="button" disabled={workspaceBusy} onClick={()=>{if(rehearsing)session.exitRehearsal();else if(doc.show)startShow();else session.enterRehearsal();}}>{rehearsing?'Exit rehearsal':'Rehearse'}</button>}
      <div className="set-editor-publish" role="group" aria-label="Room output">
        <span role="status" className={`set-editor-apply-status ${rehearsing?'practice':editorStatus}`}>{rehearsing?'Private rehearsal':editorStatus==='applied'?'✓ On output':editorStatus==='applying'?'Applying to room…':editorStatus==='error'?'Update failed':'Changes not on output'}</span>
        <button type="button" className="set-editor-apply" disabled={rehearsing||!output||editorStatus==='applying'||editorStatus==='applied'} onClick={onPublish}>{editorStatus==='applying'?'Applying…':'Show on output'}</button>
      </div>
      {onWorkspaceClose&&<button type="button" className="set-editor-close" disabled={workspaceBusy} onClick={onWorkspaceClose}>Close editor</button>}
    </div>}/>
    {doc.show&&rehearsing&&<div className="set-editor-run-tools">{transport}</div>}
    {publishError&&<p role="alert">{publishError}</p>}
    <div className="set-editor-layout has-controls" style={{'--set-preview-aspect':activeLayout!.width/activeLayout!.height} as CSSProperties}>
      <div className="set-editor-preview-viewport"><div className="set-preview-dialog-canvas"><SetPreview doc={doc} state={state} output={output}/></div></div>
      <aside className="set-controls set-editor-controls" aria-label="Edit set">{editor}
        {rehearsing&&doc.show&&doc.show.choices.length>0&&<section className="set-rehearsal-inputs"><strong>Simulated audience</strong><input aria-label="Simulated player" value={player} onChange={e=>setPlayer(e.target.value)}/>
          <button onClick={()=>setPlayer(`player-${crypto.randomUUID().slice(0,8)}`)}>New participant</button>
          {(doc.show.choices??[]).map(choice=><button key={choice.id} disabled={!collecting||state.paused} onClick={()=>session.send({type:'vote',playerId:player,choiceId:choice.id})}>Vote {choice.label}</button>)}
          <button disabled={!collecting||state.paused} onClick={()=>session.send({type:'reaction',playerId:player})}>React 🔥</button>
          {collecting&&<button onClick={()=>session.send({type:'tick',milliseconds:state.show.remainingMs})}>Close voting</button>}
          {segmentControls.filter(c=>c.type==='button'&&c.action.type==='show.reveal').map(control)}
        </section>}
      </aside>
    </div>
    {visibleSlots.size>0&&<section className="set-controls set-editor-source-tray" aria-label="Edit source assignments">{sourceEditor}</section>}
  </>;
  if (blocked) return <div className="set-controls"><p>{blockedReason ?? 'Waiting for the room to finish loading.'}</p></div>;
  return <div className={`set-controls${doc.show?'':' set-controls--standalone'}`} data-output-busy={output?.busy?'true':'false'} data-layouts-ready={Object.values(output?.layoutReadiness??{}).filter(s=>s.state==='ready').length} data-layouts-total={Object.keys(output?.layoutReadiness??{}).length} data-controls-total={Object.keys(output?.controlReadiness??{}).length} data-controls-ready={Object.values(output?.controlReadiness??{}).filter(s=>s.state==='ready').length}>
    <header className="set-controls-toolbar">
      <div className="set-header-main">
      <span className={`set-mode-badge ${rehearsing ? 'rehearsal' : 'prepared'}`}>{rehearsing ? 'Rehearsal' : state.workspaceMode==='live'&&state.running?'Show':'Prepared'}</span>
      <strong className="set-current-name" title={doc.name}>{doc.name}</strong>
      </div>
      <div className="set-header-mode">
      <span className="set-capability">{doc.show ? "Show attached" : "Set only"}</span>
      {doc.show&&<button className="set-mode-action" disabled={!canRun||state.running} onClick={startShow}>Start show</button>}
      </div>
      {output && <div className="set-output-actions">
        <button type="button" className="set-output-switch" data-output={output.busy?'busy':output.active?'set':'scene'}
          aria-label={outputAction} title={`${outputStatus} · ${outputAction}`}
          onClick={() => void (canReturnToScene ? output.returnToRoom() : output.apply())}>
          <span className="set-output-cue" aria-hidden="true">{outputStatus}</span>
          <span className="set-output-action">{outputAction}</span>
          <span className="set-output-action-short" aria-hidden="true">{canReturnToScene?'Room scene':'Show set'}</span>
          <svg className="set-output-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M2 4h12v8H2zM5.5 14h5M8 12v2"/>
          </svg>
        </button>
        <span className="set-output-announcement" role="status">{outputStatus}</span>
      </div>}
      {!doc.show && views.length > 1 && <div className="set-primary-layout">
        {arrangedControl('builtin:layout')}
        <button type="button" className="set-layout-menu-trigger" aria-label="Choose layout" title={`Layout · ${selectedView?.label??'Choose layout'}`} popoverTarget={layoutMenuId}
          onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();setLayoutMenuPosition({left:Math.max(8,Math.min(rect.left,window.innerWidth-296)),top:Math.max(8,Math.min(rect.bottom+8,window.innerHeight-240))});}}>
          <span>{selectedView?.label??'Layout'}</span><svg className="set-layout-menu-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="1.5" y="2" width="13" height="12" rx="1.5"/><path d="M1.5 6h13M7 6v8"/></svg><span aria-hidden="true">⌄</span>
        </button>
        <div id={layoutMenuId} popover="auto" className="set-layout-menu" role="dialog" aria-label="Choose Set layout" style={layoutMenuPosition}
          onClick={event=>{if((event.target as HTMLElement).closest('button[data-layout-id]'))event.currentTarget.hidePopover();}}>
          <strong>Layouts</strong>{arrangedControl('builtin:layout')}
        </div>
      </div>}
      {doc.show && <div className="set-fixed-playback">{transport}</div>}
      {doc.show && <button type="button" className="set-rundown-trigger" popoverTarget={rundownId} aria-label="Show rundown" title={phase?.label}>
        <span>{String(displayedStepIndex + 1).padStart(2, '0')}/{schedule.phases.length}</span>
        <strong>{phase?.label}</strong>
        <span aria-hidden="true">▾</span>
      </button>}
      <div className="set-compact-run" aria-label={doc.show?'Compact show controls':'Compact set controls'}>
        {arrangements.arrangement.minimized.filter(ref => doc.show || ref !== 'builtin:layout').map(ref=>arrangedControl(ref,true))}

      </div>
      <div className="set-toolbar-tools">
        <ControlArrangementEditor value={arrangements} fixedLayout={!doc.show} redundantLayoutControls={redundantLayoutControls}/>
        <RehearsalPreview openRequest={editorOpenRequest} onOpenRequest={onEditorRequestOpened} doc={doc} state={state} output={output} outputActive={output?.active} workspace={workspace} workspaceBusy={workspaceBusy} onEditorClose={onWorkspaceClose} configuration={<SetConfiguration session={session} onChange={onChange} output={output}/>} editor={editor} sources={visibleSlots.size ? sourceEditor : undefined} />
      </div>
    </header>
    {session.hasRoomControl()&&<p role="status">{state.controlPending?"Sending room command…":"Shared room controls · changes require output confirmation"}</p>}
    {state.controlError&&<p role="alert" className="set-error">{state.controlError}</p>}
    {missingConnections.length > 0 && (
      <p className="set-section-note">
        Choose a connection for {missingConnections.map(requirement => requirement.label).join(", ")} in Set → Data connections.
      </p>
    )}
    {doc.runtime.instances.length>0&&state.workspaceMode==='live'&&state.moduleConnection!=='live'&&<p role="status" className={state.moduleError?'set-error':'set-section-note'}>{!endpoint||!serverRoomId?'Connect this room to a workspace to use live modules.':state.moduleError?`Modules disconnected — reconnecting. ${state.moduleError}`:'Connecting live controls…'}</p>}
    {output&&<SetSourceRecovery slots={doc.set.slots} output={output} names={sourceNames} blocked={blocked}/>}
    {output&&<SetRecoveryNotice key={state.sandboxId} doc={doc} layout={state.layoutId} output={output} names={sourceNames} blocked={blocked}/>}
    {state.trace[state.trace.length - 1]?.message.startsWith('Rejected:') && <p role="status" className="set-error">{state.trace[state.trace.length - 1]!.message}</p>}
    {!editorOnly && doc.set.controlArrangement?.cameraBackground !== false && output?.cameraBackground && <section className="set-camera-backgrounds" aria-label="Camera backgrounds">
      {doc.set.slots.filter((slot,index,slots) => visibleSlots.has(slot.id) && output.sources.items?.some(item => item.id === output.bindings[slot.id] && item.kind === 'camera') && !slots.slice(0,index).some(previous => visibleSlots.has(previous.id) && output.bindings[previous.id] === output.bindings[slot.id])).map(slot =>
        <CameraBackgroundControls key={`${slot.id}:${output.bindings[slot.id]}`} slot={slot.id} source={output.bindings[slot.id]} label={slot.label}
          controls={output.cameraBackground!} disabled={blocked || !output.active || state.workspaceMode !== 'live'} />)}
    </section>}
    <div className={`set-sections ${rehearsing ? 'is-rehearsing' : 'is-prepared'}${doc.show ? ' has-show' : ' set-only'}${hasHostMedia ? ' has-media' : ''}`}>
      {!doc.show && <>
        <section className="set-manual-controls" aria-label="Set controls">
          {arrangedExpanded}
          {hasHostMedia&&<MediaPlaybackControls session={session}/>}
          {voting&&!doc.runtime.instances.some(i=>doc.runtime.definitions[i.definition].behavior?.type==='vote')&&<section className="set-room-voting" aria-label="Room voting"><h3>Voting</h3>{voting}</section>}
        </section>
      </>}
      {doc.show && <section className="set-run" aria-label="Run">
        <div className="set-run-transport">
          <div className="set-run-topline">
            <h3><strong>Show run</strong></h3>
            <span className="set-run-current-label" title={phase?.label}>{phase?.label}</span>
            <span role="status" className={`set-run-status${state.running ? state.paused ? ' is-paused' : ' is-running' : ''}`}>{runStatus}</span>
          </div>
          {doc.show ? <>
            <div className="set-run-overview">
              <div className="set-run-description">
                <h4 className="set-current-segment">{phase?.label}</h4>
                <span className="set-segment-countdown">{state.show.collecting&&<>{timeLabel(state.show.remainingMs)} <small>left</small></>}</span>
                <p className="set-next-step">{nextPhase ? `Up next: ${nextPhase.label}` : 'Final step'}</p>
                <span className="set-segment-position">Segment {displayedStepIndex + 1}/{schedule.phases.length}</span>
              </div>
            </div>

          </> : <><strong>Set rehearsal</strong><p className="set-rehearsal-note">Try layouts and content here. Test data is in Set settings.</p></>}
        </div>
        {doc.show && <>
          <div className="set-segments" role="region" aria-label="Show segments">
            <h3 className="set-segments-heading">Segments<span>{schedule.phases.length} segments</span></h3>
            <div className="set-segments-scroll" role="region" tabIndex={0} aria-label="Segment list">
              {segmentList()}
              <div className="set-run-timing">
                <span className="set-rehearsal-note">{schedule.repeats ? 'Repeating · No fixed total' : schedule.timedMs ? `${timeLabel(schedule.timedMs)} timed${schedule.manual ? ' + manual steps' : ''}` : 'Manual timing'}</span>
                <span className="set-rehearsal-note">{state.workspaceMode==='live'?`Elapsed ${timeLabel(state.elapsedMs)}`:rehearsing?`Elapsed ${timeLabel(state.elapsedMs)} · Simulated clock`:'Ready to start'}</span>
              </div>
            </div>
          </div>
        </>}
      </section>}
      {doc.show && <section className="set-participation" aria-label="Segment controls">
        <h3>Segment controls <span>{rehearsing ? 'Rehearsal' : state.workspaceMode==='live'&&state.running?'Show':'Prepared'}</span></h3>
        {hasHostMedia&&<div className="set-segment-media"><MediaPlaybackControls session={session}/></div>}
        {arrangedExpanded}<strong className="set-participation-heading">{state.running ? phase?.label : activeLayout?.label}</strong>
        <label className="set-panel-layout-picker">Layout<select aria-label="Segment layout" disabled={blocked} value={selectedView?preferredViewLayout(selectedView):state.layoutId} onChange={e=>session.send({type:'control',action:{type:'layout.select',layoutId:e.target.value}})}>{views.map(view=><option key={view.id} value={preferredViewLayout(view)}>{view.label}</option>)}</select></label>

        {collecting ? <>
          <div className="set-participation-stats" role="status">{state.show.ballot > 1 ? `Tie-break ${state.show.ballot - 1} · ` : ''}{state.show.total} votes · heat {Math.round(state.show.heat * 100)}%</div>
          {editorOnly&&<><div className="set-controls-fields">
            <input aria-label="Simulated player" value={player} maxLength={40} onChange={e => setPlayer(e.target.value)} />
            <button onClick={() => setPlayer(`player-${Number(player.match(/^player-(\d+)$/)?.[1] ?? state.show.total) + 1}`)}>New participant</button>
          </div>
          <div className="set-controls-fields">
            {(doc.show?.choices??[]).filter(choice => state.ballotChoiceIds.includes(choice.id)).map(choice => <button key={choice.id} disabled={state.paused}
              onClick={() => session.send({ type: 'vote', playerId: player, choiceId: choice.id })}>Vote {choice.label}</button>)}
            <button disabled={state.paused} onClick={() => session.send({ type: 'reaction', playerId: player })}>React 🔥</button>
          </div>
          <div className="set-controls-fields">
            <button disabled={state.paused} onClick={() => session.send({ type: 'tick', milliseconds: 10_000 })}>Advance 10s</button>
            <button disabled={state.paused} onClick={() => session.send({ type: 'tick', milliseconds: state.show.remainingMs })}>Close voting</button>
          </div>
          <span className="set-rehearsal-note">{timeLabel(state.show.remainingMs)} left · Simulated clock</span></>}
          {!editorOnly&&<p className="set-section-note">Waiting for connected audience inputs.</p>}
        </> : state.running && phase?.collectMs ? <>
          <div className="set-participation-stats" role="status">Voting closed · {state.show.total} votes</div>
          <ul className="set-vote-results">{(doc.show?.choices??[]).map(choice => <li key={choice.id}><span>{choice.label}</span><strong>{state.counts[choice.id]}</strong></li>)}</ul>
          {state.show.revealed ? <strong className="set-segment-result">{resultLabel}</strong> : needsRevealHint && <p className="set-rehearsal-note">{hint}</p>}
        </> : state.running && state.show.revealed ? <>
          <strong className="set-segment-result">{resultLabel}</strong>
          <p className="set-rehearsal-note">The result is on the set output. Stop the run when you’re finished.</p>
        </> : !hasHostMedia && !layoutControls.length && <p className="set-rehearsal-note">No participant inputs in this segment. {state.running ? 'Use Next when you’re ready.' : 'Start the show to run this segment.'}</p>}
        {unresolved && <div className="set-controls-fields">
          <button disabled={state.paused} onClick={() => session.send({ type: 'control', action: { type: 'show.reopen' } })}>Reopen voting</button>
          {tied && <>
            <button disabled={state.paused} onClick={() => session.send({ type: 'control', action: { type: 'show.tiebreak' } })}>Start tie-break</button>
            <button className="set-show-action" disabled={state.paused} onClick={() => session.send({ type: 'control', action: { type: 'show.draw' } })}>Reveal draw</button>
          </>}
          <p className="set-rehearsal-note">Reopen adds {timeLabel(phase?.collectMs ?? 0)} and keeps votes. A tie-break starts a new ballot.</p>
        </div>}
      </section>}
      {(doc.show || visibleSlots.size > 0) && <div className="set-reference">
        <section className="set-assignments" aria-label="Assigned sources">
          <h3>Sources <span>{visibleSlots.size} slots</span></h3>
          <ul>{doc.set.slots.filter(slot=>visibleSlots.has(slot.id)).map((slot,index) => {
            const id=output?.bindings[slot.id];
            const item=output?.sources.items?.find(item=>item.id===id);
            return <li key={slot.id}><span className="set-source-number">{index+1}</span><div><strong>{id ? sourceNames[id] ?? item?.label ?? 'Source unavailable' : 'Unassigned'}</strong><small>{slot.label} · {visibleSlots.has(slot.id) ? phase?.label ?? 'Current layout' : 'Not in this layout'}</small></div><span className={`set-source-indicator${id && visibleSlots.has(slot.id) && item?.has_frame ? ' is-ready' : ''}`} /></li>;
          })}</ul>
        </section>
        {doc.show && <p className="set-prepared-note">{rehearsing ? output?.active ? "Rehearsal is on room output · Audience inputs are simulated" : "Rehearsal preview only · Choose Show set to put it on air" : output ? output.active ? "Set is on the room output · Audio follows the room mixer" : "Assign sources in Set edit, then choose Show set" : "Prepared for preview and rehearsal · Live set output is not connected yet"}</p>}
      </div>}
    </div>
    {doc.show && <div id={rundownId} className="set-compact-rundown set-run set-segments" popover="auto" role="region" aria-label="Show rundown">
      <header><strong>Show rundown</strong><button type="button" popoverTarget={rundownId} popoverTargetAction="hide" aria-label="Close rundown">×</button></header>
      {segmentList(true)}
    </div>}
  </div>;
}

function findSlotFraming(node:import('./schema').PresentationNode|undefined,slot:string):import('./schema').SlotFraming {
  const search=(n:import('./schema').PresentationNode):import('./schema').SlotFraming|undefined=>n.slotId===slot?n.framing:n.children?.map(search).find(Boolean);
  return (node && search(node)) ?? {mode:'fit',x:0.5,y:0.5};
}
function SlotFramingControls({label,value,disabled,onChange}:{label:string;value:import('./schema').SlotFraming;disabled:boolean;onChange:(v:import('./schema').SlotFraming)=>void}) {
 return <span className="set-slot-framing"><select aria-label={`${label} framing`} disabled={disabled} value={value.mode} onChange={e=>onChange({...value,mode:e.target.value as 'fill'|'fit'})}><option value="fill">Fill frame</option><option value="fit">Fit entire source</option></select>{value.mode==='fill' && <details className="set-framing-adjust"><summary>Adjust framing</summary><span className="set-slot-position"><span>Horizontal<input aria-label={`${label} horizontal crop position`} type="range" min="0" max="1" step="0.01" value={value.x} disabled={disabled} onChange={e=>onChange({...value,x:Number(e.target.value)})} /></span><span>Vertical<input aria-label={`${label} vertical crop position`} type="range" min="0" max="1" step="0.01" value={value.y} disabled={disabled} onChange={e=>onChange({...value,y:Number(e.target.value)})} /></span></span><button type="button" disabled={disabled} onClick={()=>onChange({...value,x:0.5,y:0.5})}>Center crop</button></details>}</span>;
}
