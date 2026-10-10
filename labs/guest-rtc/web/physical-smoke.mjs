// Deliberate local microphone publication test. Never record received voice.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv[2] !== '--publish-microphone') throw new Error('Explicit --publish-microphone is required; this sends your microphone to the local SFU');
if (process.env.LIVEKIT_LAB_PHYSICAL_CAPTURE !== '1' || !process.env.LIVEKIT_LAB_PHYSICAL_SPEECH) throw new Error('Explicit physical capture/reference configuration required');
const lab=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name=process.env.LIVEKIT_LAB_RUN_NAME;
if (!/^physical-publication-[0-9]+$/.test(name??'')) throw new Error('Unique physical-publication run name required');
const child=spawn(path.join(lab,'target/debug/producer-guest-rtc-lab'),['transport',path.join(lab,'runtime/native-token'),path.join(lab,`evidence/${name}.json`),'20'],{cwd:lab});
let log='',browser,page,connected=false;
const ready=new Promise((resolve,reject)=>{
 child.on('error',reject);
 child.stdout.on('data',d=>{log+=d;process.stdout.write(d);if(!connected&&log.includes('Native host connected')){connected=true;resolve();}});
 child.stderr.on('data',d=>{log+=d;process.stderr.write(d);});
 child.on('exit',code=>{if(!connected)reject(new Error(`Native rejected/failed before connection (${code})`));});
});
const done=new Promise(resolve=>child.on('exit',resolve));
let readyTimer;
try {
 await Promise.race([ready,new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(new Error('Native readiness timeout')),15000);})]);clearTimeout(readyTimer);
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 page=await browser.newPage();await page.goto('http://127.0.0.1:8990/?identity=guest-1');await page.evaluate(()=>window.startLab());
 await page.waitForFunction(()=>window.labState.published,undefined,{timeout:10000});
 await new Promise(r=>setTimeout(r,8000));
 const snapshot=await page.evaluate(async()=>({state:window.labState,audio:[...((await window.returnAudioTrack?.getRTCStatsReport())?.values()??[])].filter(s=>s.type==='inbound-rtp'&&s.kind==='audio')}));
 const code=await done;
 const report={...snapshot,native_exit_code:code,physical_microphone_publication_requested:true,received_audio_recorded:false,browser_speaker_output_gain:0,reference_scope:'native lab clip only; guest return not played',camera_sync_qualified:false,g1_complete:false};
 await writeFile(path.join(lab,`evidence/${name}-browser.json`),JSON.stringify(report,null,2)+'\n');
 if(code!==0)throw new Error(`Native physical publication failed (${code}); retain reports`);
 if(snapshot.state.error || !snapshot.audio.some(s=>(s.packetsReceived??0)>100) || snapshot.state.returnVideoFrames<20)throw new Error('Browser did not receive expected physical audio RTP and placeholder video');
 console.log('Local physical audio RTP reception observed; no camera-sync/full-AEC claim');
} finally {
 clearTimeout(readyTimer);
 await page?.evaluate(()=>window.stopLab()).catch(()=>{});await browser?.close();
 if(child.exitCode===null){child.kill('SIGTERM');await done;}
 await writeFile(path.join(lab,`runtime/${name}.log`),log);
}
