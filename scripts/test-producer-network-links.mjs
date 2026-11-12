import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';
const requests=[],saved=new Map();let loseResponse=false,legacy=false;
const storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)};
function load(file){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/'+file+'.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports,URL,Error,AbortSignal,localStorage:storage,crypto:{randomUUID},fetch:async(url,init)=>{requests.push({url,init});if(url.endsWith('/join-intent'))return {ok:!legacy,status:legacy?404:200,json:async()=>({join_intent:'saved-proof',expires_at_ms:Date.now()+60000})};if(loseResponse){loseResponse=false;throw Error('lost response');}return {ok:true,json:async()=>({invite_code:'gi_abcdefghijklmnopqrstuvwx'})};}});return exports;}
const {parseProducerJoinLink:parse,producerConnectBase:base,resolveProducerInvitation:resolve}=load('producerJoin');
const code='gr_abcdefghijklmnopqrstuvwx',invite='gi_abcdefghijklmnopqrstuvwx';
assert.equal(parse(`https://producer.dev/kleveland/guest/room-id/${code}`).apiBase,'https://api.boomin.ai');
const independent=parse(`https://studio.example/connect/guest/room/${code}`,'https://media.example/producer/v1/app/producer');
assert.equal(base(independent.apiBase),'https://media.example/producer/v1/connect');
const own=parse(`https://studio.example/connect/guest/${invite}`);assert.equal(own.kind,'invite');assert.equal(own.apiBase,'https://studio.example');
for(const bad of [`https://evil.example/kleveland/guest/id/${code}`,`https://u:p@studio.example/connect/guest/${invite}`,`javascript:alert(1)`,`https://studio.example/connect/mod/${invite}`,`https://studio.example/connect/guest/room/${invite}`,`http://internet.example/connect/guest/${invite}`])assert.throws(()=>parse(bad));
assert.equal(parse(`http://localhost:8787/connect/guest/room/${code}`).kind,'room');
assert.throws(()=>parse(`https://studio.example/connect/guest/${invite}`,'https://media.example/?token=secret'));
assert.equal(await resolve(own,'Me','producer'),own.joinUrl);assert.equal(requests.length,0);
loseResponse=true;await assert.rejects(resolve(independent,'Kleveland','Producer/local'),/lost response/);assert.equal(requests.length,2);assert.equal(JSON.parse(requests[1].init.body).join_intent,'saved-proof');
await resolve(independent,'Kleveland','Producer/local');assert.equal(requests.length,3);assert.equal(JSON.parse(requests[2].init.body).join_intent,'saved-proof');assert.equal(requests[2].url,`https://media.example/producer/v1/connect/guest/room/${code}/join`);assert.equal(requests[2].init.credentials,'omit');assert.equal(requests[2].init.redirect,'error');assert.equal(requests[2].init.headers.Authorization,undefined);assert.equal(JSON.parse(requests[2].init.body).display_name,'Kleveland');
await resolve(independent,'Kleveland','Producer/local');assert.equal(requests.length,4);assert.equal(JSON.parse(requests[3].init.body).resume_code,invite);
legacy=true;await resolve(parse(`https://legacy.example/connect/guest/room/${code}`),'Me','Producer/local');assert.equal(requests.length,6);assert.equal(JSON.parse(requests[5].init.body).resume_code,undefined);assert.equal(JSON.parse(requests[5].init.body).join_intent,undefined);
const {NetworkEntryRequests,NetworkEntryError}=load('networkEntry'),entries=new NetworkEntryRequests(),ids=[];
let complete;const lost=new Promise((_,reject)=>{complete=reject;});
const send=id=>{ids.push(id);return lost;};const a=entries.enter('mac:room',send),b=entries.enter('mac:room',send);assert.equal(ids.length,1);complete(Error('connection lost'));await Promise.allSettled([a,b]);
const success=async id=>{ids.push(id);return {available:true,status:200,body:{join_url:'https://studio.example/connect/guest/'+invite}};};
await entries.enter('mac:room',success);assert.equal(ids[0],ids[1]);await entries.enter('mac:room',success);assert.notEqual(ids[1],ids[2]);await entries.enter('windows:room',success);assert.notEqual(ids[2],ids[3]);
for(const code of ['rtc_network_entry_superseded','rtc_request_reused','guest_not_acceptable']){
 const queue=new NetworkEntryRequests(),attempts=[];
 const reject=async id=>{attempts.push(id);return {available:true,status:409,body:{code,message:'Generic server text'}};};
 await assert.rejects(queue.enter('same-room',reject),error=>error instanceof NetworkEntryError&&error.code===code&&error.status===409);
 assert.equal(attempts.length,1,'a definitive rejection must never automatically knock again');
 await assert.rejects(queue.enter('same-room',reject),error=>error.code===code);
 assert.notEqual(attempts[0],attempts[1],'a subsequent manual attempt must not reuse an invalid receipt');
}
for(const reply of [
 {available:true,status:409,body:{code:'network_room_closed',message:'Generic room conflict'}},
 {available:true,status:503,body:{code:'internal_error',message:'Try later'}},
 {available:true,status:200,body:{join_url:42}},
 {available:false,status:409,body:{code:'rtc_network_entry_superseded'}},
 {available:true,status:409,body:{code:'unknown_conflict'}},
]){
 const queue=new NetworkEntryRequests(),attempts=[],reject=async id=>{attempts.push(id);return reply;};
 await assert.rejects(queue.enter('retry-safe',reject));await assert.rejects(queue.enter('retry-safe',reject));
 assert.equal(attempts[0],attempts[1],'unknown/unavailable/host-closed attempts must remain retry-safe');
}
for(const body of [{code:'network_room_closed',message:'Generic server text'},{error:{code:'network_room_closed',message:'Nested legacy server text'}}]){
 await assert.rejects(new NetworkEntryRequests().enter('closed',async()=>({available:true,status:409,body})),error=>
  error.code==='network_room_closed'&&/host.*room connection is not ready/.test(error.message));
}
await assert.rejects(new NetworkEntryRequests().enter('legacy',async()=>({available:true,status:403,body:{error:'Workspace denied'}})),/Workspace denied/);
const ipcSource=readFileSync(new URL('../src/lib/ipc.ts',import.meta.url),'utf8'),entryStart=ipcSource.indexOf('const networkEntries = new NetworkEntryRequests();'),entryEnd=ipcSource.indexOf('/** What a knock returns:',entryStart);
assert(entryStart>0&&entryEnd>entryStart);const entryExports={},calls=[],logs=[];let supported=false,postReply;
vm.runInNewContext(ts.transpileModule(ipcSource.slice(entryStart,entryEnd)+'\nexports.enter=enterNetworkSeat;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:entryExports,NetworkEntryRequests,NetworkEntryError,Error,uiLog:line=>logs.push(line),ipc:{listEndpoints:async()=>[{id:'mac',base_url:'https://api.boomin.ai/v1/app/producer'}]},guests:{request:async(endpoint,method,path,body)=>{calls.push({endpoint,method,path,body});return method==='GET'?{available:supported,status:supported?200:404,body:supported?{network_entry_protocol:1}:null}:postReply??{available:true,status:201,body:{join_url:'https://producer.dev/connect/guest/'+invite}};}}});
await assert.rejects(entryExports.enter('mac','/v1/app/network/rooms/room/enter'),/coordinated Producer network update/);assert.equal(calls.some(c=>c.method==='POST'),false);
supported=true;const joined=await entryExports.enter('mac','/v1/app/network/rooms/room/enter');assert.equal(calls.at(-1).method,'POST');assert.match(calls.at(-1).body.request_id,/^[0-9a-f-]{36}$/);assert.equal(joined.producer_cam,false);assert.equal(joined.api_base,'https://api.boomin.ai/v1/app/producer');
postReply={available:true,status:409,body:{code:'network_room_closed',message:'Generic conflict'}};
await assert.rejects(entryExports.enter('mac','/v1/app/network/rooms/room/enter'),error=>error.code==='network_room_closed');
assert.equal(logs.length,1);assert.equal(logs[0],'[network-entry] {"event":"rejected","status":409,"code":"network_room_closed"}');
assert(!logs[0].includes(invite));
console.log('Producer links: issuer isolation, no bearer forwarding, duplicate coalescing, lost-response replay, definitive receipt retirement, root/nested error codes and bounded rejection diagnostics passed.');
