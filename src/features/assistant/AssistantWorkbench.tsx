/** Explicit dev-only verification using the real provider and Set editor. */
import {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {getName} from '@tauri-apps/api/app';
import {SetConfiguration} from '../presentation/SetConfiguration';
import {SetPreview} from '../presentation/SetPreview';
import {RehearsalSession} from '../presentation/rehearsal';
import {parsePackage, type PresentationPackage} from '../presentation/schema';
import fixture from '../presentation/fixtures/after-hours.json';
import {DraftPreviewBoundary} from './DraftPreviewBoundary';

export default function AssistantWorkbench() {
  const [allowed, setAllowed] = useState(false), [error, setError] = useState('');
  const [document, setDocument] = useState<PresentationPackage>(() => parsePackage(fixture));
  const previewKey=useMemo(()=>crypto.randomUUID(),[document]);
  const session = useMemo(() => new RehearsalSession(document, undefined, 'prepare'), [document]);
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  useEffect(() => {
    let disposed = false;
    void getName().then(name => {
      if (name !== 'Producer DJ Test') throw Error('Use the isolated Producer DJ Test bundle for this check.');
      if (!disposed) setAllowed(true);
    }).catch(e => {if (!disposed) setError(String(e));});
    return () => {disposed = true;};
  }, []);
  return <main style={{padding: 28, background: '#080d14', color: '#eef3fa', minHeight: '100vh'}}>
    <header style={{marginBottom: 24}}><p>PRODUCER · DEVELOPMENT</p><h1>Assistant authoring</h1><p>Private Set preparation. No room, camera, microphone or output is active in this view.</p></header>
    {error && <p role="alert">{error}</p>}
    {allowed && <><SetConfiguration session={session} onChange={setDocument} hideOutputAction/>
      <div style={{maxWidth: 1100, margin: '28px auto'}}><DraftPreviewBoundary key={previewKey}><SetPreview doc={document} state={state}/></DraftPreviewBoundary></div>
      <p>Choose a Set, then open Assistant. Loaded drafts are saved to the dev library; native output still requires the normal room preparation checks.</p></>}
  </main>;
}
