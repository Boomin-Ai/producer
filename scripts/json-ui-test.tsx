import {createRoot} from 'react-dom/client';
import {useState,useSyncExternalStore} from 'react';
import {RehearsalSession} from '../src/features/presentation/rehearsal';
import {SetPreview} from '../src/features/presentation/SetPreview';
import {SetControlsPanel} from '../src/features/presentation/SetControlsPanel';
import type {PresentationPackage} from '../src/features/presentation/schema';
import '../src/App.css';
const doc=await fetch('/docs/shows/json-ui-test.show.json').then(r=>r.json());
function App(){
 const [session,setSession]=useState(()=>new RehearsalSession(doc,undefined,'prepare'));
 const state=useSyncExternalStore(session.subscribe,session.snapshot);
 const layout=session.package.set.layouts.find(l=>l.id===state.layoutId)!;
 const portrait=layout.height>layout.width;
 return <main style={{padding:16,maxWidth:1440,margin:'0 auto'}}>
  <div style={{width:portrait?360:960,maxWidth:'100%',margin:'0 auto 16px'}}><SetPreview doc={session.package} state={state}/></div>
  <SetControlsPanel session={session} onChange={(next:PresentationPackage)=>setSession(new RehearsalSession(next,undefined,'prepare'))}/>
  <output data-testid="phase">{state.show.phase}</output>
 </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
