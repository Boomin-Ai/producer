/** Offline synthetic PCM and temporary files only. No playback, capture,
 * room, recording, shell, ffmpeg or provider traffic. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createToneFixture,FIXTURE,LIMITS,generateToneFile,probeWaveBytes,probeToneFile,main} from './network-tone-proof.mjs';

function encode(pcm,{channels=2,sampleRate=48000}={}){
 const wav=Buffer.alloc(44+pcm.length*2);
 wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);
 wav.writeUInt16LE(channels,22);wav.writeUInt32LE(sampleRate,24);wav.writeUInt32LE(sampleRate*channels*2,28);wav.writeUInt16LE(channels*2,32);wav.writeUInt16LE(16,34);
 wav.write('data',36);wav.writeUInt32LE(pcm.length*2,40);
 for(let i=0;i<pcm.length;i++)wav.writeInt16LE(Math.round(Math.max(-1,Math.min(0.999969,pcm[i]))*32768),44+i*2);
 return wav;
}
function synth({channels=2,sampleRate=48000,wrong=false,reverse=false,antiPhase=false,oneSide=false,amplitude=0.04,noise=0,rampMs=10,offsetFrames=0,tailFrames=0}={}){
 const length=Math.round(FIXTURE.durationMs*sampleRate/1000),pcm=new Float32Array((length+offsetFrames+tailFrames)*channels);
 let offset=offsetFrames,seed=5;
 for(const segment of FIXTURE.pattern){
  const count=Math.round(segment.durationMs*sampleRate/1000),ramp=rampMs*sampleRate/1000;
  for(let frame=0;frame<count;frame++){
   seed=(Math.imul(seed,1664525)+1013904223)|0;const random=(seed>>>0)/4294967296*2-1;
   const edge=Math.min(1,frame/ramp,(count-frame-1)/ramp),gain=0.5-0.5*Math.cos(Math.PI*edge);
   const frequency=wrong?1300:reverse?({440:1531,997:997,1531:440}[segment.frequencyHz]??0):segment.frequencyHz;
   const sample=(segment.kind==='tone'?amplitude*gain*Math.sin(frame*2*Math.PI*frequency/sampleRate):0)+noise*random;
   for(let c=0;c<channels;c++)pcm[(offset+frame)*channels+c]=oneSide&&c===1?0:sample*(antiPhase&&c===1?-1:1);
  }
  offset+=count;
 }
 return {wav:encode(pcm,{channels,sampleRate}),pcm};
}
function chunks(wav,extra,{duplicateFmt=false,duplicateData=false}={}){
 const fmt=wav.subarray(12,36),data=wav.subarray(36),body=Buffer.concat([extra,fmt,...(duplicateFmt?[fmt]:[]),data,...(duplicateData?[data]:[])]);
 const header=Buffer.alloc(12);header.write('RIFF',0);header.writeUInt32LE(body.length+4,4);header.write('WAVE',8);return Buffer.concat([header,body]);
}
const junk=()=>{const b=Buffer.alloc(10);b.write('JUNK',0);b.writeUInt32LE(1,4);b[8]=42;return b;};

test('fixture is deterministic stereo48k PCM16 with three precise tones, silence and short zero-edge ramps',()=>{
 const a=createToneFixture();assert.deepEqual(a,createToneFixture());assert.equal(a.toString('ascii',0,4),'RIFF');assert.equal(a.toString('ascii',8,16),'WAVEfmt ');
 assert.equal(a.readUInt16LE(20),1);assert.equal(a.readUInt16LE(22),2);assert.equal(a.readUInt32LE(24),48000);assert.equal(a.readUInt16LE(34),16);
 assert.equal(a.length,44+48000*2*2*1.3);let peak=0;
 for(let i=44;i<a.length;i+=4){assert.equal(a.readInt16LE(i),a.readInt16LE(i+2));peak=Math.max(peak,Math.abs(a.readInt16LE(i))/32768);}
 assert.ok(peak<=0.04002&&peak>0.039);let frame=0;
 for(const segment of FIXTURE.pattern){
  const count=segment.durationMs*48;
  if(segment.kind==='silence')assert.ok(a.subarray(44+frame*4,44+(frame+count)*4).every(v=>v===0));
  else{assert.equal(a.readInt16LE(44+frame*4),0);assert.equal(a.readInt16LE(44+(frame+count-1)*4),0);}
  frame+=count;
 }
});

test('generated fixture passes the actual canonical analyzer, without audibility/mute/latency claims',async()=>{
 const result=await probeWaveBytes(createToneFixture());assert.equal(result.status,'matched');assert.equal(result.offsetMs,0);assert.equal(result.segments.length,7);
 assert.ok(result.segments.every(segment=>segment.matched));assert.ok(result.segments.filter(s=>s.kind==='tone').every(s=>s.toneFraction>0.9));
 assert.deepEqual(result.coverage,{verification:'supplied_recording_pcm_pattern_only',speakerAudibility:'not_tested',muteBehavior:'not_tested',networkLatency:'not_tested'});
 assert.equal(result.offsetMeaning,'recording_relative_pattern_window_not_latency');assert.ok(!('audio' in result)&&!('pcm' in result)&&!('heard' in result));
});

for(const offsetFrames of [1,12345,48001,48000*12+137])test('unknown non-grid recording offset is found: '+offsetFrames+'frames',async()=>{
 const {wav}=synth({offsetFrames,tailFrames:800});const result=await probeWaveBytes(wav);
 assert.equal(result.status,'matched');assert.ok(Math.abs(result.offsetMs-offsetFrames/48)<=2,JSON.stringify(result));assert.ok(result.refinementStepMs<=1.001);
});

test('an exact full pattern ending at EOF is searched, including the last non-grid offset',async()=>{
 const offsetFrames=12345,result=await probeWaveBytes(synth({offsetFrames}).wav);assert.equal(result.status,'matched');assert.ok(Math.abs(result.offsetMs-offsetFrames/48)<=2);
});

test('mono, opposite-phase stereo and a single active stereo channel never cancel the evidence',async()=>{
 for(const options of [{channels:1},{antiPhase:true},{oneSide:true}]){
  const result=await probeWaveBytes(synth(options).wav);assert.equal(result.status,'matched',JSON.stringify(options));assert.equal(result.channels,options.channels??2);
 }
});

test('supported recording rates use the same frequencies and milliseconds after authorized conversion',async()=>{
 for(const sampleRate of [8000,16000,44100,96000]){
  const result=await probeWaveBytes(synth({sampleRate,offsetFrames:Math.round(sampleRate*0.387),tailFrames:256}).wav);
  assert.equal(result.status,'matched',String(sampleRate));assert.ok(Math.abs(result.offsetMs-387)<2);assert.equal(result.sampleRate,sampleRate);
 }
});

test('modest attenuation, background noise and longer recording fades retain a complete pattern',async()=>{
 const result=await probeWaveBytes(synth({amplitude:0.02,noise:0.0002,rampMs:30,offsetFrames:3210,tailFrames:600}).wav);
 assert.equal(result.status,'matched');assert.ok(result.segments.filter(s=>s.kind==='tone').every(s=>s.toneFraction>=0.7));
});

test('silence, noise, wrong-frequency tones and reversed frequency order are no_match',async()=>{
 let seed=44;const noise=new Float32Array(48000*2*2);for(let i=0;i<noise.length;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;noise[i]=((seed>>>0)/4294967296*2-1)*0.04;}
 for(const wav of [encode(new Float32Array(48000*2*2)),encode(noise),synth({wrong:true}).wav,synth({reverse:true}).wav]){
  const result=await probeWaveBytes(wav);assert.equal(result.status,'no_match');assert.equal(result.offsetMs,null);
 }
});

test('energy in required silence gaps fails even when the correct tone frequencies exist',async()=>{
 const {pcm}=synth();let frame=0;
 for(const segment of FIXTURE.pattern){const count=segment.durationMs*48;if(segment.kind==='silence')for(let i=0;i<count;i++)for(let c=0;c<2;c++)pcm[(frame+i)*2+c]=0.03*Math.sin(i*2*Math.PI*440/48000);frame+=count;}
 assert.equal((await probeWaveBytes(encode(pcm))).status,'no_match');
});

test('truncated containers/chunks/frames and genuinely short audio are insufficient',async()=>{
 const wav=createToneFixture(),chunkTruncated=Buffer.from(wav.subarray(0,wav.length-100));chunkTruncated.writeUInt32LE(chunkTruncated.length-8,4);
 const incomplete=Buffer.from(wav.subarray(0,wav.length-2));incomplete.writeUInt32LE(incomplete.length-8,4);incomplete.writeUInt32LE(incomplete.length-44,40);
 for(const input of [Buffer.alloc(0),Buffer.from('RIFF'),wav.subarray(0,wav.length-1),chunkTruncated,incomplete,encode(new Float32Array(200)),encode(new Float32Array(0))]){
  assert.equal((await probeWaveBytes(input)).status,'insufficient');
 }
});

test('float/compressed/extensible formats, sample depths, channels and rates return unsupported',async()=>{
 for(const [offset,value] of [[20,3],[20,6],[20,65534],[22,0],[22,3],[34,8],[34,24],[34,32]]){
  const wav=createToneFixture();wav.writeUInt16LE(value,offset);assert.equal((await probeWaveBytes(wav)).status,'unsupported');
 }
 for(const rate of [0,7999,96001]){const wav=createToneFixture();wav.writeUInt32LE(rate,24);assert.equal((await probeWaveBytes(wav)).status,'unsupported');}
 for(const offset of [28,32]){const wav=createToneFixture();if(offset===28)wav.writeUInt32LE(1,offset);else wav.writeUInt16LE(1,offset);assert.equal((await probeWaveBytes(wav)).status,'unsupported');}
 for(const tag of ['RIFX','RF64','NOPE']){const wav=createToneFixture();wav.write(tag,0);assert.equal((await probeWaveBytes(wav)).status,'unsupported');}
});

test('high-bit-garbled container and chunk signatures cannot alias valid WAV FourCCs',async()=>{
 for(const offset of [0,8,12,36]){
  const wav=createToneFixture();wav[offset]|=0x80;
  const result=await probeWaveBytes(wav);assert.equal(result.status,'unsupported',String(offset));
  assert.equal(result.code,offset<12?'unsupported_wav_container':'missing_pcm_chunks');
 }
});

test('padded unknown chunks work, while ambiguous chunks and invalid RIFF bounds fail closed',async()=>{
 assert.equal((await probeWaveBytes(chunks(createToneFixture(),junk()))).status,'matched');
 for(const options of [{duplicateFmt:true},{duplicateData:true}])assert.equal((await probeWaveBytes(chunks(createToneFixture(),Buffer.alloc(0),options))).status,'unsupported');
 assert.equal((await probeWaveBytes(Buffer.concat([createToneFixture(),Buffer.from('private-trailing-bytes')]))).status,'unsupported');
 const hugeChunk=createToneFixture();hugeChunk.writeUInt32LE(0xffffffff,40);assert.equal((await probeWaveBytes(hugeChunk)).status,'insufficient');
 const many=chunks(createToneFixture(),Buffer.concat(Array.from({length:LIMITS.chunks},junk)));assert.equal((await probeWaveBytes(many)).code,'chunk_budget_exceeded');
});

test('file, duration and input-type budgets refuse before expensive analysis',async()=>{
 assert.equal((await probeWaveBytes(Buffer.alloc(LIMITS.fileBytes+1))).code,'file_budget_exceeded');
 assert.equal((await probeWaveBytes(encode(new Float32Array(8000*(LIMITS.durationSeconds+1)),{channels:1,sampleRate:8000}))).code,'duration_budget_exceeded');
 assert.equal((await probeWaveBytes(new Uint8Array(44))).code,'byte_buffer_required');
});

test('the longest quiet supported recording is searched, while adversarial repeated candidates hit an explicit CPU budget',async()=>{
 const quiet=encode(new Float32Array(48000*2*LIMITS.durationSeconds));
 const silence=await probeWaveBytes(quiet);assert.equal(silence.status,'no_match');assert.equal(silence.analyzerCalls,0);assert.equal(silence.durationMs,60000);
 const {pcm}=synth();let frame=0;
 for(const segment of FIXTURE.pattern){const count=segment.durationMs*48;if(segment.kind==='tone')for(let i=0;i<count;i++)for(let c=0;c<2;c++)pcm[(frame+i)*2+c]=0.04*Math.sin(i*2*Math.PI*440/48000);frame+=count;}
 const repeats=new Float32Array(pcm.length*45);for(let n=0;n<45;n++)repeats.set(pcm,n*pcm.length);
 const result=await probeWaveBytes(encode(repeats));assert.equal(result.status,'unsupported');assert.equal(result.code,'analysis_budget_exceeded');
});

test('explicit generation refuses overwrites and symlink outputs, preserving existing bytes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'producer-tone-proof-'));
 try{
  const path=join(directory,'fixture.wav'),initial=await generateToneFile(path);assert.equal(initial.status,'generated');assert.equal((await probeToneFile(path)).status,'matched');
  const bytes=await readFile(path);assert.equal((await generateToneFile(path)).code,'output_exists');assert.deepEqual(await readFile(path),bytes);
  const link=join(directory,'link.wav');await symlink(path,link);assert.equal((await generateToneFile(link)).code,'output_exists');assert.deepEqual(await readFile(path),bytes);
  assert.equal((await probeToneFile(link)).code,'input_unreadable');assert.equal((await probeToneFile(directory)).code,'regular_file_required');
  assert.equal((await generateToneFile('implicit.wav')).code,'explicit_absolute_path_required');assert.equal((await probeToneFile('implicit.wav')).code,'explicit_absolute_path_required');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('CLI status/exit contracts expose no supplied path, native error, PCM or extra files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'producer-tone-cli-')),output=[];const original=console.log;
 try{
  console.log=value=>output.push(value);
  const path=join(directory,'PRIVATE-recording-name.wav');await writeFile(path,Buffer.from('not a WAV'));
  assert.equal(await main(['probe',path]),2);assert.equal(await main(['probe','relative.wav']),3);assert.equal(await main(['unknown',path]),64);
  const generated=join(directory,'new.wav');assert.equal(await main(['generate',generated]),0);assert.equal(await main(['generate',generated]),3);assert.equal(await main(['probe',generated]),0);
  assert.doesNotMatch(output.join(''),/PRIVATE|not a WAV|\/private\/|ENOENT|EEXIST|pcm":|data:|RIFF/);
  assert.deepEqual(output.map(line=>JSON.parse(line).status),['insufficient','unsupported','unsupported','generated','unsupported','matched']);
 }finally{console.log=original;await rm(directory,{recursive:true,force:true});}
});
