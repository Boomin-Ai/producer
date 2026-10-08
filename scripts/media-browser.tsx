import {SetControlsPanel} from '../src/features/presentation/SetControlsPanel';
import {useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {AFTER_HOURS} from '../src/features/presentation/fixtures';
import {RehearsalSession} from '../src/features/presentation/rehearsal';
import {SetMenu} from '../src/features/presentation/SetMenu';
import {SetPreview} from '../src/features/presentation/SetPreview';
import '../src/App.css';
import {ipc} from '../src/lib/ipc';
ipc.setLibraryList=async()=>[];ipc.setLibrarySave=async()=>{};
function App(){const [session,setSession]=useState(()=>new RehearsalSession(AFTER_HOURS,undefined,'prepare'));const state=useSyncExternalStore(session.subscribe,session.snapshot);return <main><SetMenu session={session} onChange={doc=>setSession(new RehearsalSession(doc,undefined,'prepare'))} onControls={()=>{}}/><div style={{width:1000,height:650}}><SetPreview doc={session.package} state={state}/></div><SetControlsPanel session={session} onChange={doc=>setSession(new RehearsalSession(doc,undefined,'prepare'))}/></main>;}
createRoot(document.getElementById('root')!).render(<App/>);
