/** Existing-receiver observations and pure PCM analysis. No devices, capture,
 * real rooms, recording, provider traffic or emitted test sounds. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import ts from 'typescript';
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/producerMediaDiagnostics.ts',import.meta.url),'utf8'),{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
}).outputText,{exports,Map,Promise,performance,setTimeout,clearTimeout});
const {ProducerMediaDiagnostics,receiverCounters,receiverDelta,analyzeKnownTonePattern}=exports;
const plain=value=>JSON.parse(JSON.stringify(value));
const video=(extra={})=>({id:'private-receiver',type:'inbound-rtp',kind:'video',timestamp:1000,bytesReceived:100,framesReceived:20,framesDecoded:18,framesDropped:2,frameWidth:960,frameHeight:540,...extra});
const audio=(extra={})=>({id:'private-audio',type:'inbound-rtp',kind:'audio',timestamp:1000,bytesReceived:100,totalAudioEnergy:0.04,totalSamplesDuration:1,totalSamplesReceived:48000,...extra});
const report=row=>new Map([['private-key',row]]);
function fixture(kind='video'){
 let at=1000,reads=0,row=kind==='video'?video():audio();
 const track={mediaStreamTrack:{readyState:'live',enabled:true,muted:false},async getRTCStatsReport(){reads++;return report(row);}};
 const observer=new ProducerMediaDiagnostics(()=>at),tracks={video:null,audio:null,[kind]:track};
 return {observer,track,tracks,get reads(){return reads;},at(value){at=value;},row(value){row=value;},sample(options={enabled:true}){return observer.sample(options,tracks,()=>true);}};
}
test('disabled sampling neither calls SDK stats nor creates a timeout',async()=>{
 const h=fixture();const result=await h.sample({enabled:false});assert.equal(result.status,'disabled');assert.equal(h.reads,0);assert.equal(result.video.status,'absent');
});
test('track presence and dimensions alone never claim current decoded video',async()=>{
 const h=fixture(),result=await h.sample();assert.equal(h.reads,1);assert.equal(result.video.trackLive,true);assert.equal(result.video.counters.width,960);assert.equal(result.video.decodeProgress,'unknown');assert.equal(result.video.delta,null);assert.equal(result.video.lastDecodeAdvanceAgeMs,null);
});
test('fresh decoder deltas require two observations and preserve signed loss corrections',async()=>{
 const h=fixture();h.row(video({packetsLost:2}));await h.sample();h.at(2000);h.row(video({timestamp:2000,bytesReceived:600,framesDecoded:38,framesReceived:40,packetsLost:1}));
 const result=await h.sample();assert.equal(result.video.decodeProgress,'advancing');assert.equal(result.video.delta.framesDecoded,20);assert.equal(result.video.delta.packetsLost,-1);assert.equal(result.video.delta.windowMs,1000);assert.equal(result.video.lastDecodeAdvanceAgeMs,0);
 h.at(3000);h.row(video({timestamp:3000,bytesReceived:600,framesDecoded:38,framesReceived:40,packetsLost:1}));const still=await h.sample();assert.equal(still.video.decodeProgress,'unchanged');assert.equal(still.video.lastDecodeAdvanceAgeMs,1000);
});
test('cached stats cannot claim fresh decoding or shorten the next valid window',async()=>{
 const h=fixture();await h.sample();h.at(1500);const cached=await h.sample();assert.equal(cached.video.delta,null);assert.equal(cached.video.decodeProgress,'unknown');
 h.at(2000);h.row(video({timestamp:2000,bytesReceived:150,framesDecoded:20}));const advanced=await h.sample();assert.equal(advanced.video.delta.windowMs,1000);assert.equal(advanced.video.delta.framesDecoded,2);
});
test('counter and stats-clock resets suppress rates and reset freshness history',async()=>{
 const h=fixture();await h.sample();h.at(2000);h.row(video({timestamp:2000,bytesReceived:200,framesDecoded:25}));await h.sample();h.at(3000);h.row(video({timestamp:3000,bytesReceived:1,framesDecoded:0,framesReceived:0,framesDropped:0}));
 const reset=await h.sample();assert.equal(reset.video.decodeProgress,'reset');assert.equal(reset.video.delta,null);assert.equal(reset.video.lastDecodeAdvanceAgeMs,null);
 h.at(4000);h.row(video({timestamp:2500,bytesReceived:2,framesDecoded:1,framesReceived:1,framesDropped:0}));assert.equal((await h.sample()).video.decodeProgress,'reset');
});
test('a new receiver report identity or track starts its own baseline',async()=>{
 const h=fixture();await h.sample();h.at(2000);h.row(video({id:'new-private-receiver',timestamp:2000,bytesReceived:900,framesDecoded:90}));assert.equal((await h.sample()).video.delta,null);
 h.at(3000);h.tracks.video={...h.track,async getRTCStatsReport(){return report(video({timestamp:3000,bytesReceived:990,framesDecoded:99}));}};assert.equal((await h.sample()).video.delta,null);
});
test('a caller cannot alter future deltas by modifying its returned counters',async()=>{
 const h=fixture(),first=await h.sample();first.video.counters.framesDecoded=0;h.at(2000);h.row(video({timestamp:2000,framesDecoded:28}));assert.equal((await h.sample()).video.delta.framesDecoded,10);
});
test('audio exposes supported PCM progress, energy, concealment and derived RMS without claiming audibility',async()=>{
 const h=fixture('audio');await h.sample();h.at(2000);h.row(audio({timestamp:2000,bytesReceived:300,totalAudioEnergy:0.08,totalSamplesDuration:2,totalSamplesReceived:96000,concealedSamples:20,concealmentEvents:2}));
 const result=await h.sample();assert.equal(result.audio.decodeProgress,'advancing');assert.equal(result.audio.delta.totalSamplesReceived,48000);assert.ok(Math.abs(result.audio.delta.audioRms-0.2)<1e-10);assert.equal(result.audio.counters.concealedSamples,20);assert.equal(result.audio.delta.concealedSamples,null);assert.equal(result.audio.counters.framesDecoded,null);assert.ok(!('audible' in result.audio));
});
test('missing browser metrics stay null; received packets cannot stand in for decoded frames',async()=>{
 const h=fixture();h.row({type:'inbound-rtp',kind:'video',timestamp:1000,bytesReceived:100});await h.sample();h.at(2000);h.row({type:'inbound-rtp',kind:'video',timestamp:2000,bytesReceived:200});
 const result=await h.sample();assert.equal(result.video.delta.bytesReceived,100);assert.equal(result.video.delta.framesDecoded,null);assert.equal(result.video.decodeProgress,'unknown');
 const counters=receiverCounters('audio',{totalAudioEnergy:Infinity,totalSamplesDuration:NaN,packetsLost:-2,bytesReceived:-1});assert.equal(counters.totalAudioEnergy,null);assert.equal(counters.bytesReceived,null);assert.equal(counters.packetsLost,-2);
});
test('SDK report strings, identifiers and unrelated outbound rows never escape',async()=>{
 const h=fixture();h.track.getRTCStatsReport=async()=>new Map([['a',{type:'outbound-rtp',kind:'video',bytesSent:999}],['b',video({id:'SECRET-ID',trackIdentifier:'SECRET-TRACK',address:'SECRET-IP',codecId:'SECRET-CODEC',label:'SECRET-LABEL',token:'SECRET-TOKEN'})]]);
 const result=plain(await h.sample());assert.equal(result.video.status,'available');assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(Object.values(result.video.counters).every(v=>v===null||typeof v==='number'));
});
test('ambiguous, absent and oversized reports are unsupported rather than guessed',async()=>{
 const h=fixture();h.track.getRTCStatsReport=async()=>new Map([['a',video()],['b',video({id:'other'})]]);assert.equal((await h.sample()).video.status,'unsupported');
 h.track.getRTCStatsReport=async()=>undefined;assert.equal((await h.sample()).video.status,'unsupported');
 h.track.getRTCStatsReport=async()=>new Map(Array.from({length:129},(_,i)=>[String(i),{type:'codec'}]));assert.equal((await h.sample()).video.status,'unsupported');
});
test('concurrent observations coalesce and retired samples discard late SDK results',async()=>{
 const h=fixture();let release;h.track.getRTCStatsReport=()=>new Promise(resolve=>{release=resolve;});
 const one=h.sample(),two=h.sample();assert.equal(one,two);await Promise.resolve();h.observer.reset();assert.equal((await one).status,'retired');release(report(video()));await Promise.resolve();
});
test('authority loss after SDK read drops the entire result without updating a future baseline',async()=>{
 const h=fixture();let valid=true,release;h.track.getRTCStatsReport=()=>new Promise(resolve=>{release=resolve;});const pending=h.observer.sample({enabled:true},h.tracks,()=>valid);await Promise.resolve();valid=false;release(report(video()));assert.equal((await pending).status,'retired');
 assert.equal((await h.observer.sample({enabled:true},h.tracks,()=>false)).status,'unavailable');
});
test('timeouts are bounded, preserve successful sibling stats, and never pile up browser reads',async()=>{
 const h=fixture();let calls=0;const hanging={mediaStreamTrack:h.track.mediaStreamTrack,getRTCStatsReport(){calls++;return new Promise(()=>{});}};
 const tracks={video:hanging,audio:{...h.track,async getRTCStatsReport(){return report(audio());}}};
 const result=await h.observer.sample({enabled:true,timeoutMs:50},tracks,()=>true);assert.equal(result.video.status,'timed_out');assert.equal(result.audio.status,'available');
 await h.observer.sample({enabled:true,timeoutMs:50},tracks,()=>true);assert.equal(calls,1);
 const second={...hanging,getRTCStatsReport(){calls++;return new Promise(()=>{});}};await h.observer.sample({enabled:true,timeoutMs:50},{video:second,audio:null},()=>true);
 const third={...hanging,getRTCStatsReport(){calls++;return new Promise(()=>{});}};const blocked=await h.observer.sample({enabled:true,timeoutMs:50},{video:third,audio:null},()=>true);assert.equal(blocked.video.status,'busy');assert.equal(calls,2);h.observer.reset();
});
test('a rejected SDK stats promise yields a fixed status and no provider error text',async()=>{
 const h=fixture();h.track.getRTCStatsReport=()=>Promise.reject(Error('SECRET-PROVIDER-TOKEN'));const result=await h.sample();assert.equal(result.video.status,'failed');assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('disabled consent invalidates in-flight work and clears the comparison baseline',async()=>{
 const h=fixture();await h.sample();await h.sample({enabled:false});h.at(2000);h.row(video({timestamp:2000,bytesReceived:200,framesDecoded:50}));assert.equal((await h.sample()).video.delta,null);
 let release;h.track.getRTCStatsReport=()=>new Promise(resolve=>{release=resolve;});const pending=h.sample();await Promise.resolve();await h.sample({enabled:false});assert.equal((await pending).status,'retired');release(report(video()));
});
test('pure deltas reject zero windows, clock reversal and counter regressions',()=>{
 const before=receiverCounters('video',video()),after=receiverCounters('video',video({timestamp:2000,framesDecoded:40}));assert.equal(receiverDelta(after,before,0),null);assert.equal(receiverDelta(before,after,1000),null);
});

const timingKeys=['jitterBufferDelay','jitterBufferEmittedCount','jitterBufferTargetDelay','jitterBufferMinimumDelay','totalDecodeTime','totalProcessingDelay'];
const averageKeys=['jitterBufferAverageMs','jitterBufferTargetAverageMs','jitterBufferMinimumAverageMs','decodeAverageMs','processingAverageMs'];
const timingBase={jitterBufferDelay:2,jitterBufferEmittedCount:100,jitterBufferTargetDelay:3,jitterBufferMinimumDelay:1,totalDecodeTime:1,totalProcessingDelay:4};
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
test('receiver timing keeps only finite nonnegative standard counters; audio decode/processing remain unsupported',()=>{
 const counters=receiverCounters('video',video(timingBase));for(const key of timingKeys)assert.equal(counters[key],timingBase[key]);
 const unsupported=receiverCounters('audio',audio(timingBase));assert.equal(unsupported.totalDecodeTime,null);assert.equal(unsupported.totalProcessingDelay,null);
 for(const value of [undefined,null,'SECRET-TIMING',Infinity,NaN,-1]){
  const invalid=receiverCounters('video',Object.fromEntries(timingKeys.map(key=>[key,value])));
  for(const key of timingKeys)assert.equal(invalid[key],null);
 }
 for(const key of timingKeys)assert.equal(receiverCounters('video',{[key]:0})[key],0);
});
test('video timing uses matching interval deltas and the correct emitted/decoded denominators',async()=>{
 const h=fixture();h.row(video({...timingBase,framesDecoded:10}));assert.equal((await h.sample()).video.delta,null);
 h.at(2000);h.row(video({timestamp:2000,framesDecoded:20,...timingBase,jitterBufferDelay:2.4,jitterBufferEmittedCount:120,
  jitterBufferTargetDelay:3.6,jitterBufferMinimumDelay:1.2,totalDecodeTime:1.05,totalProcessingDelay:4.6}));
 const result=await h.sample(),d=result.video.delta;
 for(const [key,value]of Object.entries({jitterBufferAverageMs:20,jitterBufferTargetAverageMs:30,jitterBufferMinimumAverageMs:10,decodeAverageMs:5,processingAverageMs:60}))close(d[key],value);
 assert.equal(d.jitterBufferEmittedCount,20);close(d.totalDecodeTime,0.05);close(d.totalProcessingDelay,0.6);
 assert.equal(result.video.decodeProgress,'advancing');assert.equal(h.reads,2);
});
test('audio jitter averages use emitted audio samples, never received samples or elapsed duration',async()=>{
 const h=fixture('audio');h.row(audio({jitterBufferDelay:2400,jitterBufferTargetDelay:2880,jitterBufferMinimumDelay:960,jitterBufferEmittedCount:48000,totalDecodeTime:1,totalProcessingDelay:1}));await h.sample();
 h.at(2000);h.row(audio({timestamp:2000,totalSamplesDuration:2,totalSamplesReceived:72000,jitterBufferDelay:4800,jitterBufferTargetDelay:5760,
  jitterBufferMinimumDelay:1920,jitterBufferEmittedCount:96000,totalDecodeTime:2,totalProcessingDelay:2}));
 const d=(await h.sample()).audio.delta;assert.equal(d.jitterBufferAverageMs,50);assert.equal(d.jitterBufferTargetAverageMs,60);assert.equal(d.jitterBufferMinimumAverageMs,20);
 assert.equal(d.totalDecodeTime,null);assert.equal(d.totalProcessingDelay,null);assert.equal(d.decodeAverageMs,null);assert.equal(d.processingAverageMs,null);
});
test('zero or missing denominator never invents timing; observed zero delay stays zero with valid progress',()=>{
 const before=receiverCounters('video',video(timingBase));
 const noProgress=receiverDelta(receiverCounters('video',video({timestamp:2000,...timingBase,jitterBufferDelay:3,totalDecodeTime:2})),before,1000);
 for(const key of averageKeys)assert.equal(noProgress[key],null);
 const zero=receiverDelta(receiverCounters('video',video({timestamp:2000,framesDecoded:28,...timingBase,jitterBufferEmittedCount:120})),before,1000);
 for(const key of averageKeys)assert.equal(zero[key],0);
 for(const key of ['jitterBufferEmittedCount','framesDecoded']){
  const missing=receiverDelta(receiverCounters('video',video({timestamp:2000,...timingBase,[key]:undefined})),before,1000);
  for(const name of key==='framesDecoded'?['decodeAverageMs','processingAverageMs']:averageKeys.slice(0,3))assert.equal(missing[name],null);
 }
 const newlySupported=receiverDelta(receiverCounters('video',video({timestamp:2000,...timingBase,jitterBufferEmittedCount:120,framesDecoded:28})),receiverCounters('video',video()),1000);
 for(const key of averageKeys)assert.equal(newlySupported[key],null);
});
for(const key of timingKeys)test(`a reset in ${key} invalidates the whole timing interval and decoder freshness`,async()=>{
 const h=fixture();h.row(video(timingBase));await h.sample();h.at(2000);
 h.row(video({timestamp:2000,framesDecoded:28,...timingBase,[key]:timingBase[key]-1}));
 const reset=await h.sample();assert.equal(reset.video.delta,null);assert.equal(reset.video.decodeProgress,'reset');assert.equal(reset.video.lastDecodeAdvanceAgeMs,null);
});
test('stale reports or a changed private binding cannot supply receiver timing averages',async()=>{
 const h=fixture();h.row(video(timingBase));await h.sample();h.at(1500);assert.equal((await h.sample()).video.delta,null);
 h.at(2000);h.row(video({timestamp:2000,id:'SECRET-NEW-RECEIVER',framesDecoded:28,...timingBase,jitterBufferEmittedCount:120,totalProcessingDelay:5}));
 const changed=await h.sample();assert.equal(changed.video.delta,null);assert.equal(changed.video.decodeProgress,'unknown');assert.doesNotMatch(JSON.stringify(changed),/SECRET/);
});
test('extreme finite counters cannot overflow an interval timing result',()=>{
 const before=receiverCounters('video',video({...timingBase,jitterBufferDelay:0,totalDecodeTime:0}));
 const after=receiverCounters('video',video({timestamp:2000,framesDecoded:19,...timingBase,jitterBufferEmittedCount:101,jitterBufferDelay:Number.MAX_VALUE,totalDecodeTime:Number.MAX_VALUE}));
 const d=receiverDelta(after,before,1000);assert.equal(d.jitterBufferAverageMs,null);assert.equal(d.decodeAverageMs,null);
});

const rate=48000,pattern=[{kind:'tone',durationMs:160,frequencyHz:440},{kind:'silence',durationMs:80},{kind:'tone',durationMs:160,frequencyHz:880}];
function synth(segments,{channels=1,amplitude=0.05,wrong=false,antiphase=false}={}){
 const out=new Float32Array(Math.round(segments.reduce((n,s)=>n+s.durationMs,0)*rate/1000)*channels);let offset=0;
 for(const s of segments){const frames=Math.round(s.durationMs*rate/1000);for(let i=0;i<frames;i++)for(let c=0;c<channels;c++)out[(offset+i)*channels+c]=s.kind==='tone'?amplitude*Math.sin(i*2*Math.PI*(wrong?1300:s.frequencyHz)/rate)*(antiphase&&c===1?-1:1):0;offset+=frames;}return out;
}
test('known two-frequency burst pattern matches unmuted PCM, fails muted PCM, and recovers',()=>{
 const tone=synth(pattern),silent=new Float32Array(tone.length);assert.equal(analyzeKnownTonePattern(tone,rate,pattern).matched,true);assert.equal(analyzeKnownTonePattern(silent,rate,pattern).matched,false);assert.equal(analyzeKnownTonePattern(tone,rate,pattern).matched,true);
 const silence=[{kind:'silence',durationMs:400}];assert.equal(analyzeKnownTonePattern(silent,rate,silence).matched,true);assert.equal(analyzeKnownTonePattern(tone,rate,silence).matched,false);
});
test('signal energy alone is insufficient: a loud wrong frequency or contaminated silent gap fails',()=>{
 assert.equal(analyzeKnownTonePattern(synth(pattern,{wrong:true}),rate,pattern).matched,false);const contaminated=synth(pattern);for(let i=7680;i<11520;i++)contaminated[i]=0.04*Math.sin(i*2*Math.PI*440/rate);assert.equal(analyzeKnownTonePattern(contaminated,rate,pattern).matched,false);
});
test('stereo channels are analyzed without cancelling opposite-phase tone',()=>{
 const result=analyzeKnownTonePattern(synth(pattern,{channels:2,antiphase:true}),rate,pattern,{channels:2});assert.equal(result.matched,true);assert.ok(result.segments[0].toneFraction>0.95);
});
test('PCM analysis rejects oversized, nonfinite, invalid-frequency and incomplete input',()=>{
 assert.throws(()=>analyzeKnownTonePattern(new Float32Array(1),rate,pattern),/unavailable/);
 assert.throws(()=>analyzeKnownTonePattern(synth(pattern),rate,[{kind:'tone',durationMs:160,frequencyHz:rate}]),/Invalid/);
 const invalid=synth(pattern);invalid[0]=NaN;assert.throws(()=>analyzeKnownTonePattern(invalid,rate,pattern),/normalized/);
 assert.throws(()=>analyzeKnownTonePattern({length:rate*11},rate,pattern),/bounded/);
});
