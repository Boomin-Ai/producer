// Deliberate local microphone publication test. Never record received voice.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv[2] !== '--publish-microphone') throw new Error('Explicit --publish-microphone is required; this sends your microphone to the local SFU');
if (process.env.LIVEKIT_LAB_PHYSICAL_CAPTURE !== '1' || !process.env.LIVEKIT_LAB_PHYSICAL_SPEECH) throw new Error('Explicit physical capture/reference configuration required');
const lab=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name=process.env.LIVEKIT_LAB_RUN_NAME;
const seconds=Number(process.env.LIVEKIT_LAB_SECONDS??20);
if (!Number.isInteger(seconds)||seconds<5||seconds>300) throw new Error('Physical trial duration must be 5..300 seconds');
if (!/^physical-publication-[0-9]+$/.test(name??'')) throw new Error('Unique physical-publication run name required');
const monitor=process.env.LIVEKIT_LAB_GUEST_MONITOR==='1';
let exited=false;
let child,done,log='',browser,page,connected=false,readyTimer;
try {
 // Warm generated guest + receiver before hardware starts. Browser startup
 // must not consume the physical trial or miss its short publication window.
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 page=await browser.newPage();await page.goto(`http://127.0.0.1:8990/?identity=guest-1${monitor?'&monitorSpeech=1':''}`);
 await page.evaluate(({seconds,monitor})=>{
  document.title='Producer — local LiveKit microphone test';
  const notice=document.createElement('p');notice.textContent=`Local microphone timing test • ${seconds} seconds • Browser speakers stay silent. ${monitor ? "Native speakers play remote speech. Use built-in speakers and microphone, disconnect headphones. Talk over the clip to check double-talk." : "No speaking needed."}`;notice.style.fontWeight='bold';document.body.prepend(notice);
 },{seconds,monitor});
 await page.bringToFront();
 await page.evaluate(()=>window.startLab());
 await page.waitForFunction(()=>window.labState.published,undefined,{timeout:10000});
 await new Promise(r=>setTimeout(r,2000));
 if(process.env.LIVEKIT_LAB_WAIT_FOR_START==='1') {
  await page.evaluate(()=>{
   window.physicalTestStarted=false;
   const button=document.createElement('button');button.textContent='Start 60-second speaker test';
   button.onclick=()=>{window.physicalTestStarted=true;button.disabled=true;button.textContent='Test running';};document.body.prepend(button);
  });
  console.log('Ready: click Start 60-second speaker test in the visible local lab. Microphone is not running yet.');
  await page.waitForFunction(()=>window.physicalTestStarted,undefined,{timeout:300000});
 }
 console.log(`Browser receiver warm; starting native ${seconds}-second capture now`);
 child=spawn(path.join(lab,'target/debug/producer-guest-rtc-lab'),['transport',path.join(lab,'runtime/native-token'),path.join(lab,`evidence/${name}.json`),String(seconds)],{cwd:lab});
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
 while(!exited) {
  await new Promise(r=>setTimeout(r,1000));
  if(process.env.LIVEKIT_LAB_GUEST_REJOIN==='1' && !rejoinCompleted && performance.now()-observationBegan>=5000 && !exited) {
   await page.evaluate(()=>window.stopLab());await new Promise(r=>setTimeout(r,1000));
   await page.evaluate(()=>window.startLab());await page.waitForFunction(()=>window.labState.published,undefined,{timeout:10000});
   rejoinCompleted=true;
  }
  const observation=await page.evaluate(async()=>({state:window.labState,audio:[...((await window.returnAudioTrack?.getRTCStatsReport())?.values()??[])].filter(s=>s.type==='inbound-rtp'&&s.kind==='audio')}));
  if(observations.length<300)observations.push(observation);
  if(observation.audio.length || !snapshot)snapshot=observation;
 }
 snapshot??={state:{error:'No observed receiver'},audio:[]};
 const code=await done;
 const native=JSON.parse(await readFile(path.join(lab,`evidence/${name}.json`),'utf8'));
 const recoveries=native.capture_publication?.deadline_recoveries??0;
 const report={guest_rejoin_requested:process.env.LIVEKIT_LAB_GUEST_REJOIN==='1',guest_rejoin_completed:rejoinCompleted,sdk_reconnect_requested:process.env.LIVEKIT_LAB_MONITOR_RECONNECT??null,seconds,observations,deadline_recoveries:recoveries,source_fault_free:code===0&&recoveries===0,...snapshot,native_exit_code:code,receiver_warmed_before_native:true,physical_microphone_publication_requested:true,received_audio_recorded:false,browser_speaker_output_gain:0,reference_scope:monitor?'selected remote guest speech through final native speaker output':'native lab clip only; guest return not played',guest_monitor_requested:monitor,camera_sync_qualified:false,g1_complete:false};
 await writeFile(path.join(lab,`evidence/${name}-browser.json`),JSON.stringify(report,null,2)+'\n');
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
} finally {
 clearTimeout(readyTimer);
 await page?.evaluate(()=>window.stopLab()).catch(()=>{});await browser?.close();
 if(child && child.exitCode===null){child.kill('SIGTERM');await done;}
 await writeFile(path.join(lab,`runtime/${name}.log`),log);
}
