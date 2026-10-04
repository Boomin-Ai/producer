import React from 'react';
import { createRoot } from 'react-dom/client';
import { ModBoard } from '../src/views/ModBoard';
import { DEFAULT_MOD_BOARD, seatFeeds } from '../src/lib/modBoard';
import '../src/App.css';
const grants = new Set(['media.camera', 'media.mic', 'media.screen']);
const calls: string[] = [];
(window as any).moderatorCalls = calls;
const access = { role:'mod' as const, via:'grant' as const, known:true, can:{roster:true,control:true,manage:false,settings:false,interactions:true,scene:true,billing:false} };
createRoot(document.getElementById('root')!).render(<div style={{height:'100vh',display:'flex',flexDirection:'column',background:'#060b13'}}><ModBoard
  title="Producer Demo" access={access} pending={false} boomin online program={null}
  scenes={{scenes:[{id:'one',name:'Host camera'},{id:'two',name:'Interview'}],active_scene_id:'one'}}
  onCut={id=>calls.push(`scene:${id}`)}
  people={<div>Guest requests appear here.<button onClick={()=>calls.push('admit')}>Admit guest</button></div>}
  vote={<div><strong>Audience</strong><p>Raised hands and chat</p><button onClick={()=>calls.push('vote')}>Open vote</button></div>}
  onAudienceLink={()=>calls.push('copy')} grants={grants} feeds={seatFeeds(grants)} media={null}
  sourceStates={[{id:'cam',participant_id:'mod',owner_id:'member',label:'Camera',kind:'camera',visible:false,muted:true,ready:true,scene_id:'one',revision:1}]}
  throwUp={{row:'off',label:'Add to scene',disabled:false,notice:null}}
  onThrowUp={kind=>calls.push(`source:${kind}`)} layout={DEFAULT_MOD_BOARD}
/></div>);
