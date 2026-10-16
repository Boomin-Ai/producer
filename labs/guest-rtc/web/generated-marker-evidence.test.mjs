import {test} from 'node:test';
import assert from 'node:assert/strict';
import {markerOffsets,videoSequenceHealth} from './generated-marker-evidence.mjs';
test('different numbered markers cannot appear synchronized through nearest timing',()=>{
 const result=markerOffsets({audio:[{id:1,at_ms:500}],video:[{id:2,at_ms:510}]});assert.equal(result.paired_markers,0);
});
test('one video cannot match duplicate audio or remote-cycle stale media',()=>{
 const result=markerOffsets({audio:[{id:1,at_ms:500},{id:1,at_ms:510},{id:1,at_ms:32500}],video:[{id:1,at_ms:520}]});assert.equal(result.paired_markers,1);assert.equal(result.unpaired_audio,2);
});
test('post-reconnect evidence excludes earlier labels and reports signed offsets',()=>{
 const result=markerOffsets({audio:[{id:1,at_ms:500},{id:2,epoch:2,at_ms:2500}],video:[{id:1,at_ms:520},{id:18,epoch:2,at_ms:2540}]},2000);assert.equal(result.paired_markers,1);assert.equal(result.pairs[0].video_minus_audio_ms,40);assert.equal(result.absolute_p95_ms,40);
});

test('old epoch labels cannot count as fresh progress; natural label wrap can',()=>{
 assert.equal(videoSequenceHealth({video:[{id:5},{id:6},{id:4}]}).regressed_labels,1);
 assert.equal(videoSequenceHealth({video:[{id:5},{id:5}]}).repeated_labels,1);
 assert.deepEqual(videoSequenceHealth({video:[{id:255},{id:0},{id:1}]}).regressed_labels,0);
});
