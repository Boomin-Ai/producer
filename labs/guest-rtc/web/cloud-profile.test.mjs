import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixtureConnection} from './cloud-profile.mjs';
test('local fixture ignores Cloud credentials unless explicitly enabled',()=>{
 assert.equal(fixtureConnection({LIVEKIT_URL:'wss://other.livekit.cloud',LIVEKIT_API_SECRET:'dummy'}).url,'ws://127.0.0.1:7880');
});
test('Cloud configuration is restricted to a TLS project and owned room',()=>{
 const env={LIVEKIT_LAB_CLOUD_TEST:'1',LIVEKIT_URL:'wss://test-rtc.livekit.cloud',LIVEKIT_API_KEY:'dummy',LIVEKIT_API_SECRET:'dummy',LIVEKIT_LAB_CLOUD_ROOM:'producer-g1-cloud-123'};
 assert.equal(fixtureConnection(env).roomName,'producer-g1-cloud-123');
 for(const change of [{LIVEKIT_URL:'wss://test.livekit.cloud.evil'},{LIVEKIT_URL:'wss://user@test.livekit.cloud'},{LIVEKIT_LAB_CLOUD_ROOM:'existing-room'},{LIVEKIT_API_SECRET:''}])assert.throws(()=>fixtureConnection({...env,...change}));
});
