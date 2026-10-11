import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceMarkerTrace} from './source-marker-trace.mjs';
test('source trace retains full label and exact context time with a fixed cap',()=>{
 const trace=new SourceMarkerTrace();
 for(let i=0;i<257;i++)trace.push('audio',i%256,i*2+.5);
 const result=trace.snapshot();assert.equal(result.audio.length,256);
 assert.deepEqual(result.audio[23],{id:23,context_time_seconds:46.5});
 assert.deepEqual(result.errors,['source-marker-cap']);assert.equal(result.video.length,0);
});
test('invalid source observations cannot masquerade as generation evidence',()=>{
 const trace=new SourceMarkerTrace();
 for(const row of [['video',256,1],['video',1,NaN],['other',1,2]])assert.throws(()=>trace.push(...row));
});
