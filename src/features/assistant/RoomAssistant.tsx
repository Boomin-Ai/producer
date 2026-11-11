import {memo, useCallback, useEffect, useRef, useState} from 'react';
import {packageRevision} from '../presentation/authoring/compiler';
import type {RehearsalSession} from '../presentation/rehearsal';
import type {PresentationPackage} from '../presentation/schema';
import SetAssistantDialog from './SetAssistantDialog';
import type {AssistantSetRequest} from './roomBridge';

type Request = AssistantSetRequest & {id: string};
interface Props {
  session: RehearsalSession;
  scope: string;
  target: HTMLElement | null;
  compact: boolean;
  onExpand(): void;
  request?: Request;
  onReview(document: PresentationPackage, source: RehearsalSession): Promise<void>;
}

/** One lazily mounted owner per room. Reparenting a dock only moves its view;
 * the provider, request cancellation, conversation and draft worker stay here. */
function RoomAssistant(props: Props) {
  const latest = useRef(props); latest.current = props;
  const processed = useRef(props.request?.id);
  const generation = useRef(0);
  const [reviewRequest, setReviewRequest] = useState(props.request?.id);
  const [context, setContext] = useState(() => {
    const source = props.session;
    return {document: props.request?.document ?? source.exportPreparedPackage(), key: 'initial',
      onLoad: props.request?.onLoad ?? ((document: PresentationPackage) => latest.current.onReview(document, source))};
  });
  const current = useRef(context); current.current = context;
  const currentDraft=useRef<PresentationPackage|undefined>(undefined);
  const draftChanged=useCallback((document:PresentationPackage)=>{
    if(current.current.key===context.key)currentDraft.current=document;
  },[context.key]);
  const [error, setError] = useState('');
  useEffect(() => () => {generation.current++;}, []);
  async function select(request: AssistantSetRequest, review?: string) {
    const ticket = ++generation.current; setError('');
    try {
      const [revision, previous, draft] = await Promise.all([packageRevision(request.document), packageRevision(current.current.document), currentDraft.current?packageRevision(currentDraft.current):undefined]);
      if (ticket !== generation.current) return;
      const reuse=revision===previous||revision===draft;
      if(!reuse)currentDraft.current=undefined;
      setContext(old => ({document: reuse ? old.document : request.document, key: reuse ? old.key : revision, onLoad: request.onLoad}));
      setReviewRequest(review);
    } catch (e) {if (ticket === generation.current) setError(e instanceof Error ? e.message : String(e));}
  }
  useEffect(() => {
    if (!props.request || processed.current === props.request.id) return;
    processed.current = props.request.id;
    void select(props.request, props.request.id);
  }, [props.request]);
  return <>
    <SetAssistantDialog key={context.key} document={context.document} scope={props.scope} onLoad={context.onLoad} onClose={()=>{}} contextError={error} onDraftChange={draftChanged}
      dock={{target: props.target, compact: props.compact, onExpand: props.onExpand, reviewRequest, contextLabel: 'Current Set snapshot', onUseCurrent: () => {
        const source = latest.current.session;
        void select({document: source.exportPreparedPackage(), onLoad: doc => latest.current.onReview(doc, source)});
      }}}/>
  </>;
}

export default memo(RoomAssistant);
