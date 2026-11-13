import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';

const home=(await readFile(new URL('../src/views/Home.tsx',import.meta.url),'utf8')).replaceAll('\r\n','\n');
const between=(from,to)=>{const start=home.indexOf(from),end=home.indexOf(to,start);assert(start>=0&&end>start,from);return home.slice(start,end);};
// Run the production state, navigation, admission callback and stable render
// wrapper. Only the media-heavy room is replaced, so mount/cleanup counts
// catch a key, parent or routing change that silently reconstructs it.
const state=between('  const [view, setView] = useState<MainView>','  const [networkSheet,setNetworkSheet]');
const navigate=between('  const openRoom = (room: LiveRoom) => {','  /** Take a seat in someone else');
const attach=between('  const startSeat = useCallback(','  if (view.kind === "opening")');
const liveEntry=between('  const enter = async (r: NetworkLiveRoom) => {','  return (\n    <section className="cr-section" id="sec-livenow">');
const dealEntry=between('  const enterDeal = async (d: NetworkDeal, hostName: string) => {','  const book = async');
const seatFixture=`export class GuestSeat {
 constructor(spec){this.spec=spec;this.state={phase:'live',message:'',mediaMode:'program',nativeProgram:true};this.listeners=new Set();this.closed=false;this.flight=null;(window.seatOwners??=[]).push(this);}
 snapshot(){return this.state;}
 subscribe(fn){this.listeners.add(fn);return()=>this.listeners.delete(fn);}
 async start(){this.started=true;window.counts.appearanceStarts++;}
 phase(phase){this.state={...this.state,phase,message:phase==='error'?'The appearance connection ended.':''};for(const fn of this.listeners)fn();}
 leave(retry=false){if(this.closed)return Promise.resolve();if(this.flight&&!retry)return this.flight;window.counts.leaveAttempts=(window.counts.leaveAttempts??0)+1;this.listeners.clear();
  const pending=!this.started?Promise.resolve():window.retirementMode==='pending'?new Promise((resolve,reject)=>{this.resolveRetirement=window.resolveRetirement=resolve;this.rejectRetirement=window.rejectRetirement=reject;}):window.retirementMode==='failed'?Promise.reject(Error('PRIVATE_STOP_FAILURE')):Promise.resolve();
  this.flight=pending.then(()=>{if(!this.closed){this.closed=true;if(this.started)window.counts.appearanceStops++;}},error=>{this.flight=null;throw error;});return this.flight;
 }
}`;
const bundle=await build({stdin:{contents:`
 import React,{useState,useEffect,useCallback,useRef} from 'react';
 import {createRoot} from 'react-dom/client';
 import {previewExit,previewSession} from './src/lib/previewSession';
 import {useGuestSeat} from './src/views/GuestSeat';
 import {useRoomControl} from './src/features/room-control/useRoomControl';
 const counters=window.counts={mounts:0,closes:0,attaches:0,detaches:0,appearanceStarts:0,appearanceStops:0};
 const endpoint={id:'local',kind:'connected',base_url:'https://local.example'};
 const room={id:'selected',name:'Active room',endpoint_id:'local',config:'{}'};
 const accessAnswer={available:true,access:{role:'host',can:{manage:true}}};
 const ipc={liveListRooms:async()=>[room,{...room,id:'different'}],liveEngineStatus:async()=>({session_state:window.outputs.stream?'streaming':'idle'})};
 const recording={list:async()=>window.outputs.record?[{status:'recording'}]:[]};
 const guests={access:async()=>accessAnswer};
 const network={enterRoom:async()=>{counters.roomEntries=(counters.roomEntries??0)+1;return {};},enterDeal:async()=>{counters.dealEntries=(counters.dealEntries??0)+1;return {};}};
 const invoke=async()=>window.candidate;
 const producerLocalAccess=async()=>({raw:accessAnswer});
 const activeEndpointId=()=>window.workspace;
 const isBoomin=()=>true,markRoomClick=()=>{},roomMetadata=()=>({server_room_id:'local-server-room'});
 const notify=message=>window.lastNotice=message;
 const detach=async()=>{counters.detaches++;if(window.delayDetach)await new Promise(resolve=>window.finishDetach=resolve);};
 function Preview(){useEffect(()=>{const session=previewSession({attach:async()=>{counters.attaches++;return false;},move:async()=>{},detach},()=>{});void session.sync(()=>({x:0,y:0,width:640,height:360}));return()=>{void session.close();};},[]);return <span data-preview/>;}
 function LiveView(props){
  const [seatReady,setSeatReady]=useState(window.initialSeatReady!==false);useEffect(()=>{window.setSeatReady=setSeatReady;},[]);
  useEffect(()=>{counters.mounts++;return()=>{counters.closes++;};},[]);
  useEffect(()=>{window.reportRuntime=patch=>props.onRuntimeState({roomId:props.room.id,outputsActive:window.outputs.stream||window.outputs.record||!!window.outputs.starting,outputPortrait:true,programReady:true,...patch});window.reportRuntime({});},[props.onRuntimeState,props.room.id]);
  useGuestSeat(props.outgoingSeat,undefined,seatReady);
  return <div data-room hidden={!props.visible}>{props.visible&&<Preview/>}<button id="collapse" onClick={props.onLeave}>Collapse</button><button id="settings" onClick={props.onOpenIntegrations}>Settings</button><button id="leave-appearance" onClick={props.onLeaveAppearance}>Leave appearance</button></div>;
 }
 function Harness(){
  ${state}
  const endpoints=[endpoint],activeId='local';
  const [exitState,setExitState]=useState('idle'),roomExit=useRef(null);
  roomExit.current??=previewExit(detach,setExitState);
  const exitCover=exitState==='idle'?null:<div id="exit-cover">{exitState}</div>;
  const loadLive=()=>{},setManagerRecordingId=()=>{},setSurface=()=>{},setSettingsSection=()=>{},openSettings=()=>setView({kind:'home'}),setNetworkSheet=()=>{},setPendingSeat=()=>{};
  ${navigate}
  ${attach}
  const endpointId='local',onBeforeEnterSeat=beforeEnterSeat,onEnterSeat=()=>{},setEntering=()=>{},setNote=()=>{},isRoomClosedError=()=>false,load=()=>{};
  ${liveEntry}
  ${dealEntry}
  useEffect(()=>{window.forceNetworkEntry=async()=>{await enter({room_id:'remote',brand:{name:'Host'}});await enterDeal({id:'deal'},'Host');};window.blockLegacy=()=>setView({kind:'seat'});window.openLocal=()=>setView({kind:'room',room});window.reopen=()=>openRoom(room);window.openWrong=()=>openRoom({...room,id:'different'});window.join=async(id='selected')=>startSeat({endpointId:'local',localRoomId:id,videoSource:'program',apiBase:'https://api.boomin.ai/v1/connect',joinUrl:'https://guest.example/gi_saved'},new AbortController().signal);window.inspect=()=>({view:view.kind,retained:retainedRoom?.room.id,appearance:outgoingSeat,nativeAppearances,appearanceExit,owner:outgoingRuntime?.owner===window.seatOwners?.at(-1)});});
  return withExitCover(view.kind==='room'?null:<div id="home">Home</div>);
 }
 createRoot(document.getElementById('root')).render(window.strictProbe?<React.StrictMode><Harness/></React.StrictMode>:<Harness/>);
 `,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'iife',define:{'import.meta.env.DEV':'false'},plugins:[{name:'owned-seat-fixture',setup(b){
 b.onResolve({filter:/\/lib\/guestSeat$/},()=>({path:'seat',namespace:'fixture'}));
 b.onResolve({filter:/\.css$/},()=>({path:'css',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='seat'?seatFixture:'',loader:'js'}));
 }}]});
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
try{
 const scenario=async(candidate,outputs,{open=true,strict=false,ready=true}={})=>{
  const page=await browser.newPage();await page.setContent('<div id="root"></div>');
  await page.evaluate(({candidate,outputs,strict,ready})=>{window.candidate=candidate;window.outputs=outputs;window.workspace='local';window.strictProbe=strict;window.initialSeatReady=ready;},{candidate,outputs,strict,ready});
  await page.addScriptTag({content:bundle.outputFiles[0].text});await page.waitForFunction(()=>typeof window.openLocal==='function');
  if(candidate)await page.waitForFunction(()=>window.inspect().nativeAppearances);
  if(open){await page.evaluate(()=>window.openLocal());await page.waitForFunction(()=>window.counts.attaches===1);}
  return page;
 };
 for(const outputs of [{stream:true,record:false},{stream:false,record:true},{stream:true,record:true},{stream:false,record:false,starting:true}]){
  const page=await scenario(true,outputs);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.click('#collapse');await page.waitForSelector('#home');
  assert.equal(await page.evaluate(()=>window.counts.closes),0);assert.equal(await page.evaluate(()=>document.querySelector('[data-preview]')),null);
  await page.evaluate(()=>window.openWrong());assert.equal(await page.evaluate(()=>window.counts.mounts),1);assert.match(await page.evaluate(()=>window.lastNotice),/active local room/);
  await page.evaluate(async()=>{try{await window.join('different');throw Error('Wrong room accepted');}catch(error){if(!error.message.includes('currently active'))throw error;}});
  assert.equal(await page.evaluate(()=>window.counts.appearanceStarts),0);
  await page.evaluate(()=>window.join());await page.waitForFunction(()=>window.counts.appearanceStarts===1&&window.counts.attaches===2);
  assert.equal(await page.evaluate(()=>window.counts.mounts),1);assert.equal(await page.evaluate(()=>window.inspect().appearance.portrait),true);
  await page.click('#leave-appearance');await page.waitForFunction(()=>window.counts.appearanceStops===1);
  assert.equal(await page.evaluate(()=>window.counts.closes),0);assert.equal(await page.evaluate(()=>window.inspect().view),'room');
  await page.click('#collapse');await page.waitForSelector('#home');
  await page.evaluate(()=>{window.outputs={stream:false,record:false};window.reportRuntime({outputsActive:false});});await page.waitForFunction(()=>window.counts.closes===1);
  assert.deepEqual(errors,[]);await page.close();
 }
 // Integrations/Access also navigate synchronously; retention must precede
 // their surface change even while native concealment is still pending.
 const settings=await scenario(true,{stream:true,record:false});
 await settings.evaluate(()=>{window.delayDetach=true;});await settings.click('#settings');
 await settings.waitForFunction(()=>typeof window.finishDetach==='function');
 assert.equal(await settings.evaluate(()=>window.counts.mounts),1);assert.equal(await settings.evaluate(()=>window.counts.closes),0);
 await settings.evaluate(()=>{window.delayDetach=false;window.finishDetach();});await settings.waitForSelector('#home');
 assert.equal(await settings.evaluate(()=>window.counts.mounts),1);assert.equal(await settings.evaluate(()=>window.counts.closes),0);
 await settings.close();
 // Native concealment remains a receipt: reopening during a pending detach
 // must not attach either new native preview until concealment completes.
 const delayed=await scenario(true,{stream:true,record:false});
 await delayed.evaluate(()=>{window.delayDetach=true;});await delayed.click('#collapse');await delayed.waitForFunction(()=>typeof window.finishDetach==='function');
 await delayed.evaluate(()=>window.reopen());assert.equal(await delayed.evaluate(()=>window.counts.attaches),1);
 await delayed.evaluate(()=>{window.delayDetach=false;window.finishDetach();});await delayed.waitForFunction(()=>window.counts.attaches===2);
 assert.equal(await delayed.evaluate(()=>window.counts.mounts),1);await delayed.close();
 const legacy=await scenario(false,{stream:true,record:false});await legacy.click('#collapse');await legacy.waitForFunction(()=>window.counts.closes===1);assert.equal(await legacy.evaluate(()=>window.inspect().retained),undefined);
 await legacy.evaluate(()=>window.blockLegacy());await legacy.waitForFunction(()=>window.inspect().view==='seat');await legacy.evaluate(()=>window.forceNetworkEntry());assert.deepEqual(await legacy.evaluate(()=>[window.counts.roomEntries??0,window.counts.dealEntries??0]),[0,0]);await legacy.close();
 // Actual Home + useGuestSeat lifecycle: cards retain visible controls and
 // an uncertain retirement never releases the guard or the local output.
 const leaving=await scenario(true,{stream:true,record:false});
 await leaving.evaluate(()=>window.join());await leaving.waitForFunction(()=>window.counts.appearanceStarts===1);
 await leaving.click('#collapse');await leaving.getByRole('region',{name:'Current appearance'}).waitFor();
 await leaving.getByRole('button',{name:'Return to appearance',exact:true}).click();await leaving.waitForFunction(()=>window.inspect().view==='room');
 assert.equal(await leaving.evaluate(()=>window.counts.mounts),1);assert.equal(await leaving.evaluate(()=>window.counts.appearanceStarts),1);
 await leaving.click('#collapse');await leaving.clock.install();await leaving.evaluate(()=>{window.retirementMode='pending';});
 await leaving.getByRole('button',{name:'Leave appearance',exact:true}).click();assert.equal(await leaving.evaluate(()=>window.inspect().appearanceExit),'closing');
 await leaving.evaluate(()=>window.forceNetworkEntry());assert.deepEqual(await leaving.evaluate(()=>[window.counts.roomEntries??0,window.counts.dealEntries??0]),[0,0]);
 await leaving.evaluate(async()=>{try{await window.join();throw Error('Duplicate accepted');}catch(e){if(!e.message.includes('Leave the current'))throw e;}});
 assert.equal(await leaving.evaluate(()=>window.counts.appearanceStops),0);assert.equal(await leaving.evaluate(()=>window.counts.closes),0);
 await leaving.clock.fastForward(5100);await leaving.getByRole('button',{name:'Retry leaving',exact:true}).waitFor();
 await leaving.evaluate(()=>{window.retirementMode='failed';});await leaving.getByRole('button',{name:'Retry leaving',exact:true}).click();await leaving.getByRole('button',{name:'Retry leaving',exact:true}).waitFor();
 assert.equal(await leaving.evaluate(()=>window.counts.leaveAttempts),2);
 await leaving.evaluate(()=>window.forceNetworkEntry());assert.deepEqual(await leaving.evaluate(()=>[window.counts.roomEntries??0,window.counts.dealEntries??0]),[0,0]);
 assert.equal(await leaving.evaluate(()=>!!window.inspect().appearance),true);assert.equal(await leaving.evaluate(()=>window.counts.closes),0);
 await leaving.evaluate(()=>{window.retirementMode='resolve';});await leaving.getByRole('button',{name:'Retry leaving',exact:true}).click();
 await leaving.waitForFunction(()=>!window.inspect().appearance);assert.equal(await leaving.evaluate(()=>window.counts.appearanceStops),1);assert.equal(await leaving.evaluate(()=>window.counts.closes),0);
 await leaving.evaluate(()=>window.forceNetworkEntry());assert.deepEqual(await leaving.evaluate(()=>[window.counts.roomEntries,window.counts.dealEntries]),[1,1]);await leaving.close();
 // Terminal cleanup is automatic only after the exact stop receipt. Old
 // runtime callbacks cannot clear or replace a successor using the same URL.
 const terminal=await scenario(true,{stream:false,record:false});await terminal.evaluate(()=>window.join());await terminal.waitForFunction(()=>window.counts.appearanceStarts===1);
 await terminal.click('#collapse');await terminal.evaluate(()=>{window.retirementMode='failed';window.seatOwners[0].phase('error');});
 await terminal.getByRole('button',{name:'Retry leaving',exact:true}).waitFor();assert.equal(await terminal.evaluate(()=>window.counts.leaveAttempts),1);assert.equal(await terminal.evaluate(()=>!!window.inspect().appearance),true);
 await terminal.evaluate(()=>{window.retirementMode='pending';});await terminal.getByRole('button',{name:'Retry leaving',exact:true}).click();assert.equal(await terminal.evaluate(()=>!!window.inspect().appearance),true);
 await terminal.evaluate(()=>window.resolveRetirement());await terminal.waitForFunction(()=>!window.inspect().appearance&&window.counts.closes===1);
 await terminal.evaluate(()=>{window.retirementMode='resolve';return window.join();});await terminal.waitForFunction(()=>window.counts.appearanceStarts===2&&window.inspect().owner);
 await terminal.evaluate(()=>{window.seatOwners[0].spec.onRuntime(null);window.seatOwners[0].spec.onRuntime(window.seatOwners[0]);});
 assert.equal(await terminal.evaluate(()=>!!window.inspect().appearance&&window.inspect().owner),true);assert.equal(await terminal.evaluate(()=>window.counts.appearanceStops),1);await terminal.close();
 const strict=await scenario(true,{stream:false,record:false},{open:false,strict:true});await strict.evaluate(()=>window.join());
 await strict.waitForFunction(()=>window.counts.appearanceStarts===2&&window.counts.appearanceStops===1&&window.inspect().owner);
 await strict.click('#collapse');await strict.getByRole('button',{name:'Leave appearance',exact:true}).click();
 await strict.waitForFunction(()=>!window.inspect().appearance&&window.counts.appearanceStops===2);await strict.close();
 const startup=await scenario(true,{stream:false,record:false},{open:false,ready:false});await startup.evaluate(()=>window.join());await startup.waitForFunction(()=>typeof window.setSeatReady==='function');
 assert.equal(await startup.evaluate(()=>window.counts.appearanceStarts),0);await startup.evaluate(()=>window.setSeatReady(true));await startup.waitForFunction(()=>window.counts.appearanceStarts===1);await startup.close();
 // Local readiness may fluctuate during a Set update. The initially-bound
 // native owner must survive it, including while exact retirement is pending.
 const overlapping=await scenario(true,{stream:true,record:false});await overlapping.evaluate(()=>window.join());await overlapping.waitForFunction(()=>window.counts.appearanceStarts===1);
 await overlapping.evaluate(()=>window.setSeatReady(false));await overlapping.waitForTimeout(20);
 assert.equal(await overlapping.evaluate(()=>window.counts.leaveAttempts??0),0);assert.equal(await overlapping.evaluate(()=>window.seatOwners[0].closed),false);
 await overlapping.evaluate(()=>window.setSeatReady(true));await overlapping.waitForTimeout(20);assert.equal(await overlapping.evaluate(()=>window.counts.appearanceStarts),1);
 await overlapping.click('#collapse');await overlapping.evaluate(()=>{window.retirementMode='pending';});await overlapping.getByRole('button',{name:'Leave appearance',exact:true}).click();await overlapping.waitForFunction(()=>!!window.seatOwners[0].resolveRetirement);
 await overlapping.evaluate(()=>window.setSeatReady(false));await overlapping.waitForTimeout(20);await overlapping.evaluate(()=>window.setSeatReady(true));await overlapping.waitForTimeout(20);
 assert.equal(await overlapping.evaluate(()=>window.counts.appearanceStarts),1);assert.equal(await overlapping.evaluate(()=>!!window.inspect().appearance),true);
 await overlapping.evaluate(()=>window.seatOwners[0].resolveRetirement());await overlapping.waitForFunction(()=>!window.inspect().appearance&&window.counts.appearanceStops===1);
 assert.equal(await overlapping.evaluate(()=>window.counts.closes),0);await overlapping.close();
 console.log('PASS appearance room lifecycle: retained outputs, cards return/leave, pending and failed stop retry, terminal cleanup after receipts, StrictMode and native readiness fencing, preview ordering and unchanged default collapse.');
}finally{await browser.close();}
