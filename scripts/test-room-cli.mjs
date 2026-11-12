import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,statSync} from 'node:fs';
const bundle=await build({entryPoints:['src/features/room-control/runtime.ts'],bundle:true,platform:'node',format:'esm',write:false,define:{'import.meta.env.DEV':'true','import.meta.env.VITE_ROOM_CLI':'"1"'}});
const {registerRoomControl,executeRoomControl,controlState,redactRoomState}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let snapshots=0,mutations=0;
const close=registerRoomControl('room',{epoch:'one',roomId:'test',snapshot:()=>{snapshots++;return {scenes:[],token:'private',sources:[{spec:{url:'https://media.invalid/?token=private'}}]};},commands:{'panel.move':()=>{mutations++;return {ok:true};}}});
assert.equal(snapshots,0,'registration does not serialize or subscribe to frame updates');
const state=controlState().room;assert.equal(state.state.token,'[private]');assert.equal(state.state.sources[0].spec.url,'[private location]');
for(const request of [{surface:'room',command:'panel.move',epoch:'old',roomId:'test'},{surface:'room',command:'panel.move',epoch:'one',roomId:'other'},{surface:'room',command:'constructor',epoch:'one',roomId:'test'},{surface:'room',command:'native.invoke',epoch:'one',roomId:'test'}])await assert.rejects(executeRoomControl(request));
assert.equal(mutations,0,'stale and arbitrary operations cannot mutate the room');
await executeRoomControl({surface:'room',command:'panel.move',epoch:'one',roomId:'test'});assert.equal(mutations,1);
assert.deepEqual(redactRoomState({stream_key:'x',capture:{device:'camera',url:'https://example.invalid/private'},set:{assets:{cover:{name:'cover',mime:'image/png',data:'plain-private-base64'}}},recPath:'/private/movie.mp4'}),{stream_key:'[private]',capture:{device:'camera',url:'[private location]'},set:{assets:{cover:{name:'cover',mime:'image/png',data:'[embedded asset]'}}},recPath:'[private]'});
close();await assert.rejects(executeRoomControl({surface:'room',command:'state'}));
if(process.env.PRODUCER_TEST_CLI_HTTP==='1'){
 const session=JSON.parse(readFileSync('.room-control/session.json','utf8'));assert.equal(statSync('.room-control/session.json').mode&0o777,0o600);
 const send=async(headers,host=session.url)=>fetch(host+'/__producer_room_cli',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({surface:'*',command:'state'})});
 assert.equal((await send({})).status,401);
 assert.equal((await send({authorization:`Bearer ${session.token}`,origin:'https://example.invalid'})).status,403);
 assert.equal((await send({authorization:`Bearer ${session.token}`},session.url.replace('127.0.0.1','localhost'))).status,403);
 assert.equal((await send({authorization:`Bearer ${session.token}`})).status,200);
}
console.log('PASS room CLI: on-demand state; credential/location/media redaction; room and epoch fences; named operations only; disposal; optional real HTTP authentication/origin/Host checks.');
