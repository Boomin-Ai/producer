import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reconnectReturnGrowth} from './reconnect-evidence.mjs';
const sample=(at,packets,frames,ssrc=123)=>({at_ms:at,state:{returnVideoFrames:frames},audio:packets===null?[]:[{id:'receiver',ssrc,packetsReceived:packets}]});
test('terminal missing stats do not erase recorded packet growth',()=>{
 const result=reconnectReturnGrowth([sample(9000,100,10),sample(12000,200,30),sample(13000,300,60),sample(14000,null,60)],8000);
 assert.equal(result.audio_packets,100);assert.equal(result.video_frames,30);assert.equal(result.observations_without_valid_audio_stats,1);assert.equal(result.error,null);
});
test('missing stats cannot qualify a recovered receiver',()=>{
 assert.ok(reconnectReturnGrowth([sample(12000,null,30),sample(13000,null,60)],8000).error);
});
test('SSRC replacement and same-epoch counter reset cannot masquerade as recovery',()=>{
 for(const observations of [[sample(12000,200,30),sample(13000,300,60,456)],[sample(12000,200,30),sample(13000,100,60)]]) {
  const result=reconnectReturnGrowth(observations,8000);assert.ok(result.error);assert.equal(result.audio_packets,0);
 }
});
