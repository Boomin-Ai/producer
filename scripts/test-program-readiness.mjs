import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
let source=await fs.readFile(new URL('../src/lib/monitorFeed.ts',import.meta.url),'utf8');
source=source.replace(/import \{ connectApiBase, inviteCodeFromJoinUrl \} from "\.\/guestSeat";/,'const connectApiBase=(s)=>s; const inviteCodeFromJoinUrl=()=>null;')
 .replace(/import \{ sharedProgramCapture, type ProgramLease \} from "\.\/programCapture";/,'const sharedProgramCapture={acquire:async()=>globalThis.lease}; type ProgramLease=any;')
 .replace(/import \{ uiLog \} from "\.\/ipc";/,'const uiLog=()=>{};');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ES2020}}).outputText;
const {MonitorSender}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
globalThis.window={setTimeout,clearTimeout};
globalThis.fetch=async()=>({ok:true,json:async()=>({signaling_url:'/signal',ice_servers:[]})});
globalThis.MediaStream=class{constructor(tracks){this.tracks=tracks;}getTracks(){return this.tracks;}};
let releases=0,captures=0,renews=0;
globalThis.lease={video:{addEventListener(){}},audio:{},release(){releases++;}};
const socket=[];
globalThis.WebSocket=class{static OPEN=1;readyState=1;sent=[];constructor(){socket.push(this);}send(s){this.sent.push(JSON.parse(s));}close(){}};
const peers=[];
globalThis.RTCPeerConnection=class{
 signalingState='stable'; localDescription={type:'offer',sdp:'missing-first-offer'};tracks=[];
 constructor(){peers.push(this);}createDataChannel(){return{readyState:'connecting',close(){}};}
 addTrack(track){this.tracks.push(track);captures++;return{replaceTrack:async()=>{}};}
 restartIce(){renews++;}close(){}getTransceivers(){return[];}addTransceiver(){}
};
const sender=new MonitorSender({renderUrl:'https://fixture.test/render/test?k=test',apiBase:'https://fixture.test',peer:'program',audioBus:1});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
sender.start();await tick();const ws=socket[0],pc=peers[0];ws.onopen();await tick();
assert.equal(captures,0,'Initial signaling must not bypass guest readiness');
const ready=async(peer)=>{await ws.onmessage({data:JSON.stringify({type:'signal',payload:{kind:'program-ready',...(peer?{peer}: {})}})});await tick();};
await ready('main');assert.equal(captures,2,'Legacy readiness must start video and audio');
pc.signalingState='have-local-offer';ws.sent=[];
await ready('program');assert.equal(ws.sent.at(-1).payload.description.sdp,'missing-first-offer','A retry must re-send an offer that was missed');
pc.signalingState='stable';await ready('program');assert.equal(renews,1,'A replacement receiver needs fresh ICE');
assert.equal(captures,2,'Retries must share existing capture');
sender.stop();assert.equal(releases,1);
console.log('PASS: guest readiness gates capture, legacy requests work, missed offers resend, and replacement receivers renew ICE without duplicate capture.');
