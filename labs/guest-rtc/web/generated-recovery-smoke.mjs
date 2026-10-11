import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {markerOffsets,videoSequenceHealth} from './generated-marker-evidence.mjs';
const lab=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const key of ['LIVEKIT_LAB_PHYSICAL_CAPTURE','LIVEKIT_LAB_PHYSICAL_CAMERA','LIVEKIT_LAB_GUEST_MONITOR','LIVEKIT_LAB_VOICE_REVIEW','LIVEKIT_LAB_CAMERA_SYNC'])if(process.env[key]==='1')throw new Error('Generated recovery rejects physical capture/playback/recording flags');
const name=process.env.LIVEKIT_LAB_RUN_NAME,seconds=Number(process.env.LIVEKIT_LAB_SECONDS),guests=Number(process.env.LIVEKIT_LAB_GUESTS);
if(!/^generated-recovery-[0-9]+$/.test(name??'')||![1,3].includes(guests)||!Number.isInteger(seconds)||seconds<35||seconds>300)throw new Error('Invalid generated recovery configuration');
let browser,child,done,log='',exited=false;const pages=[],observations=[];
try {
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding']});
 for(let n=1;n<=guests;n++){const page=await browser.newPage();pages.push(page);await page.goto(`http://127.0.0.1:8990/?identity=guest-${n}&recoveryProbe=1`);await page.evaluate(()=>window.startLab());await page.waitForFunction(()=>window.labState.published,undefined,{timeout:10000});}
 child=spawn(path.join(lab,'target/debug/producer-guest-rtc-lab'),['transport',path.join(lab,'runtime/native-token'),path.join(lab,`evidence/${name}.json`),String(seconds)],{cwd:lab});
 done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{exited=true;resolve(code);});});
 child.stdout.on('data',d=>{log+=d;process.stdout.write(d);});child.stderr.on('data',d=>{log+=d;process.stderr.write(d);});
 const began=performance.now();
 while(!exited){await new Promise(resolve=>setTimeout(resolve,1000));observations.push({at_ms:performance.now()-began,guests:await Promise.all(pages.map(page=>page.evaluate(async()=>({at_ms:performance.now(),state:window.labState,epochs:window.recoveryProbe.epochs,markers:{audio:window.recoveryProbe.audio.length,video:window.recoveryProbe.video.length},audio:[...((await window.returnAudioTrack?.getRTCStatsReport())?.values()??[])].filter(s=>s.type==='inbound-rtp'&&s.kind==='audio')}))))});if(performance.now()-began>(seconds+30)*1000)throw new Error('Generated native test exceeded bounded duration');}
 const code=await done,native=JSON.parse(await readFile(path.join(lab,`evidence/${name}.json`)));
 const probes=await Promise.all(pages.map(page=>page.evaluate(()=>window.recoveryProbe.snapshot())));
 const resumes=native.lifecycle.filter(e=>e.event==='reconnected'),injections=native.lifecycle.filter(e=>e.event==='reconnect_injected');
 const resumed=resumes[0],injected=injections[0];
 const reports=probes.map((probe,index)=>({identity:`guest-${index+1}`,probe,whole:markerOffsets(probe),sequence:videoSequenceHealth(probe),post_resume:null,recovery_stages:[]}));
 // Epoch timestamps have browser origins. Use an observed sample after native
 // resume to pick a per-page cutoff instead of comparing clock origins directly.
 const after=resumed?observations.filter(o=>o.at_ms>Number(resumed.at_ms)+4000):[];
 for(let index=0;index<reports.length;index++) {
  const first=after[0]?.guests[index],last=after.at(-1)?.guests[index];
  reports[index].post_resume=markerOffsets(probes[index],first?.at_ms??Infinity);
  reports[index].return_video_growth=first&&last?last.state.returnVideoFrames-first.state.returnVideoFrames:0;
  // Marker counts are monotonic across receiver replacement; RTP counters aren't.
  reports[index].return_audio_marker_growth=first&&last?last.markers.audio-first.markers.audio:0;
  reports[index].return_video_marker_growth=first&&last?last.markers.video-first.markers.video:0;
 }
 for(let stage=0;stage<resumes.length;stage++) {
  const samples=observations.filter(o=>o.at_ms>Number(resumes[stage].at_ms)+4000 && o.at_ms<(injections[stage+1]?Number(injections[stage+1].at_ms)-1000:Infinity));
  for(let index=0;index<reports.length;index++) {
   const first=samples[0]?.guests[index],last=samples.at(-1)?.guests[index];
   reports[index].recovery_stages.push({stage:stage+1,resumed:resumes[stage],markers:markerOffsets(probes[index],first?.at_ms??Infinity,last?.at_ms??Infinity),video_growth:first&&last?last.state.returnVideoFrames-first.state.returnVideoFrames:0,audio_marker_growth:first&&last?last.markers.audio-first.markers.audio:0});
  }
 }
 const expected=Number(process.env.LIVEKIT_LAB_GENERATED_RECONNECT_COUNT??1);
 const replacementVerified=probes.every(probe=>['audio','video'].every(kind=>new Set(probe.epochs.filter(e=>e.kind===kind).map(e=>e.sid)).size===expected+1));
 const expectedMarkerIds=Array.from({length:Math.ceil((seconds-.5)/2)},(_,id)=>id);
 for(const r of reports){r.expected_marker_ids=expectedMarkerIds;r.missing_video_labels=expectedMarkerIds.filter(id=>!r.probe.video.some(marker=>marker.id===id));r.missing_paired_labels=expectedMarkerIds.filter(id=>!r.whole.pairs.some(pair=>pair.id===id));}
 const report={guests,seconds,injections,resumes,replacement_verified:replacementVerified,native_exit_code:code,injected,resumed,observations,reports,hardware_capture_used:false,speaker_playback_used:false,media_recorded:false,g1_complete:false};
 await writeFile(path.join(lab,`evidence/${name}-browser.json`),JSON.stringify(report,null,2)+'\n');
 if(code!==0||injections.length!==expected||resumes.length!==expected||(injected?.mode==='full'&&!replacementVerified)||probes.some(p=>p.errors.length)||reports.some(r=>r.sequence.repeated_labels||r.sequence.regressed_labels||r.recovery_stages.length!==expected||r.recovery_stages.some(stage=>stage.video_growth<20||stage.audio_marker_growth<3||stage.markers.paired_markers<3)))throw new Error('Generated reconnect did not prove fresh audio/video marker recovery; inspect retained evidence');
 console.log(`Generated ${injected.mode} reconnect: ${guests} receivers recovered current numbered audio/video markers`);
} finally {
 if(child?.exitCode===null){child.kill('SIGTERM');await done.catch(()=>{});}await Promise.allSettled(pages.map(page=>page.evaluate(()=>window.stopLab())));await browser?.close();await writeFile(path.join(lab,`runtime/${name}.log`),log);
}
