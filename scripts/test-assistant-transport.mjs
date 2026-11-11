import assert from 'node:assert/strict';
import {build} from 'esbuild';
const built=await build({stdin:{contents:"export {chatgpt} from './src/features/assistant/provider';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,plugins:[{
 name:'native-transport-fixture',setup(build){
  build.onResolve({filter:/\/nativeInvoke$/},()=>({path:'native-fixture',namespace:'fixture'}));
  build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export class Channel {} export const invoke=(command,args)=>globalThis.__assistantBridgeFixture(command,args);',loader:'js'}));
 }
}]});
const {chatgpt}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const turn={accountId:'test',turnId:'test-turn',model:'test-model',instructions:'',input:[],tools:[]};
const output=[{type:'function_call',namespace:'producer',name:'inspect_set',call_id:'test-call',arguments:'{}',padding:'x'.repeat(40000)}];
// Reproduce the old host: command acknowledgment precedes a large channel result.
let delivered=false;
globalThis.__assistantBridgeFixture=async(_command,{onEvent})=>{setTimeout(()=>{delivered=true;onEvent.onmessage({type:'completed',output});},25);return null;};
assert.deepEqual(await chatgpt.turn(turn,()=>{}),output);
assert(delivered,'must wait for the terminal payload, rather than returning at the command acknowledgment');
// Current hosts return their authoritative output directly; no terminal channel
// message is required, so progress-channel delivery cannot lose an edit.
globalThis.__assistantBridgeFixture=async()=>output;
assert.deepEqual(await chatgpt.turn(turn,()=>{}),output);
globalThis.__assistantBridgeFixture=async(_command,{onEvent})=>{onEvent.onmessage({type:'completed',output});throw Error('native command rejected');};
await assert.rejects(chatgpt.turn(turn,()=>{}),/native command rejected/);
globalThis.__assistantBridgeFixture=async()=>null;
await assert.rejects(chatgpt.turn(turn,()=>{}),/native completion was not delivered/);
let attempts=0;const events=[];
globalThis.__assistantBridgeFixture=async(command)=>{if(command==='assistant_cancel_turn')return;if(++attempts===1)throw 'Could not reach ChatGPT. Check your connection.';return output;};
assert.deepEqual(await chatgpt.turn(turn,event=>events.push(event)),output);assert.equal(attempts,2);assert.equal(events[0].type,'transport');
attempts=0;
globalThis.__assistantBridgeFixture=async()=>{attempts++;throw 'ChatGPT request failed before a response (connect_failed; 3 attempts). Your draft is saved.';};
await assert.rejects(chatgpt.turn(turn,()=>{}),/connect_failed/);assert.equal(attempts,1,'new hosts already own recovery; never multiply their attempts');
attempts=0;
globalThis.__assistantBridgeFixture=async command=>{if(command==='assistant_cancel_turn')return;attempts++;throw 'Could not reach ChatGPT. Check your connection.';};
await assert.rejects(chatgpt.turn(turn,event=>{if(event.type==='transport')void chatgpt.cancel(turn.turnId)}),/Assistant stopped/);assert.equal(attempts,1,'cancel during backoff cannot start another native turn');
delete globalThis.__assistantBridgeFixture;
console.log('PASS Assistant transport: delayed legacy completion, current authoritative output, bounded recovery without multiplying native retries, cancellation during backoff and bounded missing-result failure.');
