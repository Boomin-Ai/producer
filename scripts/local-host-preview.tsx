import {createRoot} from 'react-dom/client';
import {SetPreview} from '../src/features/presentation/SetPreview';
import {RehearsalSession} from '../src/features/presentation/rehearsal';
import '../src/features/presentation/presentation.css';
const doc=await fetch('/local-host-preview.json').then(r=>r.json());
const session=new RehearsalSession(doc);session.send({type:'control',action:{type:'show.start'}});session.send({type:'tick',milliseconds:1500});const state=structuredClone(session.snapshot());
state.animationClock={running:false,positionMs:1500,segmentMs:1500,anchorMs:Date.now()};
state.layoutId=new URLSearchParams(location.search).get('layout')??doc.set.initialLayout;
createRoot(document.getElementById('root')!).render(<SetPreview doc={doc} state={state}/>);
