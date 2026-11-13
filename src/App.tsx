import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { hasTauri, ipc, uiLog, type EndpointInfo } from "./lib/ipc";
import { Onboarding, SignIn, Wordmark, hasSignedInBefore } from "./views/Onboarding";
import { ModSeat } from "./views/ModSeat";
import type { ModLink } from "./lib/modSeat";
import { setActiveEndpointId } from "./lib/workspace";
import { FirstLight, firstLightDone } from "./views/FirstLight";
import { Home } from "./views/Home";
import {invoke} from "./lib/nativeInvoke";
import {SetsDevelopmentRoom} from "./views/SetsDevelopmentRoom";
import {ensureStarterAudio} from './lib/starterAudio';

type View = "loading" | "onboarding" | "onboarding-server" | "signin" | "home" | { kind: "modseat"; link: ModLink; from: "onboarding" | "signin" };

function App() {
  const entryReviewRequested = import.meta.env.DEV && import.meta.env.VITE_PRODUCER_ENTRY_REVIEW === '1';
  const [entryReview, setEntryReview] = useState<'checking' | 'open' | 'closed'>(entryReviewRequested ? 'checking' : 'closed');
  useEffect(() => {
    if (!entryReviewRequested) return;
    let alive = true;
    void import('@tauri-apps/api/app').then(app => app.getIdentifier()).then(id => {
      if (alive) setEntryReview(id === 'ai.boomin.producer.sets-v2-dev' || id === 'ai.boomin.producer.windows-network-dev' ? 'open' : 'closed');
    }).catch(() => { if (alive) setEntryReview('closed'); });
    return () => { alive = false; };
  }, [entryReviewRequested]);
  useEffect(() => { if (import.meta.env.DEV && entryReview === 'open') uiLog('[entry-review] Sign-in screen opened in the development bundle; saved workspace routing retained.'); }, [entryReview]);
  const [setsDevelopment,setSetsDevelopment]=useState(false);
  useEffect(()=>{
    if(!hasTauri())return;
    void (async()=>{
      const probe=await invoke<boolean>('live_set_v2_smoke_enabled');
      const studio=import.meta.env.DEV&&(import.meta.env.VITE_SCENE3D_STUDIO==='1'||['1','review'].includes(import.meta.env.VITE_AUTHORING_DESKTOP_PROOF))&&
        await import('@tauri-apps/api/app').then(app=>app.getIdentifier())==='ai.boomin.producer.sets-v2-dev';
      setSetsDevelopment(probe||studio);
    })().catch(()=>{});
  },[]);
  const [view, setView] = useState<View>("loading");
  const [firstLight, setFirstLight] = useState(() => !firstLightDone());
  const [endpoints, setEndpoints] = useState<EndpointInfo[]>([]);
  useEffect(()=>{if(!hasTauri()||view!== 'home')return;const timer=setTimeout(()=>{void ensureStarterAudio().catch(error=>uiLog(`[starter-audio] ${String(error)}`));},500);return()=>clearTimeout(timer);},[view]);

  const refresh = useCallback(async () => {
    // Browser preview has no Tauri bridge; render onboarding statically.
    if (!hasTauri()) {
      setView("onboarding");
      return;
    }
    try {
      const list = await ipc.listEndpoints();
      setEndpoints(list);
      // New beta installations start with Boomin. Existing connections,
      // including owned servers, keep their normal Home entry.
      setView(list.length === 0 ? (hasSignedInBefore() ? "signin" : "onboarding") : "home");
    } catch {
      setView("onboarding");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function removeEndpoint(id: string) {
    await ipc.removeEndpoint(id);
    await refresh();
  }

  /** Sign out of Boomin: every connected workspace (and its keychain token)
   * goes; self-hosted endpoints are not Boomin's and stay. */
  async function signOut() {
    for (const e of endpoints.filter((x) => x.kind === "connected")) {
      await ipc.removeEndpoint(e.id).catch(() => {});
    }
    setActiveEndpointId(null);
    await refresh();
  }

  if (import.meta.env.DEV && entryReview !== 'closed') {
    return <main className="shell">{entryReview === 'checking' ? <div className="boot"><Wordmark /></div> : <>
      <Onboarding onConnected={() => { setEntryReview('closed'); void refresh(); }} />
      <button type="button" className="entry-review-exit" onClick={() => setEntryReview('closed')}>Back to studio</button>
    </>}</main>;
  }
  if(setsDevelopment)return <SetsDevelopmentRoom/>;
  if (firstLight) {
    return <FirstLight onDone={() => setFirstLight(false)} />;
  }

  if (view === "loading") {
    return (
      <main className="shell">
        <div className="boot">
          <Wordmark />
        </div>
      </main>
    );
  }

  // A mod seat opened from the welcome screen: no workspace yet, the link is
  // the credential. Leaving returns to the door it came from.
  if (typeof view === "object" && view.kind === "modseat") {
    return <ModSeat link={view.link} onLeave={() => setView(view.from)} />;
  }

  if (view === "signin") {
    return (
      <main className="shell">
        <SignIn allowServerConnection={endpoints.length > 0} onConnected={refresh} onModLink={(link) => setView({ kind: "modseat", link, from: "signin" })} />
      </main>
    );
  }

  if (view === "onboarding" || view === "onboarding-server") {
    return (
      <main className="shell">
        <Onboarding
          allowServerConnection={endpoints.length > 0}
          // Someone who already has a workspace and picked "Connect a server"
          // has made the choice — land on the form, not on the chooser.
          start={view === "onboarding-server" ? "server" : undefined}
          onConnected={refresh}
          onModLink={(link) => setView({ kind: "modseat", link, from: "onboarding" })}
          onCancel={endpoints.length > 0 ? () => setView("home") : undefined}
        />
      </main>
    );
  }

  return (
    <Home
      endpoints={endpoints}
      onAddEndpoint={(door) => setView(door === "server" ? "onboarding-server" : "onboarding")}
      onRemoveEndpoint={removeEndpoint}
      onSignOut={signOut}
      onEndpointsChanged={() => void refresh()}
    />
  );
}

export default App;
