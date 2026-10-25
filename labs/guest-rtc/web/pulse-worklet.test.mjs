import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
for(const sourcePhase of [0,1.5])test(`source phase ${sourcePhase} preserves samples and reports once per pulse`,()=>{
 const messages=[];let Pulse;
 const env={AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)};}},
  currentTime:46.499,sampleRate:48000,registerProcessor:(_,ctor)=>{Pulse=ctor;}};
 vm.runInNewContext(readFileSync(new URL('./pulse-worklet.js',import.meta.url),'utf8'),env);
 const pulse=new Pulse({processorOptions:{numbered:true,sourcePhase}});
 for(const time of [46.499,46.502,46.505]){
  env.currentTime=time-sourcePhase;const channel=new Float32Array(128);
  assert.equal(pulse.process([],[[channel]]),true);
  for(let n=0;n<128;n++){
   const t=time+n/48000,phase=t%2;
   const expected=Math.fround(phase>=.5&&phase<.62?.4*Math.sin(2*Math.PI*(997+128*(Math.floor(t/2)%16))*t):0);
   assert.equal(channel[n],expected);
  }
 }
 assert.equal(messages.length,1);assert.equal(messages[0].id,23);
 assert.equal(messages[0].context_time_seconds,46.5-sourcePhase);
});
