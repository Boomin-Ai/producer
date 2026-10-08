import {createRoot} from 'react-dom/client';
import {useState,useSyncExternalStore} from 'react';
import {RehearsalSession} from '../src/features/presentation/rehearsal';
import {AFTER_HOURS} from '../src/features/presentation/fixtures';
import {SetPreview} from '../src/features/presentation/SetPreview';
import '../src/App.css';
import '../src/features/presentation/presentation.css';
function App(){
 const [session,setSession]=useState(()=>new RehearsalSession(AFTER_HOURS,undefined,'prepare'));
 const state=useSyncExternalStore(session.subscribe,session.snapshot);
 const layout=session.package.set.layouts.find(l=>l.id===state.layoutId)!;
 return <main><input aria-label="Load combo" type="file" onChange={async e=>{const f=e.target.files?.[0];if(f){const doc=JSON.parse(await f.text());delete doc.show;setSession(new RehearsalSession(doc,undefined,'prepare'));}}}/>
 <select aria-label="Layout" value={state.layoutId} onChange={e=>session.send({type:'control',action:{type:'layout.select',layoutId:e.target.value}})}>{session.package.set.layouts.map(l=><option key={l.id} value={l.id}>{l.label}</option>)}</select>
 <div style={{width:layout.width,height:layout.height}}><SetPreview doc={session.package} state={state}/></div></main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
