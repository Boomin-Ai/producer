import test from 'node:test';
import assert from 'node:assert/strict';
import {decodedVoiceWav} from './voice-review-wav.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('WAV preserves decoded samples and rejects mismatched or unbounded capture',()=>{
 const pcm=Buffer.alloc(6);pcm.writeInt16LE(-32767,0);pcm.writeInt16LE(0,2);pcm.writeInt16LE(32767,4);
 const wav=decodedVoiceWav([pcm.toString('base64')],3,48000,40);
 assert.equal(wav.readUInt32LE(24),48000);assert.equal(wav.readUInt16LE(22),1);assert.deepEqual(wav.subarray(44),pcm);
 assert.throws(()=>decodedVoiceWav([pcm.toString('base64')],4,48000,40));
 assert.throws(()=>decodedVoiceWav([],1,44100,40));assert.throws(()=>decodedVoiceWav([],48000*66,48000,60));
});
test('decoded worklet records bounded mono PCM while its output stays silent',()=>{
 let Processor;const messages=[];
 const sandbox={AudioWorkletProcessor:class {constructor(){this.port={postMessage:m=>messages.push(m)};}},sampleRate:48000,registerProcessor:(_,value)=>{Processor=value;}};
 vm.runInNewContext(readFileSync(new URL('./voice-review-worklet.js',import.meta.url),'utf8'),sandbox);
 const recorder=new Processor({processorOptions:{limitSamples:3}});
 const out=[new Float32Array(4).fill(1)];
 recorder.process([[new Float32Array([0.5,-0.5,0.25,1])]], [out]);
 assert.ok(out[0].every(n=>n===0));assert.equal(messages.at(-1).samples,3);assert.equal(messages[0].pcm.length,3);
 recorder.port.onmessage({data:'finish'});assert.equal(messages.length,2);
 const invalid=new Processor({processorOptions:{limitSamples:10}});invalid.process([[new Float32Array([NaN])]], [out]);
 assert.equal(messages.at(-1).error,'Nonfinite decoded audio');
});
