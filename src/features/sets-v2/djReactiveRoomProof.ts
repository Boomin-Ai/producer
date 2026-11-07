import {dj,queueTrack} from '../../lib/dj';
import {invoke} from '../../lib/nativeInvoke';
import {preparationDebug} from './preparedScenes';
import {showDjVinylReview} from './djFeedRoomProof';
import {sounds} from '../../lib/soundboard';
import {soundLibraryPreviewProof} from './soundLibraryPreviewProof';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until<T>(label:string,read:()=>Promise<T|null>,timeout=30000):Promise<T>{const end=performance.now()+timeout;while(performance.now()<end){try{const value=await read();if(value!==null)return value;}catch{}await sleep(120);}throw Error(label+' timed out');}
type Visual={role:string;energy:number;bass:number;moneyParticles:number;dropActive:boolean;draws:number;soundActive?:boolean;soundLabel?:string;soundSequence?:number};
type Status={renderedRevision:number;transitioning:boolean;scene3dContexts:number;djVisuals:Visual[]};
async function statuses(){const {generation}=await invoke<{generation:number}>('live_set_status');return Promise.all(['program','portrait'].map(outputId=>invoke<Status>('live_set_v2',{request:{op:'status',generation,outputId}})));}
async function click(label:string){await until('Control '+label,async()=>{const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>!b.disabled&&(b.textContent?.trim()===label||b.getAttribute('aria-label')===label));if(!button)return null;button.click();return true;});}
async function verifySoundPopups(room:string){
 const library=await sounds.library(room),fah=library.board.pads.find(p=>/^FA+H+$/i.test(p.name.replace(/[^a-z]/gi,''))),other=library.board.pads.find(p=>p.id!==fah?.id&&!/^FA+H+$/i.test(p.name.replace(/[^a-z]/gi,'')));
 if(!fah||!other)throw Error('Restore the FAHHHH and Vine Boom pads before the popup check');
 const noPopup=()=>until('Sound popup clears',async()=>{const s=await statuses();return s.every(o=>o.djVisuals.every(v=>!v.soundActive))?s:null;},6000);
 const popup=(label:string,after=0)=>until('Sound overlay '+label,async()=>{const s=await statuses();return s.every(o=>o.djVisuals.some(v=>v.role==='stage'&&v.soundActive&&v.soundLabel===label&&(v.soundSequence??0)>after))?s:null;},6000);
 try{
  await sounds.control(room,'volume','',0);await sounds.control(room,'monitor','',0);await sounds.control(room,'stop_all');await noPopup();
  const before=await statuses();const start=performance.now();
  const pad=await until('Connected FAHHHH pad',async()=>document.querySelector<HTMLButtonElement>('.sb-trigger[title="'+CSS.escape(fah.name)+'"]')??null);
  pad.click();const first=await popup('FAHHHHHH!');const observedMs=performance.now()-start;
  const sequence=Math.max(...first.flatMap(o=>o.djVisuals.map(v=>v.soundSequence??0)));
  await sleep(250);pad.click();const repeated=await popup('FAHHHHHH!',sequence);
  await sounds.control(room,'play',other.id);const named=await popup(other.name.toUpperCase());
  if(named.some((o,i)=>o.scene3dContexts!==before[i].scene3dContexts||o.renderedRevision!==before[i].renderedRevision))throw Error('Sound triggers rebuilt or retook the Set');
  await noPopup();await sounds.control(room,'stop_all');await sounds.control(room,'preview',fah.id);await sleep(250);
  if((await statuses()).some(o=>o.djVisuals.some(v=>v.soundActive)))throw Error('Headphone preview appeared on output');
  await sounds.control(room,'stop_all');
  const beforeDisable=await statuses();await click('Disable sound popups');await sleep(250);
  await until('Popup disable committed on both outputs',async()=>{if(!document.querySelector('.set-controls[data-output-busy="false"]'))return null;const s=await statuses();return s.every((o,i)=>o.renderedRevision!==beforeDisable[i].renderedRevision&&!o.transitioning)?s:null;});
  const disabledSequence=Math.max(...(await statuses()).flatMap(o=>o.djVisuals.map(v=>v.soundSequence??0)));
  await sounds.control(room,'play',fah.id);
  await until('Disabled trigger received without a popup',async()=>{const s=await statuses();return s.every(o=>o.djVisuals.some(v=>v.role==='stage'&&(v.soundSequence??0)>disabledSequence&&!v.soundActive))?s:null;},6000);
  await click('Enable sound popups');await sounds.control(room,'stop_all');
  return {check:'FAHHHH pad click shakes on both outputs, retriggers, names other sounds, expires, and respects preview/disable without rebuilding the Set',observedMs,first:first.map(o=>o.djVisuals),repeated:repeated.map(o=>o.djVisuals),named:named.map(o=>o.djVisuals)};
 }finally{
  await sounds.control(room,'stop_all').catch(()=>{});await sounds.control(room,'volume','',library.board.volume).catch(()=>{});await sounds.control(room,'monitor','',library.board.monitor?1:0).catch(()=>{});
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>!b.disabled&&b.textContent?.trim()==='Enable sound popups')?.click();
 }
}
export async function djReactiveRoomProof(room:string){
 const checks:Record<string,unknown>[]=[];
 const report=(value:Record<string,unknown>)=>invoke('live_set_v2_report',{result:{kind:'dj-reactive',checks,...value}});
 let restore:Awaited<ReturnType<typeof dj.control>>|undefined;
 try{
  await report({stage:'preparing native reactive Set'});await showDjVinylReview(85000);
  await click('Output settings');await click('Both');await click('Close output settings');
  const ready=await until('Both reactive outputs',async()=>{const s=await statuses();return s.every(o=>o.renderedRevision>0&&!o.transitioning&&o.djVisuals.length===2)?s:null;},85000);
  checks.push({check:'both orientations render both reactive layers',contexts:ready.map(o=>o.scene3dContexts)});
  const bounds=(selector:string)=>{const node=document.querySelector(selector);if(!node)throw Error('Missing room element '+selector);const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const bottomHandle=document.querySelector<HTMLElement>('[aria-label="Show the bottom row"]');
  bottomHandle?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await until('Bottom room dock',async()=>document.querySelector('[data-dock="bottom"]')?true:null);
  await sleep(500);
  const canvas=bounds('.rm-canvas'),landscape=bounds('.rm-landscape-monitor > .live-preview'),portrait=bounds('.rm-portrait-monitor');
  for(const r of [landscape,portrait])if(r.x<canvas.x-1||r.y<canvas.y-1||r.right>canvas.right+1||r.bottom>canvas.bottom+1)throw Error('Output monitor overflows room canvas');
  if(Math.abs(landscape.height-portrait.height)>3)throw Error('Dual-output monitor heights do not match');
  if(Math.abs(landscape.width/landscape.height-16/9)>.02||Math.abs(portrait.width/portrait.height-9/16)>.02)throw Error('Output aspect ratio distorted');
  checks.push({check:'full room docks and both output canvases fit',canvas,landscape,portrait,docks:['top','left','right','bottom'].map(dock=>({dock,...bounds('[data-dock="'+dock+'"]')}))});

  await report({stage:'decoded audio'});const library=await dj.library();const track=library.tracks.find(t=>/SWEAR TO GOD/.test(t.title))??library.tracks[0];if(!track)throw Error('No DJ tracks available');
  restore=await dj.control({kind:'status'});await dj.control({kind:'clear'});
  await dj.control({kind:'mix',volume:.65,crossfader:0,fade:0,repeat:false,shuffle:false,duck:false});
  await dj.control({kind:'queue',tracks:library.tracks.map(queueTrack)});await dj.control({kind:'load',deck:0,track:queueTrack(track)});await dj.control({kind:'play',deck:0});
  const audio=await until('Actual post-mix DJ signal',async()=>{const s=await dj.control({kind:'status'});return s.audio&&s.audio.energy>.02?s.audio:null;});
  const reacting=await until('Native renderer responds to DJ audio',async()=>{const s=await statuses();return s.every(o=>o.djVisuals.some(v=>v.role==='stage'&&v.energy>.02))?s:null;});
  checks.push({check:'real DJ samples reach native music-reactive renderer',audio,visuals:reacting.map(o=>o.djVisuals)});await report({stage:'live controls'});
  await sleep(700);await until('Set controls settled',async()=>document.querySelector('.set-controls[data-output-busy="false"]')?true:null);
  const beforeCta=await statuses();
  await click('Producer CTA');
  await sleep(250);
  const ctaOpen=await until('Producer CTA on both outputs',async()=>{if(!document.querySelector('.set-controls[data-output-busy="false"]'))return null;const s=await statuses();return s.every((o,i)=>o.renderedRevision!==beforeCta[i].renderedRevision&&!o.transitioning)?s:null;});
  const audioDuringCta=await dj.control({kind:'status'});if(audioDuringCta.program?.phase!=='playing'||!audioDuringCta.audio?.playing)throw Error('CTA interrupted DJ playback');
  await click('Back to mix');
  await sleep(250);
  const ctaClosed=await until('Return to mix on both outputs',async()=>{if(!document.querySelector('.set-controls[data-output-busy="false"]'))return null;const s=await statuses();return s.every((o,i)=>o.renderedRevision!==ctaOpen[i].renderedRevision&&!o.transitioning)?s:null;});
  if(ctaClosed.some((o,i)=>o.scene3dContexts!==ready[i].scene3dContexts))throw Error('CTA recreated music-reactive 3D contexts');
  checks.push({check:'Producer CTA opens and closes on both outputs while DJ audio keeps playing',contexts:ctaClosed.map(o=>o.scene3dContexts)});
  checks.push(await verifySoundPopups(room));
  await click('DROP ⚡');await until('Manual Drop on both outputs',async()=>{const s=await statuses();return s.every(o=>o.djVisuals.some(v=>v.role==='stage'&&v.dropActive))?true:null;});
  await click('Get Money 💸');const money=await until('Money rain on both outputs',async()=>{const s=await statuses();return s.every(o=>o.djVisuals.some(v=>v.role==='stage'&&v.moneyParticles===36))?s:null;});
  checks.push({check:'manual Drop and Get Money buttons work on both outputs',visuals:money.map(o=>o.djVisuals)});
  await sleep(6500);const extended=await statuses();
  if(extended.some(o=>!o.djVisuals.some(v=>v.role==='stage'&&v.dropActive)))throw Error('Extended Drop stopped before its second half');
  checks.push({check:'Drop remains active beyond six seconds on both native outputs',visuals:extended.map(o=>o.djVisuals)});
  await click('Waveform line');await click('Steel highlights');await sleep(1200);
  const changed=await statuses();if(changed.some((o,i)=>o.scene3dContexts!==ready[i].scene3dContexts))throw Error('Effects controls recreated 3D contexts');
  checks.push({check:'waveform and lighting controls retain native renderer contexts',contexts:changed.map(o=>o.scene3dContexts)});
  await dj.control({kind:'pause',deck:0});await until('Paused mix silent',async()=>{const s=await dj.control({kind:'status'});return s.audio?.energy===0?true:null;});
  await click('Stop money rain');const quiet=await until('Effects settle after pause',async()=>{const s=await statuses();return s.every(o=>o.djVisuals.every(v=>v.energy<.01&&v.moneyParticles===0&&!v.dropActive))?s:null;},12000);
  checks.push({check:'pause silences reaction and completed effects settle',visuals:quiet.map(o=>o.djVisuals)});
  checks.push(await soundLibraryPreviewProof(room));await report({ok:true});
 }catch(error){await report({ok:false,error:String(error),preparation:preparationDebug(),controls:[...document.querySelectorAll('.set-controls')].map(n=>({text:n.textContent,ready:n.getAttribute('data-layouts-ready'),busy:n.getAttribute('data-output-busy'),output:n.querySelector('.set-output-switch')?.getAttribute('data-output')})),alerts:[...document.querySelectorAll('[role=alert],.set-error')].map(n=>n.textContent)}).catch(()=>{});}
 finally{if(restore){await dj.control({kind:'clear'}).catch(()=>{});const {volume,crossfader,fade,repeat,shuffle,duck}=restore;await dj.control({kind:'mix',volume,crossfader,fade,repeat,shuffle,duck}).catch(()=>{});}}
}
