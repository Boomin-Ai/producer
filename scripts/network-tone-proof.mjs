#!/usr/bin/env node
/** Offline fixture generation and supplied-WAV analysis only. This program
 * never opens a device, plays audio, records, joins, controls mute, executes a
 * shell/ffmpeg or performs network requests. No audio is exported by probe. */
import {constants} from 'node:fs';
import {lstat,open,readFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const LIMITS=Object.freeze({fileBytes:16*1024*1024,durationSeconds:60,chunks:256,minimumRate:8000,maximumRate:96000,analysisSamples:60_000_000,analysisCalls:8000});
export const FIXTURE=Object.freeze({version:1,sampleRate:48000,channels:2,bitsPerSample:16,peakAmplitude:0.04,rampMs:10,durationMs:1300,
 pattern:Object.freeze([
  Object.freeze({kind:'silence',durationMs:160}),
  Object.freeze({kind:'tone',durationMs:220,frequencyHz:440}),
  Object.freeze({kind:'silence',durationMs:160}),
  Object.freeze({kind:'tone',durationMs:220,frequencyHz:997}),
  Object.freeze({kind:'silence',durationMs:160}),
  Object.freeze({kind:'tone',durationMs:220,frequencyHz:1531}),
  Object.freeze({kind:'silence',durationMs:160}),
 ])});
const THRESHOLDS=Object.freeze({minimumToneRms:0.003,minimumToneFraction:0.7,maximumSilenceRms:0.003});
const COVERAGE=Object.freeze({verification:'supplied_recording_pcm_pattern_only',speakerAudibility:'not_tested',muteBehavior:'not_tested',networkLatency:'not_tested'});
class Rejection extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
function reject(status,code){throw new Rejection(status,code);}
const round=value=>Number(value.toFixed(6));
const base=(status,code)=>({kind:'producer-network-tone-proof',version:1,status,code,coverage:COVERAGE});

/** Deterministic little-endian stereo48k PCM16. A low digital level is not a
 * physical hearing-safety guarantee: the external playback chain owns gain. */
export function createToneFixture(){
 const frames=Math.round(FIXTURE.durationMs*FIXTURE.sampleRate/1000),bytes=frames*FIXTURE.channels*2;
 const wav=Buffer.alloc(44+bytes);
 wav.write('RIFF',0);wav.writeUInt32LE(36+bytes,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
 wav.writeUInt16LE(1,20);wav.writeUInt16LE(FIXTURE.channels,22);wav.writeUInt32LE(FIXTURE.sampleRate,24);
 wav.writeUInt32LE(FIXTURE.sampleRate*FIXTURE.channels*2,28);wav.writeUInt16LE(FIXTURE.channels*2,32);wav.writeUInt16LE(16,34);
 wav.write('data',36);wav.writeUInt32LE(bytes,40);
 let offset=0;
 for(const segment of FIXTURE.pattern){
  const count=Math.round(segment.durationMs*FIXTURE.sampleRate/1000),ramp=Math.round(FIXTURE.rampMs*FIXTURE.sampleRate/1000);
  if(segment.kind==='tone')for(let frame=0;frame<count;frame++){
   const edge=Math.min(1,frame/ramp,(count-1-frame)/ramp),gain=0.5-0.5*Math.cos(Math.PI*edge);
   const value=Math.round(32767*FIXTURE.peakAmplitude*gain*Math.sin(frame*2*Math.PI*segment.frequencyHz/FIXTURE.sampleRate));
   for(let channel=0;channel<FIXTURE.channels;channel++)wav.writeInt16LE(value,44+((offset+frame)*FIXTURE.channels+channel)*2);
  }
  offset+=count;
 }
 return wav;
}

/** No following a symlink, truncating a file or replacing an existing path. */
export async function generateToneFile(path){
 if(typeof path!=='string'||!isAbsolute(path))return base('unsupported','explicit_absolute_path_required');
 let file;
 try{
  file=await open(path,'wx',0o600);await file.writeFile(createToneFixture());await file.sync();
  return {...base('generated','fixture_written'),sampleRate:FIXTURE.sampleRate,channels:FIXTURE.channels,bitsPerSample:16,durationMs:FIXTURE.durationMs,
   peakAmplitude:FIXTURE.peakAmplitude,rampMs:FIXTURE.rampMs,pattern:FIXTURE.pattern};
 }catch(error){return base('unsupported',error?.code==='EEXIST'?'output_exists':'output_unwritable');}
 finally{await file?.close().catch(()=>{});}
}

function decodeWave(bytes){
 if(!Buffer.isBuffer(bytes))reject('unsupported','byte_buffer_required');
 if(bytes.length>LIMITS.fileBytes)reject('unsupported','file_budget_exceeded');
 if(bytes.length<12)reject('insufficient','truncated_wav');
 if(bytes.toString('latin1',0,4)!=='RIFF'||bytes.toString('latin1',8,12)!=='WAVE')reject('unsupported','unsupported_wav_container');
 const end=bytes.readUInt32LE(4)+8;
 if(end>bytes.length)reject('insufficient','truncated_wav');
 if(end<12||end!==bytes.length)reject('unsupported','invalid_riff_bounds');
 let offset=12,count=0,format=null,data=null;
 while(offset<end){
  if(++count>LIMITS.chunks)reject('unsupported','chunk_budget_exceeded');
  if(end-offset<8)reject('insufficient','truncated_chunk_header');
  const id=bytes.toString('latin1',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8,finish=start+size,padded=finish+(size&1);
  if(finish>end||padded>end)reject('insufficient','truncated_chunk');
  if(id==='fmt '){
   if(format)reject('unsupported','ambiguous_format_chunks');
   if(size<16)reject('insufficient','truncated_format');
   format={tag:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),sampleRate:bytes.readUInt32LE(start+4),byteRate:bytes.readUInt32LE(start+8),blockAlign:bytes.readUInt16LE(start+12),bitsPerSample:bytes.readUInt16LE(start+14)};
   if(![16,18].includes(size)||size===18&&bytes.readUInt16LE(start+16)!==0)reject('unsupported','unsupported_format_extension');
  }else if(id==='data'){
   if(data)reject('unsupported','ambiguous_data_chunks');
   data={start,size};
  }
  offset=padded;
 }
 if(!format||!data)reject('unsupported','missing_pcm_chunks');
 if(format.tag!==1)reject('unsupported','unsupported_audio_encoding');
 if(format.bitsPerSample!==16)reject('unsupported','unsupported_bit_depth');
 if(![1,2].includes(format.channels))reject('unsupported','unsupported_channels');
 if(format.sampleRate<LIMITS.minimumRate||format.sampleRate>LIMITS.maximumRate)reject('unsupported','unsupported_sample_rate');
 if(format.blockAlign!==format.channels*2||format.byteRate!==format.sampleRate*format.blockAlign)reject('unsupported','invalid_pcm_alignment');
 if(data.size%format.blockAlign)reject('insufficient','truncated_pcm_frame');
 const frames=data.size/format.blockAlign;
 if(frames>format.sampleRate*LIMITS.durationSeconds)reject('unsupported','duration_budget_exceeded');
 if(frames<Math.round(FIXTURE.durationMs*format.sampleRate/1000))reject('insufficient','pattern_window_unavailable');
 const pcm=new Float32Array(frames*format.channels);
 for(let sample=0;sample<pcm.length;sample++)pcm[sample]=bytes.readInt16LE(data.start+sample*2)/32768;
 return {pcm,frames,sampleRate:format.sampleRate,channels:format.channels,bitsPerSample:16};
}

let analyzerPromise;
async function canonicalAnalyzer(){
 // Compile only the fixed, application-owned pure module. Supplied recordings
 // are never imported or executed, and no second Goertzel implementation lives
 // here. TypeScript is already a repo dependency and performs this in-process.
 return analyzerPromise??=Promise.all([import('typescript'),readFile(new URL('../src/lib/producerMediaDiagnostics.ts',import.meta.url),'utf8')]).then(async([module,source])=>{
  const ts=module.default??module,compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const canonical=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
  if(typeof canonical.analyzeKnownTonePattern!=='function')throw Error('canonical_analyzer_unavailable');
  return canonical.analyzeKnownTonePattern;
 });
}

/** Unknown initial alignment is searched, not asserted as known. A returned
 * offset is recording-relative window placement, never transport latency. */
export async function probeWaveBytes(bytes){
 try{
  const wave=decodeWave(bytes),analyze=await canonicalAnalyzer(),{pcm,frames,sampleRate,channels}=wave;
  const patternFrames=Math.round(FIXTURE.durationMs*sampleRate/1000),last=frames-patternFrames,step=Math.max(1,Math.round(sampleRate/100)),fine=Math.max(1,Math.round(sampleRate/1000));
  const prefix=new Float64Array(frames+1);
  for(let frame=0;frame<frames;frame++){
   let energy=0;for(let channel=0;channel<channels;channel++){const value=pcm[frame*channels+channel];energy+=value*value;}
   prefix[frame+1]=prefix[frame]+energy;
  }
  const rms=(start,end)=>Math.sqrt(Math.max(0,prefix[end]-prefix[start])/((end-start)*channels));
  const silent=[];let elapsed=0;
  for(const segment of FIXTURE.pattern){
   if(segment.kind==='silence')silent.push({start:Math.round((elapsed+20)*sampleRate/1000),end:Math.round((elapsed+segment.durationMs-20)*sampleRate/1000)});
   elapsed+=segment.durationMs;
  }
  const toneStart=Math.round(200*sampleRate/1000),toneEnd=Math.round(340*sampleRate/1000),checks=new Set();
  let calls=0,samples=0,scanned=0;
  function inspect(start,count,pattern){
   if(++calls>LIMITS.analysisCalls||(samples+=count*channels)>LIMITS.analysisSamples)reject('unsupported','analysis_budget_exceeded');
   return analyze(pcm.subarray(start*channels,(start+count)*channels),sampleRate,pattern,{channels,...THRESHOLDS});
  }
  // A last non-grid window is checked too, so an exact fit at EOF is searched.
  const starts=[];for(let start=0;start<=last;start+=step)starts.push(start);if(starts.at(-1)!==last)starts.push(last);
  for(const coarse of starts){
   scanned++;
   if(silent.some(segment=>rms(coarse+segment.start,coarse+segment.end)>THRESHOLDS.maximumSilenceRms)||rms(coarse+toneStart,coarse+toneEnd)<THRESHOLDS.minimumToneRms)continue;
   if(!inspect(coarse+toneStart,toneEnd-toneStart,[{kind:'tone',durationMs:(toneEnd-toneStart)*1000/sampleRate,frequencyHz:440}]).matched)continue;
   let best=null;
   // The first qualifying coarse window can sit just before the true onset:
   // the quiet-gap prefilter trims20ms and the10ms ramps add tolerance. Cover
   // those margins plus one coarse hop, then select the best full-pattern
   // score instead of reporting the earliest passing offset as precise.
   const margin=Math.round((20+FIXTURE.rampMs)*sampleRate/1000)+step;
   const from=Math.max(0,coarse-margin),until=Math.min(last,coarse+margin),candidates=[];
   for(let start=from;start<=until;start+=fine)candidates.push(start);if(candidates.at(-1)!==until)candidates.push(until);
   for(const start of candidates){
    if(checks.has(start))continue;checks.add(start);
    const result=inspect(start,patternFrames,FIXTURE.pattern);
    if(!result.matched)continue;
    const score=result.segments.reduce((sum,segment)=>sum+(segment.toneFraction??-segment.rms*100),0);
    if(!best||score>best.score)best={start,score,result};
   }
   if(best)return {...base('matched','known_pattern_detected'),sampleRate,channels,bitsPerSample:16,durationMs:round(frames*1000/sampleRate),
    offsetMs:round(best.start*1000/sampleRate),offsetMeaning:'recording_relative_pattern_window_not_latency',scanStepMs:round(step*1000/sampleRate),refinementStepMs:round(fine*1000/sampleRate),
    windowsScanned:scanned,analyzerCalls:calls,thresholds:THRESHOLDS,
    segments:best.result.segments.map(segment=>({kind:segment.kind,matched:segment.matched,rms:round(segment.rms),toneFraction:segment.toneFraction===null?null:round(segment.toneFraction)}))};
  }
  return {...base('no_match','complete_pattern_not_detected'),sampleRate,channels,bitsPerSample:16,durationMs:round(frames*1000/sampleRate),
   offsetMs:null,searchThroughMs:round(last*1000/sampleRate),windowsScanned:scanned,analyzerCalls:calls,thresholds:THRESHOLDS};
 }catch(error){return base(error instanceof Rejection?error.status:'unsupported',error instanceof Rejection?error.code:'analysis_unavailable');}
}

/** A stable regular file is read through one descriptor, at most16MiB. This
 * refuses active/changing recordings, symlinks, FIFOs and arbitrary devices. */
export async function probeToneFile(path){
 if(typeof path!=='string'||!isAbsolute(path))return base('unsupported','explicit_absolute_path_required');
 let file;
 try{
  const entry=await lstat(path);
  if(entry.isSymbolicLink())return base('unsupported','input_unreadable');
  if(!entry.isFile())return base('unsupported','regular_file_required');
  file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await file.stat();
  if(!before.isFile())return base('unsupported','regular_file_required');
  if(before.dev!==entry.dev||before.ino!==entry.ino)return base('unsupported','changing_input');
  if(before.size>LIMITS.fileBytes)return base('unsupported','file_budget_exceeded');
  const bytes=Buffer.alloc(before.size);let received=0;
  while(received<bytes.length){const read=await file.read(bytes,received,Math.min(65536,bytes.length-received),received);if(!read.bytesRead)return base('insufficient','truncated_input');received+=read.bytesRead;}
  const after=await file.stat();
  if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)return base('unsupported','changing_input');
  return await probeWaveBytes(bytes);
 }catch{return base('unsupported','input_unreadable');}
 finally{await file?.close().catch(()=>{});}
}

export async function main(args=process.argv.slice(2)){
 if(args.length===1&&['--help','-h'].includes(args[0])){
  console.log('Offline only. Generate a new stereo48k PCM16 fixture or inspect a completed PCM16 mono/stereo WAV (up to60s/16MiB).\nUsage: node scripts/network-tone-proof.mjs generate /absolute/new.wav\n       node scripts/network-tone-proof.mjs probe /absolute/recorded.wav\nNo playback, devices, capture, recording, mute control, conversion or network access. A match proves the supplied PCM pattern only; offsets are not network latency.');return 0;
 }
 if(args.length!==2||!['generate','probe'].includes(args[0])){console.log(JSON.stringify(base('unsupported','usage')));return 64;}
 const result=await(args[0]==='generate'?generateToneFile(args[1]):probeToneFile(args[1]));
 console.log(JSON.stringify(result));
 return {generated:0,matched:0,no_match:1,insufficient:2,unsupported:3}[result.status]??3;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
