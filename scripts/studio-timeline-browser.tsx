import React, {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ipc} from '../src/lib/ipc';
import {StudioTimeline} from '../src/features/studio/StudioComposer';
import {useStudioComposer} from '../src/features/studio/useStudioComposer';
import '../src/App.css';

const proof = {crops: [] as unknown[], pauses: [] as number[], errors: [] as string[]};
(window as any).studioTimelineProof = proof;
ipc.liveSetStudioRoomCrop = async rect => { proof.crops.push(rect); };
ipc.liveSetStudioMotionPose = async () => {};
ipc.livePlayStudioMotion = async () => {};
function Harness() {
  const [bar, setBar] = useState(false);
  const [dock, setDock] = useState<'top'|'bottom'>('bottom');
  const [enabled, setEnabled] = useState(true);
  const [open, setOpen] = useState(true);
  const [size, setSize] = useState(190);
  const time = useRef(0);
  const composer = useStudioComposer({scope:'placement-test', mayAuthor:true, studioOn:enabled, timelineOpen:bar||open, timelineDock:bar?'bottom':dock, timelineBar:bar, availableTargets:['window','canvas'], onError:e=>proof.errors.push(e)});
  const content = () => <div className="rm-studio-timeline" ref={composer.timelineRef} data-ready={composer.timelineVisible}>
    <StudioTimeline sequence={composer.sequence} availableTargets={['window','canvas']} subject="window" bar={bar} onBarChange={setBar}
      initialTimeMs={time.current} onTimeChange={v=>{time.current=v;}} onChange={composer.changeSequence} onPlay={composer.play} onPreview={composer.preview} onPause={v=>{proof.pauses.push(v);composer.preview(v);}}/>
  </div>;
  return <div className="room" style={{height:'100vh'}}>
    <div style={{height:40,flex:'none'}}>
      <button onClick={()=>setDock(v=>v==='top'?'bottom':'top')}>Move dock</button>
      <button onClick={()=>setEnabled(v=>!v)}>Toggle Studio</button>
      <button onClick={()=>setOpen(v=>!v)}>Toggle dock</button>
      <button onClick={()=>setSize(v=>v===190?250:190)}>Resize dock</button>
    </div>
    {enabled&&!bar&&dock==='top'&&<section data-dock="top" style={{height:open?size:0,flex:'none'}}>{open&&content()}</section>}
    <main style={{flex:1,minHeight:0}}>Room canvas</main>
    <section aria-label="Other bottom panels" style={{height:42,flex:'none'}}>Soundboard remains available</section>
    {enabled&&!bar&&dock==='bottom'&&<section data-dock="bottom" style={{height:open?size:0,flex:'none'}}>{open&&content()}</section>}
    {enabled&&bar&&<section className="rm-timeline-bar" data-studio-timeline-region>{content()}</section>}
    <footer ref={composer.footerRef} style={{height:30,flex:'none'}}>Producer status</footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
