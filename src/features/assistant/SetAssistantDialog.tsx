import {memo, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {activeEndpointId} from '../../lib/workspace';
import {openUrl} from '@tauri-apps/plugin-opener';
import {chatgpt, type AssistantStatus, type AssistantModel, type ResponseItem} from './provider';
import {executeSetTool, setAssistantInstructions, setAssistantTools} from './authoringTools';
import {SetAuthoringWorker, type DraftSnapshot} from '../presentation/authoring/workerClient';
import {discoverDesktopAuthoringTarget} from '../presentation/authoring/discovery';
import {RehearsalSession} from '../presentation/rehearsal';
import {SetPreview} from '../presentation/SetPreview';
import {SetAuthoringControlSurface} from '../presentation/SetControlsPanel';
import type {PresentationPackage} from '../presentation/schema';
import './assistant.css';

type Message = {id: string; role: 'user' | 'assistant' | 'tool'; text: string};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const DraftPreview = memo(function DraftPreview({document}: {document: PresentationPackage}) {
  const session = useMemo(() => new RehearsalSession(document, undefined, 'prepare'), [document]);
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const layout = document.set.layouts.find(l => l.id === state.layoutId)!;
  return <div className="assistant-design">
    <div className="assistant-preview-heading"><strong>{document.name}</strong><label>Preview layout<select aria-label="Assistant preview layout" value={state.layoutId} onChange={event => session.send({type: 'control', action: {type: 'layout.select', layoutId: event.target.value}})}>{document.set.layouts.map(l => <option key={l.id} value={l.id}>{l.label} · {l.width > l.height ? 'Landscape' : l.height > l.width ? 'Vertical' : 'Square'}</option>)}</select></label></div>
    <div className="assistant-preview-canvas" style={{'--preview-aspect': `${layout.width}/${layout.height}`} as React.CSSProperties}><SetPreview doc={document} state={state}/></div>
    <details className="assistant-control-preview"><summary>Try this Set’s controls</summary><p>Layouts, controls and preview values stay in this draft.</p><SetAuthoringControlSurface session={session}/></details>
    <p className="assistant-caption">Browser preview · Sources use placeholders. Native preparation checks your actual sources and output.</p>
  </div>;
});

export default function SetAssistantDialog({document, onLoad, onClose}: {document: PresentationPackage; onLoad: (document: PresentationPackage) => Promise<void>; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const worker = useRef<SetAuthoringWorker | undefined>(undefined);
  const generation = useRef(0), turnId = useRef<string | undefined>(undefined), authAttempt = useRef<string | undefined>(undefined);
  const accountEpoch=useRef('');
  const history = useRef<unknown[]>([]);
  const [draft, setDraft] = useState<DraftSnapshot>();
  const [status, setStatus] = useState<AssistantStatus>();
  const [models, setModels] = useState<AssistantModel[]>([]), [model, setModel] = useState('');
  const [messages, setMessages] = useState<Message[]>([]), [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false), [connecting, setConnecting] = useState(false), [loading, setLoading] = useState(false);
  const [shareDesign, setShareDesign] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [welcome, setWelcome] = useState(false);
  const active = status?.accounts.find(a => a.id === status.active);
  const refresh = async () => {const next = await chatgpt.status(); setStatus(next); return next;};

  useEffect(() => {
    let disposed = false;
    const local = new SetAuthoringWorker(); worker.current = local;
    dialog.current?.showModal();
    void discoverDesktopAuthoringTarget().then(target => local.open(document, target, activeEndpointId() ?? 'local')).then(snapshot => {if (!disposed) {setDraft(snapshot); if (snapshot.restored && snapshot.canUndo) setNotice('Restored your saved draft.');}}).catch(e => {if (!disposed) setError(errorText(e));});
    void refresh().catch(e => {if (!disposed) setError(errorText(e));});
    return () => {disposed = true; ++generation.current; if (turnId.current) void chatgpt.cancel(turnId.current).catch(() => {}); if (authAttempt.current) void chatgpt.cancelSignIn().catch(() => {}); local.close(); worker.current = undefined;};
  }, [document]);
  useEffect(() => {
    if (status?.signIn?.status !== 'waiting') return;
    let disposed = false;
    const timer = setInterval(() => {void chatgpt.status().then(next => {
      if (disposed) return;
      setStatus(next);
      if (next.signIn?.status === 'error') {setError(next.signIn.error ?? 'Sign-in could not complete.'); setConnecting(false);}
      if (next.signIn?.status === 'complete') {
        setConnecting(false); authAttempt.current = undefined;
        const account = next.accounts.find(a => a.id === next.active);
        if (account?.planEnabled && !localStorage.getItem(`producer:assistant:welcome:${account.id}`)) setWelcome(true);
      }
    }).catch(e => {if (!disposed) {setError(errorText(e)); setConnecting(false);}});}, 1000);
    return () => {disposed = true; clearInterval(timer);};
  }, [status?.signIn?.status]);
  useEffect(() => {
    let disposed = false; setModels([]); setModel('');
    const epoch=`${active?.id??''}:${active?.planEnabled??false}:${status?.signIn?.status==='complete'?status.signIn.id:''}`;
    if(accountEpoch.current&&accountEpoch.current!==epoch) {
      ++generation.current;setBusy(false);history.current=[];setMessages([]);
      if(turnId.current)void chatgpt.cancel(turnId.current).catch(()=>{});
    }
    accountEpoch.current=epoch;
    if (!active?.planEnabled) return;
    void chatgpt.models(active.id).then(value => {if (!disposed) {setModels(value); setModel(value[0]?.slug ?? '');}}).catch(e => {if (!disposed) setError(errorText(e));});
    return () => {disposed = true;};
  }, [active?.id, active?.planEnabled,status?.signIn?.status==='complete'?status.signIn.id:'']);

  async function stop() {
    ++generation.current; setBusy(false); setNotice('Assistant stopped. Completed draft changes are saved.');
    if (turnId.current) await chatgpt.cancel(turnId.current).catch(() => {});
    if (worker.current) await worker.current.call<DraftSnapshot>('snapshot', {}).then(setDraft).catch(() => {});
  }
  async function signIn(id?: string) {
    setError(''); setConnecting(true);
    try {authAttempt.current = await chatgpt.signIn(id); await refresh();}
    catch (e) {setError(errorText(e)); setConnecting(false);}
  }
  async function chooseAccount(id: string) {
    await stop(); history.current = []; setMessages([]); setError('');
    try {await chatgpt.select(id); await refresh();} catch (e) {setError(errorText(e));}
  }
  async function disconnect() {
    if (!active) return; await stop(); history.current = []; setMessages([]); setError('');
    try {const revoked = await chatgpt.disconnect(active.id); await refresh(); setNotice(revoked ? 'ChatGPT disconnected.' : 'Signed out on this device. Remote revocation was not confirmed; you can remove Producer in ChatGPT settings.');} catch (e) {setError(errorText(e));}
  }
  async function send() {
    if (!active?.planEnabled || !model || !prompt.trim() || busy || !draft || !worker.current) return;
    const local = worker.current, ticket = ++generation.current, account = active.id, selectedModel = model;
    const authorized = () => ticket === generation.current && worker.current === local;
    const text = prompt.trim(); setPrompt(''); setBusy(true); setError(''); setNotice('');
    setMessages(old => [...old, {id: crypto.randomUUID(), role: 'user', text}]);
    const next: unknown[] = [...history.current, {role: 'user', content: text}];
    try {
      for (let round = 0; round < 8 && authorized(); round++) {
        const id = crypto.randomUUID(); turnId.current = id;
        const messageId = crypto.randomUUID(); let output: ResponseItem[] | undefined;
        setMessages(old => [...old, {id: messageId, role: 'assistant', text: ''}]);
        await chatgpt.turn({accountId: account, turnId: id, model: selectedModel, instructions: setAssistantInstructions + `\nDesign context sharing is ${shareDesign ? 'enabled' : 'disabled; answer without inspecting or modifying the Set'}.`, input: next, tools: shareDesign ? setAssistantTools : []}, event => {
          if (!authorized()) return;
          if (event.type === 'text') setMessages(old => old.map(m => m.id === messageId ? {...m, text: m.text + event.text} : m));
          else output = event.output;
        });
        if (!authorized()) return;
        if (!output) throw Error('The provider did not complete its response. No unfinished edit was applied.');
        next.push(...output);
        const calls = output.filter(item => item.type === 'function_call');
        if (!calls.length) {history.current = next; setStatus(await chatgpt.status()); return;}
        if (!shareDesign) throw Error('Set tools are disabled by your sharing choice.');
        for (const call of calls) {
          if (!authorized()) return;
          if (typeof call.call_id !== 'string' || !call.call_id) throw Error('The provider returned an invalid tool call.');
          let result: unknown;
          try {result = await executeSetTool(local, call, setDraft, authorized);}
          catch (e) {result = {ok: false, error: errorText(e), repair: 'Inspect the current draft and schema, then retry a focused edit. The failed candidate was not committed.'};}
          if (!authorized()) return;
          next.push({type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result)});
          const record = result as {ok?: boolean};
          setMessages(old => [...old, {id: crypto.randomUUID(), role: 'tool', text: record.ok === false ? 'Candidate needs a correction; working draft retained.' : call.name === 'edit_set' || call.name === 'create_set' ? 'Draft updated and validated.' : call.name === 'read_schema' ? 'Read the supported design contract.' : 'Inspected the current draft.'}]);
        }
      }
      if (authorized()) {history.current = next; setNotice('Reached this turn’s tool limit. Review the draft or ask the Assistant to continue.');}
    } catch (e) {if (authorized()) setError(errorText(e));}
    finally {if (authorized()) {setBusy(false); turnId.current = undefined;}}
  }
  async function moveHistory(direction: 'undo' | 'redo') {
    if (!worker.current || !draft || busy) return;
    setError(''); try {setDraft(await worker.current.history(direction, draft.revision));} catch (e) {setError(errorText(e));}
  }
  async function load() {
    if (!draft || busy) return; setLoading(true); setError('');
    try {await onLoad(draft.document); onClose();} catch (e) {setError(errorText(e)); setLoading(false);}
  }
  const close = () => {void stop(); onClose();};
  return createPortal(<dialog ref={dialog} className="assistant-workspace" aria-label="Set assistant" onCancel={event => {event.preventDefault(); close();}}>
    <header className="assistant-header"><div><span className="assistant-eyebrow">PRODUCER ASSISTANT</span><h2>Make something worth watching.</h2></div><button onClick={close} aria-label="Close Set assistant">Close</button></header>
    <div className="assistant-workspace-grid">
      <section className="assistant-preview" aria-label="Draft design preview">{draft ? <DraftPreview document={draft.document}/> : <p role="status">Opening your design…</p>}<div className="assistant-history"><button disabled={!draft?.canUndo || busy} onClick={() => void moveHistory('undo')}>Undo</button><button disabled={!draft?.canRedo || busy} onClick={() => void moveHistory('redo')}>Redo</button><span>{draft?.checkpoints.length ?? 0} saved edits</span></div></section>
      <section className="assistant-panel" aria-label="Assistant conversation">
        <div className="assistant-connection"><div className="assistant-provider-title"><strong>ChatGPT</strong><span>{active?.planEnabled ? 'Connected' : 'Connect your plan'}</span></div>
          {!active?.planEnabled ? <><p>Create and refine Sets with your ChatGPT plan.</p><button data-oai-siwc-button="" className="assistant-connect" disabled={connecting} onClick={() => void signIn(active?.id)}>{connecting ? 'Continue in your browser…' : 'Continue with ChatGPT'}</button></> : <div className="assistant-account-row"><label>Account<select aria-label="Assistant account" value={active.id} disabled={busy} onChange={event => void chooseAccount(event.target.value)}>{status?.accounts.map(a => <option key={a.id} value={a.id}>{a.email} · {a.id.slice(0, 6)}</option>)}</select></label><label>Model<select aria-label="Assistant model" value={model} disabled={busy || !models.length} onChange={event => {history.current = []; setMessages([]); setModel(event.target.value);}}>{models.map(m => <option key={m.slug} value={m.slug}>{m.display_name}</option>)}</select></label></div>}
          {!active?.planEnabled&&!!status?.accounts.length&&<label>Saved ChatGPT account<select aria-label="Saved ChatGPT account" value={active?.id??''} onChange={event=>void chooseAccount(event.target.value)}><option value="" disabled>Choose an account to reconnect</option>{status.accounts.map(a=><option key={a.id} value={a.id}>{a.email} · {a.id.slice(0,6)}</option>)}</select></label>}
          {connecting && <button onClick={() => void chatgpt.cancelSignIn().then(refresh).then(() => setConnecting(false))}>Cancel sign-in</button>}
          {active && <div className="assistant-account-actions"><button disabled={busy} onClick={() => void signIn()}>Add account</button><button disabled={busy} onClick={() => void signIn(active.id)}>Reconnect</button><button disabled={busy} onClick={() => void disconnect()}>Disconnect</button><button onClick={() => void openUrl('https://chatgpt.com/settings/usage')}>Usage ↗</button></div>}
          {welcome && <div className="assistant-welcome" role="dialog" aria-label="ChatGPT plan connected"><strong>You’re using your ChatGPT plan</strong><p>Eligible requests use your plan. Manage Producer’s usage and access in ChatGPT settings.</p><button onClick={() => {if (active) localStorage.setItem(`producer:assistant:welcome:${active.id}`, '1'); setWelcome(false);}}>Got it</button></div>}
        </div>
        <details className="assistant-sharing"><summary>On request · Data shared</summary><label><input type="checkbox" checked={shareDesign} onChange={event => {void stop(); setShareDesign(event.target.checked); history.current = []; setMessages([]);}}/>Share this Set’s design with ChatGPT</label><p>Includes authored text, controls, source roles and animation. Camera, screen capture, audio, room chat and credentials stay outside this conversation. Changing sharing starts a new conversation.</p><span>Authority: private draft edits</span><button type="button" disabled={busy} onClick={()=>{history.current=[];setMessages([]);setError('');setNotice('New conversation. Your draft is retained.');}}>New conversation</button></details>
        <div className="assistant-messages" role="log" aria-label="Assistant messages" aria-live="polite">{!messages.length && <div className="assistant-empty"><strong>Your design, down to the details.</strong><p>Create a complete Set, refine one element, or design controls for each layout.</p><button onClick={() => setPrompt('Refine this Set with stronger typography and subtle cinematic motion. Preserve my sources, controls and configured content.')}>Polish this Set</button><button onClick={() => setPrompt('Create a cinematic charcoal-and-chrome teaching Set, with landscape and vertical layouts, host camera and screen-share roles, animated teaching cards and beautifully arranged configurable controls.')}>Create a new Set</button></div>}{messages.filter(m => m.text).map(message => <div key={message.id} className={`assistant-message ${message.role}`}><span>{message.role === 'user' ? 'You' : message.role === 'tool' ? 'Producer' : 'Assistant'}</span><p>{message.text}</p></div>)}</div>
        {error && <p className="assistant-error" role="alert">{error}</p>}{notice && <p className="assistant-notice" role="status">{notice}</p>}
        <form className="assistant-compose" onSubmit={event => {event.preventDefault(); void send();}}><label htmlFor="assistant-prompt">Describe your Set or an edit</label><textarea id="assistant-prompt" aria-label="Assistant prompt" value={prompt} maxLength={8000} onChange={event => setPrompt(event.target.value)} placeholder="Make KLEVELAND bold chrome, with a slow light sweep…" onKeyDown={event => {if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {event.preventDefault(); void send();}}}/><div><span>{busy ? 'Working on your draft…' : 'Changes stay in your draft.'}</span>{busy ? <button type="button" onClick={() => void stop()}>Stop</button> : <button className="assistant-primary" disabled={!active?.planEnabled || !model || !draft || !prompt.trim()} type="submit">Send ↗</button>}</div></form>
      </section>
    </div>
    <footer className="assistant-footer"><span>Review the design and its controls, then check it in preparation.</span><button className="assistant-primary" disabled={!draft?.canUndo || busy || loading} onClick={() => void load()}>{loading ? 'Loading…' : 'Load preparation'}</button></footer>
  </dialog>, globalThis.document.body);
}
