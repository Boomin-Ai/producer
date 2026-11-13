import {memo, useCallback, useEffect, useRef, useState} from 'react';
import {packageRevision} from '../presentation/authoring/compiler';
import type {DraftSnapshot} from '../presentation/authoring/workerClient';
import type {RehearsalSession} from '../presentation/rehearsal';
import type {PresentationPackage} from '../presentation/schema';
import SetAssistantDialog, {type AssistantActivity} from './SetAssistantDialog';
import type {AssistantSetRequest} from './roomBridge';
import type {AssistantRoomState} from './suggestions';

type Request = AssistantSetRequest & {id: string};
interface Props {
  session: RehearsalSession;
  scope: string;
  target: HTMLElement | null;
  compact: boolean;
  roomState?: AssistantRoomState;
  onExpand(): void;
  request?: Request;
  onReview(document: PresentationPackage): Promise<void>;
}

/** One lazily mounted owner per room. Reparenting a dock only moves its view;
 * the provider, request cancellation, conversation and draft worker stay here. */
function RoomAssistant(props: Props) {
  const latest = useRef(props); latest.current = props;
  const processed = useRef(props.request?.id);
  const generation = useRef(0);
  const following=useRef(0);
  const [reviewRequest, setReviewRequest] = useState(props.request?.id);
  const [context, setContext] = useState(() => ({document: props.request?.document ?? props.session.exportPreparedPackage(), key: 'initial', target:props.request?.document??props.session.exportPreparedPackage(), branch:undefined as string|undefined, origin: props.request ? 'editor' : 'room'}));
  const current = useRef(context); current.current = context;
  const currentDraft=useRef<PresentationPackage|undefined>(undefined);
  const currentBranch=useRef<string|undefined>(undefined);
  const activity=useRef<AssistantActivity>({ready:false,edited:false,busy:false,composing:false});
  const selecting=useRef<number|undefined>(undefined);
  const [preserving,setPreserving]=useState(false),[roomChanged,setRoomChanged]=useState(false),[contextReady,setContextReady]=useState(false);
  const activityChanged=useCallback((value:AssistantActivity)=>{
    activity.current=value;
    setContextReady(value.ready);
    setPreserving(value.edited||value.busy||value.composing);
  },[]);
  const draftChanged=useCallback((document:PresentationPackage)=>{
    if(current.current.key===context.key)currentDraft.current=document;
  },[context.key]);
  const [error, setError] = useState('');
  const [roomRevision,setRoomRevision]=useState<string>();
  const [savedTargets,setSavedTargets]=useState<Array<{document:PresentationPackage;name:string;branch?:string}>>([]);
  const rememberTarget=()=>{if(!activity.current.edited)return;const base=current.current.document,name=currentDraft.current?.name??base.name;setSavedTargets(old=>[{document:base,name,branch:currentBranch.current},...old.filter(item=>item.branch!==currentBranch.current)].slice(0,5));};
  useEffect(() => () => {generation.current++;}, []);
  async function select(request: AssistantSetRequest, origin:'room'|'editor', review?: string, automatic=false, branch?:string) {
    if(automatic&&selecting.current!==undefined)return;
    const ticket = ++generation.current,followTicket=following.current; setError('');
    if(!automatic)selecting.current=ticket;
    try {
      const [revision, previous, draft] = await Promise.all([packageRevision(request.document), packageRevision(current.current.target), currentDraft.current?packageRevision(currentDraft.current):undefined]);
      if (ticket !== generation.current||automatic&&followTicket!==following.current) return;
      // An applied candidate is now the room baseline, not an unfinished draft.
      if(origin==='room')setRoomRevision(revision);
      const applied=revision===draft&&revision!==previous;
      if(automatic&&applied){setContext(old=>({...old,target:request.document,origin:'room'}));setRoomChanged(false);return;}
      const changedTarget=request.document.id!==current.current.target.id||request.document.name!==current.current.target.name;
      if(automatic&&!applied&&(activity.current.busy||activity.current.composing||activity.current.edited&&!changedTarget||current.current.origin==='editor')){setRoomChanged(revision!==previous&&revision!==draft);return;}
      const followFresh=origin==='room'&&!automatic&&draft!==undefined&&revision!==draft;
      const reuse=!followFresh&&(!branch||branch===currentBranch.current)&&(revision===previous||!automatic&&revision===draft);
      if(!reuse)rememberTarget();
      if(!reuse){currentDraft.current=undefined;activity.current={ready:false,edited:false,busy:false,composing:false};setPreserving(false);}
      setContext(old => ({document: reuse ? old.document : request.document, key: reuse ? old.key : revision+':'+(branch??crypto.randomUUID()),target:request.document,branch:reuse?old.branch:branch, origin}));
      setRoomChanged(false);
      setReviewRequest(review);
    } catch (e) {if (ticket === generation.current) setError(e instanceof Error ? e.message : String(e));}
    finally{if(!automatic&&selecting.current===ticket)selecting.current=undefined;}
  }
  useEffect(() => {
    if (!props.request || processed.current === props.request.id) return;
    processed.current = props.request.id;
    void select(props.request, 'editor', props.request.id);
  }, [props.request]);
  useEffect(()=>{
    if(!contextReady)return;
    const session=props.session;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let observed:unknown[]=[];
    const changed=()=>{
      const state=session.snapshot();
      // Native frame, media-clock and incoming room-feed updates retain these
      // authored references. They must not clone/hash assets or reset a draft.
      const next=[session.package,state.layoutId,state.values,state.feeds];
      if(next.every((value,index)=>value===observed[index]))return;
      observed=next;
      if(timer)clearTimeout(timer);
      timer=setTimeout(()=>{
        void select({document:session.exportPreparedPackage()},'room',undefined,true);
      },150);
    };
    changed();
    const unsubscribe=session.subscribe(changed);
    return()=>{if(timer)clearTimeout(timer);unsubscribe();++following.current;};
  },[props.session,contextReady,preserving]);
  const review=useCallback((document:PresentationPackage)=>latest.current.onReview(document),[]);
  return <>
    <SetAssistantDialog key={context.key} document={context.document} scope={props.scope} onLoad={review} onClose={()=>{}} roomState={props.roomState} contextError={error} onDraftChange={draftChanged} onDraftSession={(snapshot:DraftSnapshot)=>{currentBranch.current=snapshot.branch;const entries=(snapshot.recoverable??[]).map(item=>({...item,document:context.document}));if(entries.length)setSavedTargets(old=>[...entries,...old.filter(item=>!entries.some(entry=>entry.branch===item.branch))].slice(0,8));}} onActivityChange={activityChanged}
      dock={{target: props.target, compact: props.compact, onExpand: props.onExpand, reviewRequest, roomName:props.session.package.name, sourceMode:context.origin==='room'?'room':'editor',storageBranch:context.branch, roomRevision, roomChanged, contextLabel:preserving?'Private draft':context.origin==='editor'?'Set Edit preview':'Following room', savedTargets:savedTargets.map((target)=>({name:target.name,onRestore:()=>void select({document:target.document},'editor',undefined,false,target.branch)})), onNewConversation:()=>{void select({document:latest.current.session.exportPreparedPackage()},'room');}, onUseCurrent: () => {
        const source = latest.current.session;
        void select({document: source.exportPreparedPackage()},'room');
      }}}/>
  </>;
}

export default memo(RoomAssistant);
