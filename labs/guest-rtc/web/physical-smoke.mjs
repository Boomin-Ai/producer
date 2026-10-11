// Deliberate local microphone publication; decoded recording requires explicit voice-review opt-in.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { writeFile, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {decodedVoiceWav} from './voice-review-wav.mjs';
import { fileURLToPath } from 'node:url';
if (process.argv[2] !== '--publish-microphone') throw new Error('Explicit --publish-microphone is required; this sends your microphone to the local SFU');
if (process.env.LIVEKIT_LAB_PHYSICAL_CAPTURE !== '1' || !process.env.LIVEKIT_LAB_PHYSICAL_SPEECH) throw new Error('Explicit physical capture/reference configuration required');
const lab=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name=process.env.LIVEKIT_LAB_RUN_NAME;
const seconds=Number(process.env.LIVEKIT_LAB_SECONDS??20);
if (!Number.isInteger(seconds)||seconds<5||seconds>300) throw new Error('Physical trial duration must be 5..300 seconds');
if (!/^physical-publication-[0-9]+$/.test(name??'')) throw new Error('Unique physical-publication run name required');
const monitor=process.env.LIVEKIT_LAB_GUEST_MONITOR==='1';
const voiceReview=process.env.LIVEKIT_LAB_VOICE_REVIEW==='1';
const cameraSync=process.env.LIVEKIT_LAB_CAMERA_SYNC==='1';
const nativeExecutable=process.env.LIVEKIT_LAB_EXECUTABLE??path.join(lab,'target/debug/producer-guest-rtc-lab');
let privateDirectory;
if(voiceReview || cameraSync) {
 if(!monitor || process.env.LIVEKIT_LAB_WAIT_FOR_START!=='1' || seconds<(cameraSync?20:35) || seconds>60 || process.env.LIVEKIT_LAB_MONITOR_RECONNECT || process.env.LIVEKIT_LAB_GUEST_REJOIN)throw new Error('Invalid explicit voice-review configuration');
 privateDirectory=path.join(os.homedir(),'Library/Application Support/Producer Guest RTC Lab',`voice-review-${name}`);
 if(process.env.LIVEKIT_LAB_VOICE_REVIEW_DIRECTORY!==privateDirectory)throw new Error('Unexpected private voice directory');
 const directory=await lstat(privateDirectory);
 if(!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode&0o777)!==0o700)throw new Error('Private voice directory must be a real directory with mode 0700');
}
let exited=false;
let child,done,log='',browser,page,connected=false,readyTimer,permission;
try {
 // Warm generated guest + receiver before hardware starts. Browser startup
 // must not consume the physical trial or miss its short publication window.
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 page=await browser.newPage();await page.goto(`http://127.0.0.1:8990/?identity=guest-1${monitor?'&monitorSpeech=1':''}${voiceReview?'&voiceReview=1':''}${cameraSync?'&cameraSync=1':''}`);
 await page.evaluate(({seconds,monitor,voiceReview,cameraSync})=>{
  document.title=cameraSync?'Producer — camera/audio sync':voiceReview?'Producer — private voice review':'Producer — local LiveKit microphone test';
  if(voiceReview || cameraSync){document.querySelector('h1').textContent=cameraSync?'Producer camera/audio sync test':'Producer voice test';document.querySelector('h1+p').textContent=cameraSync?'Native camera and mic start after permission succeeds. Decoded video/audio are saved privately for sync review.':'Native mic starts after Start. Your decoded voice is saved privately for listening afterward.';document.querySelector('#start').hidden=true;document.querySelector('#stop').hidden=true;}
  const notice=document.createElement('p');notice.id='voice-review-instructions';notice.textContent=cameraSync?`Private ${seconds}-second native camera/audio recording. Click Start, then Allow camera/mic if macOS asks. Wait for your video, clap three times with hands in view (three seconds apart), then speak clearly while looking at the camera. Guest clip is silent; microphone return is never played during capture.`:voiceReview?`Private ${seconds}-second voice recording. Built-in speakers/mic near 50%. First 10 seconds quiet; 10–30 seconds talk over the clip; after 30 seconds keep talking with the clip silent. Decoded microphone WAV stays on this Mac. Your mic is never played during capture.`:`Local microphone timing test • ${seconds} seconds • Browser speakers stay silent. ${monitor ? "Native speakers play remote speech. Use built-in speakers and microphone, disconnect headphones. Talk over the clip to check double-talk." : "No speaking needed."}`;notice.style.fontWeight='bold';document.body.prepend(notice);
 },{seconds,monitor,voiceReview,cameraSync});
 await page.bringToFront();
 await page.evaluate(()=>window.startLab());
 await page.waitForFunction(()=>window.labState.published,undefined,{timeout:10000});
 if(cameraSync)await page.evaluate(()=>window.setGuestSpeechEnabled(false));
 await new Promise(r=>setTimeout(r,2000));
 if(process.env.LIVEKIT_LAB_WAIT_FOR_START==='1') {
  await page.evaluate(({seconds,voiceReview,cameraSync})=>{
   window.physicalTestStarted=false;
   const button=document.createElement('button');button.textContent=`Start ${seconds}-second ${cameraSync?'camera sync':voiceReview?'voice':'speaker'} test`;
   button.onclick=()=>{window.physicalTestStarted=true;button.disabled=true;button.textContent='Test running';};document.body.prepend(button);
  },{seconds,voiceReview,cameraSync});
  console.log(`Ready: click Start ${seconds}-second ${cameraSync?'camera sync':voiceReview?'voice':'speaker'} test. Microphone is not running yet.`);
  await page.waitForFunction(()=>window.physicalTestStarted,undefined,{timeout:cameraSync?1800000:300000});
 }
 if(cameraSync) {
  console.log('Camera/microphone permission check — use Allow in the macOS dialog if requested. No capture starts before permission succeeds.');
  permission=spawn(nativeExecutable,['camera-permissions'],{cwd:lab,stdio:'inherit'});
  page.once('close',()=>{if(permission?.exitCode===null)permission.kill('SIGTERM');});
  const code=await new Promise((resolve,reject)=>{permission.on('error',reject);permission.on('exit',resolve);});
  if(page.isClosed())throw new Error('Test window closed before camera capture');
  if(code!==0)throw new Error('Camera/microphone permission not granted');
 }
 console.log(`Browser receiver warm; starting native ${seconds}-second capture now`);
 child=spawn(nativeExecutable,['transport',path.join(lab,'runtime/native-token'),path.join(lab,`evidence/${name}.json`),String(seconds)],{cwd:lab});
 done=new Promise(resolve=>child.on('exit',code=>{exited=true;resolve(code);}));
 const ready=new Promise((resolve,reject)=>{
  child.on('error',reject);
  child.stdout.on('data',d=>{log+=d;process.stdout.write(d);if(!connected&&log.includes('Native host connected')){connected=true;resolve();}});
  child.stderr.on('data',d=>{log+=d;process.stderr.write(d);});
  child.on('exit',code=>{if(!connected)reject(new Error(`Native rejected/failed before connection (${code})`));});
 });
 await Promise.race([ready,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(new Error('Native readiness timeout')),15000);})]);clearTimeout(readyTimer);
 const observations=[];let snapshot;
 const observationBegan=performance.now();let rejoinCompleted=false;
 let clipMuted=false;
 while(!exited) {
  await new Promise(r=>setTimeout(r,1000));
  if(process.env.LIVEKIT_LAB_GUEST_REJOIN==='1' && !rejoinCompleted && performance.now()-observationBegan>=5000 && !exited) {
   await page.evaluate(()=>window.stopLab());await new Promise(r=>setTimeout(r,1000));
   await page.evaluate(()=>window.startLab());await page.waitForFunction(()=>window.labState.published,undefined,{timeout:10000});
   rejoinCompleted=true;
  }
  if(voiceReview) {
   const elapsed=(performance.now()-observationBegan)/1000;
   if(elapsed>=30 && !clipMuted) {await page.evaluate(()=>window.setGuestSpeechEnabled(false));clipMuted=true;}
   await page.evaluate(({elapsed,seconds})=>{document.querySelector('#voice-review-instructions').textContent=`${Math.floor(elapsed)} / ${seconds} seconds — ${elapsed<10?'Stay quiet; the guest clip is playing.':elapsed<30?'Talk over the guest clip.':'Keep talking; the guest clip is now silent.'} Your microphone return is recorded locally and stays silent during capture.`;},{elapsed,seconds});
  }
  if(cameraSync)await page.evaluate(({elapsed,seconds})=>{document.querySelector('#voice-review-instructions').textContent=window.labState.returnVideoFrames>0?`${Math.floor(elapsed)} / ${seconds} seconds — Clap three times with hands visible, then speak toward the camera. Your microphone return stays silent.`:'Preparing native camera — wait for your video before clapping.';},{elapsed:(performance.now()-observationBegan)/1000,seconds});
  const observation=await page.evaluate(async()=>({state:window.labState,audio:[...((await window.returnAudioTrack?.getRTCStatsReport())?.values()??[])].filter(s=>s.type==='inbound-rtp'&&s.kind==='audio')}));
  if(observations.length<300)observations.push(observation);
  if(observation.audio.length || !snapshot)snapshot=observation;
 }
 snapshot??={state:{error:'No observed receiver'},audio:[]};
 const code=await done;
 const native=JSON.parse(await readFile(path.join(lab,`evidence/${name}.json`),'utf8'));
 const recoveries=native.capture_publication?.deadline_recoveries??0;
 let avCapture=null;
 if(cameraSync){
  try{const capture=await page.evaluate(()=>window.finishAvReview());const data=Buffer.from(capture.base64,"base64");if(data.length!==capture.bytes || data.length<1000 || data.length>20000000)throw new Error("Invalid private AV capture");await writeFile(path.join(privateDirectory,"decoded-av.webm"),data,{mode:0o600,flag:"wx"});avCapture={recorded:true,bytes:data.length,mime:capture.mime,scope:"private Application Support; decoded AV browser re-encode, not raw source media"};await writeFile(path.join(privateDirectory,"av-review.json"),JSON.stringify({run:name,...avCapture},null,2)+"\n",{mode:0o600,flag:"wx"});console.log(`Private AV recording ready: ${path.join(privateDirectory,"decoded-av.webm")}`);}catch(error){avCapture={recorded:false,error:String(error)};}
 }
 let voiceCapture=null;
 if(voiceReview) {
  try {
   const capture=await page.evaluate(()=>window.finishVoiceReview());
   if(capture.error)throw new Error(capture.error);
   const wav=decodedVoiceWav(capture.chunks,capture.samples,capture.rate,seconds);
   const file=path.join(privateDirectory,'decoded-return.wav');
   await writeFile(file,wav,{mode:0o600,flag:'wx'});
   voiceCapture={recorded:true,rate:capture.rate,samples:capture.samples,duration_seconds:capture.samples/capture.rate,bytes:wav.length,scope:'private Application Support decoded return; no PCM in repository',guest_clip_muted_after_30_seconds:clipMuted};
   await writeFile(path.join(privateDirectory,'review.json'),JSON.stringify({run:name,...voiceCapture},null,2)+'\n',{mode:0o600,flag:'wx'});
   console.log(`Private decoded voice WAV ready: ${file}`);
  } catch(error) {voiceCapture={recorded:false,error:String(error)};}
 }
 const report={av_capture:avCapture,voice_capture:voiceCapture,guest_rejoin_requested:process.env.LIVEKIT_LAB_GUEST_REJOIN==='1',guest_rejoin_completed:rejoinCompleted,sdk_reconnect_requested:process.env.LIVEKIT_LAB_MONITOR_RECONNECT??null,seconds,observations,deadline_recoveries:recoveries,source_fault_free:code===0&&recoveries===0,...snapshot,native_exit_code:code,receiver_warmed_before_native:true,physical_microphone_publication_requested:true,received_audio_recorded:voiceCapture?.recorded||avCapture?.recorded||false,browser_speaker_output_gain:0,reference_scope:monitor?'selected remote guest speech through final native speaker output':'native lab clip only; guest return not played',guest_monitor_requested:monitor,camera_sync_qualified:false,g1_complete:false};
 await writeFile(path.join(lab,`evidence/${name}-browser.json`),JSON.stringify(report,null,2)+'\n');
 if(cameraSync && (!avCapture?.recorded || !native.capture_publication?.camera?.submitted))throw new Error(`Physical camera/AV capture failed: ${avCapture?.error??"no native camera frames"}`);
 if(voiceReview && !voiceCapture?.recorded)throw new Error(`Decoded voice review failed: ${voiceCapture?.error}`);
 if(code!==0)throw new Error(`Native physical publication failed (${code}); retain reports`);
 if(snapshot.state.error || !snapshot.audio.some(s=>(s.packetsReceived??0)>100) || snapshot.state.returnVideoFrames<20)throw new Error('Browser did not receive expected physical audio RTP and placeholder video');
 if(process.env.LIVEKIT_LAB_GUEST_REJOIN==='1') {
  const subscriptions=native.lifecycle?.filter(event=>event.event==='subscribed'&&event.identity==='guest-1'&&event.sid.startsWith('TR_A'))??[];
  if(!rejoinCompleted || new Set(subscriptions.map(event=>event.sid)).size<2)throw new Error('Remote guest did not replace its audio publication');
  const returned=subscriptions.at(-1);
  const after=(native.capture_publication?.guest_monitor?.progress??[]).filter(item=>Number(item.at_ms)>Number(returned.at_ms)+2000);
  if(after.length<2 || after.at(-1).native.played_blocks-after[0].native.played_blocks<100)throw new Error('Native monitor did not play the replacement guest track');
 }
 if(process.env.LIVEKIT_LAB_MONITOR_RECONNECT) {
  const rebound=native.lifecycle?.find(event=>event.event==='guest_monitor_rebound');
  const resumed=native.lifecycle?.find(event=>event.event==='reconnected');
  if(!resumed || !rebound)throw new Error('SDK reconnect did not rebind the selected native guest monitor');
  const progress=native.capture_publication?.guest_monitor?.progress??[];
  const after=progress.filter(item=>Number(item.at_ms)>Number(resumed.at_ms)+2000);
  if(after.length<2 || after.at(-1).native.played_blocks-after[0].native.played_blocks<100)throw new Error('Native monitor did not play new guest PCM after reconnect');
 }
 console.log(`Local physical audio RTP reception observed; ${recoveries} deadline recoveries; no camera-sync/full-AEC claim`);
} catch(error) {
 if(permission?.exitCode===null)permission.kill('SIGTERM');
 if(child?.exitCode===null){child.kill('SIGTERM');await done;}
 if(cameraSync && page && !page.isClosed()) {
  await page.evaluate(message=>{document.querySelector('#voice-review-instructions').textContent=`Test stopped: ${message}. Diagnostics saved. You can close this window.`;document.querySelector('#voice-review-instructions').style.color='#b00020';},String(error)).catch(()=>{});
  console.error(error);
  await Promise.race([new Promise(resolve=>page.once('close',resolve)),new Promise(resolve=>setTimeout(resolve,60000))]);
 }
 throw error;
} finally {
 clearTimeout(readyTimer);
 if(permission?.exitCode===null)permission.kill('SIGTERM');
 await page?.evaluate(()=>window.stopLab()).catch(()=>{});await browser?.close();
 if(child && child.exitCode===null){child.kill('SIGTERM');await done;}
 await writeFile(path.join(lab,`runtime/${name}.log`),log);
}
