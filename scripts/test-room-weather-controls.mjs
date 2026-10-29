import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
const result=await build({stdin:{contents:"export {RoomSetController} from './src/features/presentation/roomSetController';export {SetRuntime} from './shared/set-runtime/runtime';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {RoomSetController,SetRuntime}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const definition=JSON.parse(readFileSync('docs/shows/atmosphere.json','utf8')).runtime;
const runtime=new SetRuntime(definition,{epoch:1,domain:'live',capabilities:['data.weather@1']});
const location={id:'5128581',label:'New York, NY, US',latitude:40.71,longitude:-74.01,timezone:'America/New_York'};
let deployment='weather-a',epoch=1,reply={locations:[location]},pending,requests=[];
const call=async(method,path='',body)=>{requests.push({method,path,body});if(path.startsWith('/locations?'))return pending??reply;if(path==='/configuration')return {deployment,setEpoch:epoch,definition};return {deployment,snapshot:{...runtime.operator(),setEpoch:epoch}};};
const controller=new RoomSetController('endpoint','weather-room',call);
const settle=async(predicate)=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Room controls did not settle');};
try{
 await assert.rejects(controller.searchWeatherLocations('Atlanta'),/not ready/);controller.start();await settle(()=>controller.snapshot().status==='ready');
 const before=controller.snapshot();assert.deepEqual(await controller.searchWeatherLocations('  New York & Queens  '),[location]);assert.equal(requests.at(-1).path,'/locations?query=New%20York%20%26%20Queens');assert.equal(requests.at(-1).method,'GET');assert.equal(controller.snapshot(),before,'read lookup must not change pending, committed or output state');
 const count=requests.length;for(const q of ['', 'a','x'.repeat(101)])await assert.rejects(controller.searchWeatherLocations(q),/2–100/);assert.equal(requests.length,count,'invalid queries must not reach provider');
 for(const locations of [undefined,{},Array(6).fill(location),[{...location,latitude:100}],[{...location,secret:'no'}]]){reply={locations};await assert.rejects(controller.searchWeatherLocations('Paris'));}
 reply={locations:[]};assert.deepEqual(await controller.searchWeatherLocations('Nowhere'),[]);
 let resolve;pending=new Promise(r=>{resolve=r;});const stale=controller.searchWeatherLocations('London');const rejected=assert.rejects(stale,/connection changed/);deployment='weather-b';epoch=2;await controller.refresh();resolve({locations:[location]});await rejected;
 pending=undefined;reply={locations:[location]};assert.deepEqual(await controller.searchWeatherLocations('Atlanta'),[location]);
 pending=new Promise(r=>{resolve=r;});const closing=assert.rejects(controller.searchWeatherLocations('Tokyo'),/connection changed/);controller.close();resolve({locations:[location]});await closing;
 assert(requests.every(r=>r.method==='GET'&&!r.path.includes('data-integrations')),'room city lookup cannot install Sets or access administrative connections');
 console.log('PASS: remote weather lookup is room-scoped, bounded, encoded, read-only, validates results and fences replacement/close');
}finally{controller.close();}
