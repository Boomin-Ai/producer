import {createRoot} from 'react-dom/client';
import {useState,useSyncExternalStore} from 'react';
import {RehearsalSession} from '../src/features/presentation/rehearsal';
import {AFTER_HOURS} from '../src/features/presentation/fixtures';
import {SetPreview} from '../src/features/presentation/SetPreview';
import {SetControlsPanel} from '../src/features/presentation/SetControlsPanel';
import '../src/App.css';
function App(){const [session,setSession]=useState(()=>new RehearsalSession(AFTER_HOURS,undefined,'prepare'));const state=useSyncExternalStore(session.subscribe,session.snapshot);return <main>
 <input aria-label="Load animation demo" type="file" onChange={async e=>{const file=e.target.files?.[0];if(file)setSession(new RehearsalSession(JSON.parse(await file.text()),undefined,'prepare'));}}/>
 <div style={{width:1000,height:565}}><SetPreview doc={session.package} state={state}/></div>
 <SetControlsPanel session={session}/><span data-testid="phase">{state.show.phase}</span></main>;}
createRoot(document.getElementById('root')!).render(<App/>);
