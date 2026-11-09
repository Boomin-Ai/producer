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
const bundle=await build({stdin:{contents:`
 import React,{useState,useEffect,useCallback,useRef} from 'react';
 import {createRoot} from 'react-dom/client';
 import {previewExit,previewSession} from './src/lib/previewSession';
 const counters=window.counts={mounts:0,closes:0,attaches:0,detaches:0,appearanceStarts:0,appearanceStops:0};
 const endpoint={id:'local',kind:'connected',base_url:'https://local.example'};
 const room={id:'selected',name:'Active room',endpoint_id:'local',config:'{}'};
 const accessAnswer={available:true,access:{role:'host',can:{manage:true}}};
 const ipc={liveListRooms:async()=>[room,{...room,id:'different'}],liveEngineStatus:async()=>({session_state:window.outputs.stream?'streaming':'idle'})};
 const recording={list:async()=>window.outputs.record?[{status:'recording'}]:[]};
 const guests={access:async()=>accessAnswer};
 const invoke=async()=>window.candidate;
 const producerLocalAccess=async()=>({raw:accessAnswer});
 const activeEndpointId=()=>window.workspace;
 const isBoomin=()=>true,markRoomClick=()=>{},roomMetadata=()=>({server_room_id:'local-server-room'});
 const notify=message=>window.lastNotice=message;
 const detach=async()=>{counters.detaches++;if(window.delayDetach)await new Promise(resolve=>window.finishDetach=resolve);};
 function Preview(){useEffect(()=>{const session=previewSession({attach:async()=>{counters.attaches++;return false;},move:async()=>{},detach},()=>{});void session.sync(()=>({x:0,y:0,width:640,height:360}));return()=>{void session.close();};},[]);return <span data-preview/>;}
 function LiveView(props){
  useEffect(()=>{counters.mounts++;return()=>{counters.closes++;};},[]);
  useEffect(()=>{window.reportRuntime=patch=>props.onRuntimeState({roomId:props.room.id,outputsActive:window.outputs.stream||window.outputs.record||!!window.outputs.starting,outputPortrait:true,programReady:true,...patch});window.reportRuntime({});},[props.onRuntimeState,props.room.id]);
  useEffect(()=>{if(!props.outgoingSeat)return;counters.appearanceStarts++;return()=>{counters.appearanceStops++;};},[props.outgoingSeat?.joinUrl]);
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
  useEffect(()=>{window.openLocal=()=>setView({kind:'room',room});window.reopen=()=>openRoom(room);window.openWrong=()=>openRoom({...room,id:'different'});window.join=async(id='selected')=>startSeat({endpointId:'local',localRoomId:id,videoSource:'program',joinUrl:'https://guest.example/gi_saved'},new AbortController().signal);window.inspect=()=>({view:view.kind,retained:retainedRoom?.room.id,appearance:outgoingSeat,nativeAppearances});});
  return withExitCover(view.kind==='room'?null:<div id="home">Home</div>);
 }
 createRoot(document.getElementById('root')).render(<Harness/>);
 `,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'iife'});
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
try{
 const scenario=async(candidate,outputs)=>{
  const page=await browser.newPage();await page.setContent('<div id="root"></div>');
  await page.evaluate(({candidate,outputs})=>{window.candidate=candidate;window.outputs=outputs;window.workspace='local';},{candidate,outputs});
  await page.addScriptTag({content:bundle.outputFiles[0].text});await page.waitForFunction(()=>typeof window.openLocal==='function');
  if(candidate)await page.waitForFunction(()=>window.inspect().nativeAppearances);
  await page.evaluate(()=>window.openLocal());await page.waitForFunction(()=>window.counts.attaches===1);
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
 const legacy=await scenario(false,{stream:true,record:false});await legacy.click('#collapse');await legacy.waitForFunction(()=>window.counts.closes===1);assert.equal(await legacy.evaluate(()=>window.inspect().retained),undefined);await legacy.close();
 console.log('PASS appearance room lifecycle: candidate stream/record retention, stable controller attachment, independent leave, wrong-room rejection, output-stop release, preview receipt ordering and unchanged default collapse.');
}finally{await browser.close();}
