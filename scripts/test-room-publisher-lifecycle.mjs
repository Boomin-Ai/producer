import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import ts from 'typescript';

// Execute Live's production effect and the real control-link owner. Native
// calls and sockets are local fixtures; no application or server is started.
const source=await readFile(new URL('../src/views/Live.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('Live.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const effects=[];
function visit(node){
 if(ts.isCallExpression(node)&&node.expression.getText(tree)==='useEffect'&&node.arguments[0]?.getText(tree).includes('new RoomControlLink'))effects.push(node.getText(tree));
 ts.forEachChild(node,visit);
}
visit(tree);assert.equal(effects.length,1,'Find exactly one production room-control lifecycle');
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 import React,{useEffect,useRef} from 'react';
 import {createRoot} from 'react-dom/client';
 import {RoomControlLink} from './src/lib/roomControl';
 import {BOOMIN_ROOM_CHANNELS,parseBoominFrame} from './src/lib/boominRoom';
 import {notify,notifyError,dismiss,dismissKey,subscribeNotices} from './src/lib/notices';
 const noop=()=>{},deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
 // about:blank is not a secure context; keep request IDs unique in this
 // isolated wire fixture without requiring a served application origin.
 let uuid=0;crypto.randomUUID=()=> '00000000-0000-4000-8000-'+String(++uuid).padStart(12,'0');
 window.fixture={sockets:[],logs:[],notices:[],dismissed:[],tickets:[],endpoints:[],moduleCloses:0};
 const f=window.fixture;
 subscribeNotices(list=>{f.notices=list.map(notice=>({...notice}));});
 window.WebSocket=class{
  static OPEN=1;readyState=0;sent=[];closeRequests=0;
  constructor(url){this.url=url;f.sockets.push(this);}
  send(raw){this.sent.push(JSON.parse(raw));}
  close(){this.closeRequests++;this.readyState=2;}
 };
 window.wire={
  open(index){const s=f.sockets[index];s.readyState=1;s.onopen?.();},
  frame(index,frame){f.sockets[index].onmessage?.({data:JSON.stringify(frame)});},
  close(index){const s=f.sockets[index];s.readyState=3;s.onclose?.();},
  ack(index){const s=f.sockets[index],request=s.sent.filter(x=>x.type==='scene.publish').at(-1);if(!request)throw Error('No registration to acknowledge');this.frame(index,{type:'scene.published',publisher_protocol:1,request_id:request.request_id,epoch:1,sequence:0});},
 };
 const endpoint={id:'workspace',kind:'connected',hosted:true,base_url:'https://workspace.invalid/v1/app/producer'};
 window.endpointGate=deferred();window.ticketGate=null;
 const resolveActiveEndpoint=()=>{f.endpoints.push({});return window.endpointGate.promise;};
 const isBoomin=ep=>ep.hosted;
 const guestsIpc={
  controlSession:async(ep,room)=>{f.tickets.push({ep,room});if(window.ticketGate)return window.ticketGate.promise;return {signaling_ticket:'fixture',signaling_url:'/room',publisher_protocol:1,role:window.props.role};},
  interactions:async()=>({interactions:[]}),
 };
 const modulePushPublisher=()=>({frame:noop,offline:noop,close:()=>f.moduleCloses++});
 const uiLog=value=>f.logs.push(value);
 const normalizeBoominInteraction=value=>value;
 const presentationRelay={flush:noop};
 function Controller(props){
  const room={id:props.room},cfg={server_room_id:props.serverRoom??props.room},seat=props.seat;
  const roomRole=props.role,boominRoom=props.boomin,accessPending=props.pending;
  const roomRoleRef=useRef(roomRole);roomRoleRef.current=roomRole;
  const accessAsked=useRef(!props.pending);accessAsked.current=!props.pending;
  const sceneOrderRef=useRef({epoch:0,sequence:0}),controlHasSnapshot=useRef(false),sceneExecutionRef=useRef(Promise.resolve());
  const scenesRef=useRef([{id:'one',name:'One'}]),activeSceneRef=useRef('one');
  const controlRef=useRef(null),votesRef=useRef(new Map()),selectedVoteRef=useRef(null),audienceSenders=useRef(new Map());
  const presentedSession=useRef({moduleSnapshot:()=>({})});
  const setVote=noop,setSavedVotes=noop,setAudienceError=noop,setAudienceChatRoom=noop,setAudienceState=noop,setAudienceHands=noop,onInteractionFrame=noop;
  const publishSourceTruth=()=>{if(roomRoleRef.current==='host')controlRef.current?.publishSources([],['participant'],[]);};
  ${effects[0]};
  useEffect(()=>{window.controller={publishSourceTruth,link:()=>controlRef.current};});
  return null;
 }
 const root=createRoot(document.getElementById('root'));
 window.props={room:'room-a',role:'host',boomin:false,pending:true};
 window.render=patch=>{window.props={...window.props,...patch};root.render(window.props.mounted===false?null:<React.StrictMode><Controller key={window.props.room} {...window.props}/></React.StrictMode>);};
 window.resolveEndpoint=(overrides={})=>window.endpointGate.resolve({...endpoint,...overrides});
 window.makeTicketGate=()=>window.ticketGate=deferred();
 window.resolveTicket=()=>{window.ticketGate.resolve({signaling_ticket:'fixture-late',signaling_url:'/room',publisher_protocol:1,role:window.props.role});window.ticketGate=null;};
 window.render({});
 `},bundle:true,platform:'browser',format:'iife',write:false});

const modulePath=process.env.PRODUCER_PLAYWRIGHT_MODULE??new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href;
const {chromium}=await import(modulePath);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
const errors=[];
const fixture=async()=>{
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.clock.install();
 await page.route('**/*',route=>route.abort());
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.waitForFunction(()=>window.fixture?.endpoints.length>0,null,{timeout:5000,polling:50}).catch(async error=>{
  throw Error('Live effect fixture did not start: '+JSON.stringify({errors,fixture:await page.evaluate(()=>window.fixture)})+'; '+error.message);
 });return page;
};
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
try{
 const cold=await fixture();
 assert.equal(await cold.evaluate(()=>window.fixture.tickets.length),0,'No native ticket before endpoint resolution');
 await cold.evaluate(()=>window.resolveEndpoint());await cold.waitForFunction(()=>window.fixture.sockets.length===1);
 await cold.evaluate(()=>window.wire.open(0));
 assert.equal(await cold.evaluate(()=>window.fixture.sockets[0].sent.filter(f=>f.type==='scene.publish').length),1);
 assert.equal(await cold.evaluate(()=>window.fixture.sockets[0].sent.filter(f=>f.type==='room.sources.publish').length),0,'Capability-aware host waits for registration receipt');
 await cold.evaluate(()=>window.wire.ack(0));
 assert.equal(await cold.evaluate(()=>window.fixture.sockets[0].sent.filter(f=>f.type==='room.sources.publish').length),1);
 await cold.evaluate(()=>window.render({boomin:true,pending:false}));await settle(cold);
 assert.equal(await cold.evaluate(()=>window.fixture.sockets.length),1,'Resolved hosted/access metadata must preserve the cold host socket');
 assert.equal(await cold.evaluate(()=>window.fixture.sockets[0].closeRequests),0,'Metadata resolution must not retire the registered owner');
 await cold.close();

 const pending=await fixture();
 await pending.evaluate(()=>window.render({mounted:false}));await settle(pending);
 await pending.evaluate(()=>window.resolveEndpoint());await settle(pending);
 assert.equal(await pending.evaluate(()=>window.fixture.sockets.length),0,'Unmount fences deferred endpoint resolution');
 assert.equal(await pending.evaluate(()=>window.fixture.tickets.length),0);
 await pending.close();

 const ticket=await fixture();
 await ticket.evaluate(()=>{window.makeTicketGate();window.resolveEndpoint();});
 await ticket.waitForFunction(()=>window.fixture.tickets.length===1);
 await ticket.evaluate(()=>window.render({mounted:false}));await settle(ticket);
 await ticket.evaluate(()=>window.resolveTicket());await settle(ticket);
 assert.equal(await ticket.evaluate(()=>window.fixture.sockets.length),0,'Unmount fences deferred native ticket');
 await ticket.evaluate(()=>window.render({mounted:true,room:'room-b',boomin:true,pending:false}));
 await ticket.waitForFunction(()=>window.fixture.sockets.length===1);
 assert.equal(await ticket.evaluate(()=>window.fixture.tickets.at(-1).room),'room-b','Reopen mints for the exact successor room');
 await ticket.close();

 const reopen=await fixture();
 await reopen.evaluate(()=>window.resolveEndpoint());await reopen.waitForFunction(()=>window.fixture.sockets.length===1);
 await reopen.evaluate(()=>{window.wire.open(0);window.wire.ack(0);window.wire.frame(0,{type:'error',code:'stale_publisher'});});
 assert.equal(await reopen.evaluate(()=>window.fixture.notices.filter(n=>n.key==='room-publisher').length),1,'Room A rejection reaches the real Activity store');
 await reopen.evaluate(()=>window.render({mounted:false}));await settle(reopen);
 assert.equal(await reopen.evaluate(()=>window.fixture.sockets[0].closeRequests),1);
 assert.equal(await reopen.evaluate(()=>window.fixture.notices.length),0,'Unmount removes the exact Room A error from the real Activity store');
 await reopen.evaluate(()=>window.render({mounted:true,room:'room-b',boomin:true,pending:false}));await reopen.waitForFunction(()=>window.fixture.sockets.length===2);
 await reopen.evaluate(()=>{window.wire.open(1);window.wire.ack(1);});
 assert.equal(await reopen.evaluate(()=>window.fixture.notices.length),0,'Healthy Room B does not inherit Room A ownership errors');
 await reopen.evaluate(()=>window.wire.frame(1,{type:'error',code:'publisher_busy'}));
 assert.equal(await reopen.evaluate(()=>window.fixture.notices.find(n=>n.key==='room-publisher')?.text),'Reconnecting room controls…','Automatic retries do not ask the user to reopen');
 const successorNotice=await reopen.evaluate(()=>window.fixture.notices.find(n=>n.key==='room-publisher')?.id);
 assert.ok(successorNotice,'The successor owns its own Activity error');
 const before=await reopen.evaluate(()=>({notices:window.fixture.notices.length,sent:window.fixture.sockets[1].sent.length}));
 await reopen.evaluate(()=>{window.wire.frame(0,{type:'error',code:'stale_publisher'});window.wire.close(0);window.wire.ack(0);});await settle(reopen);
 assert.equal(await reopen.evaluate(()=>window.fixture.notices.length),before.notices,'Retired socket cannot surface stale ownership errors');
 assert.equal(await reopen.evaluate(()=>window.fixture.notices.find(n=>n.key==='room-publisher')?.id),successorNotice,'Old close/ACK cannot dismiss the successor error by shared key');
 assert.equal(await reopen.evaluate(()=>window.fixture.sockets[1].closeRequests),0,'Old close cannot retire the successor');
 await reopen.evaluate(()=>window.wire.frame(1,{type:'scene.state',scenes:[{id:'one',name:'One'}],active_scene_id:'one',epoch:9,sequence:9}));
 assert.equal(await reopen.evaluate(()=>window.fixture.notices.find(n=>n.key==='room-publisher')?.id),successorNotice,'Broadcast scene state cannot clear a rejected publisher');
 await reopen.clock.fastForward(1000);await reopen.evaluate(()=>window.wire.ack(1));
 assert.equal(await reopen.evaluate(()=>window.fixture.notices.length),0,'A confirmed matching successor receipt clears only its own incident');
 const recoveredCount=await reopen.evaluate(()=>window.fixture.sockets[1].sent.length);
 await reopen.evaluate(()=>window.controller.publishSourceTruth());
 assert.equal(await reopen.evaluate(()=>window.fixture.sockets[1].sent.length),recoveredCount+1,'Old callbacks cannot disable successor source publication');
 await reopen.evaluate(()=>window.render({role:'viewer'}));await reopen.waitForFunction(()=>window.fixture.sockets.length===3);
 await reopen.evaluate(()=>window.wire.open(2));
 assert.equal(await reopen.evaluate(()=>window.fixture.sockets[2].sent.filter(f=>f.type==='scene.publish').length),0,'Authoritative non-host role never publishes the local scene');
 assert.equal(await reopen.evaluate(()=>window.fixture.sockets[1].closeRequests),1,'Role replacement retires the prior host socket');
 await reopen.close();

 const conflict=await fixture();
 await conflict.evaluate(()=>window.resolveEndpoint());await conflict.waitForFunction(()=>window.fixture.sockets.length===1);
 await conflict.evaluate(()=>{window.wire.open(0);window.wire.frame(0,{type:'error',code:'publisher_busy'});});
 for(const delay of [1000,2000,4000,8000,15000]){
  await conflict.clock.fastForward(delay);
  await conflict.evaluate(()=>window.wire.frame(0,{type:'error',code:'publisher_busy'}));
 }
 const finalConflict=await conflict.evaluate(()=>window.fixture.notices.find(n=>n.key==='room-publisher'));
 assert.equal(finalConflict.tone,'error');
 assert.match(finalConflict.text,/Another Producer session controls this room.*reopen/,'Exhausted retries retain the real conflict and explicit recovery action');
 assert.equal(await conflict.evaluate(()=>window.fixture.sockets[0].sent.filter(f=>f.type==='scene.publish').length),6);
 assert.ok(await conflict.evaluate(()=>window.fixture.logs.some(line=>line.includes('"code":"publisher_busy"')&&line.includes('"retrying":false'))),'The final conflict code stays on the record');
 await conflict.close();
 assert.deepEqual(errors,[]);
 console.log('PASS: production Live control effect preserves one cold hosted owner, gates source writes on registration, fences StrictMode/unmount/late endpoint and ticket results, scopes real Activity errors to their room owner, rejects stale socket callbacks and broadcast ownership claims, and honors role replacement. No app, native profile or network used.');
}finally{await browser.close();}
