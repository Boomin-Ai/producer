import React from 'react';
import { createRoot } from 'react-dom/client';
import { ModBoard } from '../src/views/ModBoard';
import { DEFAULT_MOD_BOARD, seatFeeds } from '../src/lib/modBoard';
import '../src/App.css';
const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=360;
const ctx=canvas.getContext('2d')!;
const draw=()=>{ctx.fillStyle='#111';ctx.fillRect(0,0,640,360);ctx.fillStyle='#ea9841';ctx.fillRect(220,0,200,360);ctx.fillStyle='#6ed6af';ctx.fillRect(0,0,640,12);ctx.fillStyle='#5783eb';ctx.fillRect(0,348,640,12);};
draw();setInterval(draw,100);
const stream=canvas.captureStream(10);
const previewListeners = new Set<()=>void>();
let previewState = {hasProgram:true,hasFrames:!new URLSearchParams(location.search).has('cold'),phase:'live',onThumbs:false,stalled:false};
const preview = new URLSearchParams(location.search).has('program') ? {
 subscribe:(fn:()=>void)=>{previewListeners.add(fn);return ()=>previewListeners.delete(fn);}, snapshot:()=>previewState,
 programStream:()=>stream, hostAudioStream:()=>null, noteFrame:()=>{if(!previewState.hasFrames){previewState={...previewState,hasFrames:true};previewListeners.forEach(fn=>fn());}},
} as any : null;
const grants = new Set(['media.camera', 'media.mic', 'media.screen']);
const calls: string[] = [];
(window as any).moderatorCalls = calls;
const access = { role:'mod' as const, via:'grant' as const, known:true, can:{roster:true,control:true,manage:false,settings:false,interactions:true,scene:true,billing:false} };
createRoot(document.getElementById('root')!).render(<div style={{height:'100vh',display:'flex',flexDirection:'column',background:'#060b13'}}><ModBoard
  title="Producer Demo" access={access} pending={false} boomin online program={preview}
  scenes={{scenes:[{id:'one',name:'Host camera'},{id:'two',name:'Interview'}],active_scene_id:'one'}}
  onCut={id=>calls.push(`scene:${id}`)}
  people={<div>Guest requests appear here.<button onClick={()=>calls.push('admit')}>Admit guest</button></div>}
  vote={<div><strong>Audience</strong><p>Raised hands and chat</p><button onClick={()=>calls.push('vote')}>Open vote</button></div>}
  onAudienceLink={()=>calls.push('copy')} grants={grants} feeds={seatFeeds(grants)} media={null}
  onSourceMute={(id,muted)=>calls.push(`mix:${id}:${muted}`)}
  pendingSources={new Set(new URLSearchParams(location.search).has('pending')?['mic']:[])}
  sourceStates={[{id:'mic',participant_id:'mod',owner_id:'member',label:'Microphone',kind:'microphone',visible:false,muted:true,ready:true,scene_id:null,revision:1},{id:'cam',participant_id:'mod',owner_id:'member',label:'Camera',kind:'camera',visible:false,muted:true,ready:true,scene_id:'one',revision:1}]}
  throwUp={{row:'off',label:'Add to scene',disabled:false,notice:null}}
  onThrowUp={kind=>calls.push(`source:${kind}`)} layout={DEFAULT_MOD_BOARD}
/></div>);
