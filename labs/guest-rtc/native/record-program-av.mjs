// Record the native generated AV fixture through a real browser guest.
// Refuse to record unless the standalone native fixture report is live.
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

const root = process.env.HOME + '/Library/Application Support/Producer RTC Pilot';
const operator = JSON.parse(await fs.readFile(process.env.PRODUCER_RTC_OBSERVER_PROFILE || root + '/operator.json', 'utf8'));
const base = process.env.PRODUCER_RTC_OBSERVER_API || 'https://boomin-rtc-pilot.kleveland-bishop.workers.dev';
if(!['https://api.boomin.ai','https://boomin-rtc-pilot.kleveland-bishop.workers.dev'].includes(base))throw Error('Unapproved observation endpoint');
const room = '/v1/app/live/rooms/' + operator.roomId;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
let observerId=null;
const recoveryProof=process.env.PRODUCER_RTC_RETURN_RECOVERY_PROOF==='1';
let phase="waiting_host";

async function request(path, body) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: {Authorization: 'Bearer ' + operator.token, 'Content-Type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw Error('Authority request rejected: '+response.status);
  return response.json();
}

async function fixtureLive() {
  try {
    const path = root + '/native-program-owner.json';
    const report = JSON.parse(await fs.readFile(path, 'utf8'));
    const stat = await fs.stat(path);
    return report.generated_av_fixture === true && report.passed === null
      && report.audio_submitted >= 300 && Date.now() - stat.mtimeMs < 2000;
  } catch { return false; }
}

try {
  let control;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (await fixtureLive()) {
      control = (await request(room + '/rtc-control')).rtc;
      if (control?.state === 'active' && control.host_lease_expires_at_ms > Date.now()) break;
    }
    await wait(500);
  }
  if (!control || !(await fixtureLive())) throw Error('Generated native fixture is not live');
  phase='guest_link';
  let link;
  if(base==='https://api.boomin.ai'){
    const journal=root+'/production-smoke-guest.json';
    const prior=await fs.readFile(journal,'utf8').then(JSON.parse).catch(()=>null);
    if(prior?.roomId===operator.roomId){
      control=(await request(room+'/rtc-control')).rtc;
      await request('/v1/app/live/guests/'+prior.id+'/revoke',{rtc:{request_id:randomUUID(),expected:{run_id:control.run_id,control_revision:control.control_revision,host_lease_epoch:control.host_lease_epoch}}});
      await fs.unlink(journal);
    }
    link=await fs.readFile(root+'/production-livekit-shared-link.json','utf8').then(JSON.parse).catch(()=>null);
    if(link?.rtc?.run?.room_id!==operator.roomId)link=null;
    if(!link?.join_url){
      control=(await request(room+'/rtc-control')).rtc;
      link=await request(room+'/guest-link',{enabled:true,auto_admit:false,rotate:true,rtc:{request_id:randomUUID(),expected:{run_id:control.run_id,control_revision:control.control_revision,host_lease_epoch:control.host_lease_epoch}}});
      if(typeof link.join_url!=='string')throw Error('No readable generated room link');
      await fs.writeFile(root+'/production-livekit-shared-link.json',JSON.stringify(link),{mode:0o600});
    }
   }else {
    control=(await request(room+'/rtc-control')).rtc;
    link=await request(room+'/guest-link',{enabled:true,auto_admit:false,rotate:true,rtc:{request_id:randomUUID(),expected:{run_id:control.run_id,control_revision:control.control_revision,host_lease_epoch:control.host_lease_epoch}}});
  }
  const target = new URL(link.join_url);
  const local = base==='https://api.boomin.ai' ? target.toString() : 'http://localhost:5175' + target.pathname + target.search;
  const {chromium} = await import(root + '/browser/node_modules/playwright-core/index.mjs');
  browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  const name = 'Multi call 5 ' + randomUUID().slice(0, 8);
  phase='page';
  await page.goto(local, {waitUntil: 'domcontentloaded'});
  phase='join';
  await page.getByPlaceholder('Your name').fill(name);
  await page.getByRole('button', {name: 'Join the show', exact: true}).click();
  await page.getByText("You're in the queue", {exact: true}).waitFor({timeout: 20000});
  const guest = (await request(room + '/guests')).guests.find(g => g.display_name === name);
  if (!guest) throw Error('Generated observer unavailable');
  observerId=guest.id;
  if(base==='https://api.boomin.ai')await fs.writeFile(root+'/production-smoke-guest.json',JSON.stringify({id:guest.id,roomId:operator.roomId}),{mode:0o600});
  control = (await request(room + '/rtc-control')).rtc;
  phase='admit';
  await request('/v1/app/live/guests/' + guest.id + '/admit', {rtc: {
    request_id: randomUUID(), expected: {run_id: control.run_id,
      control_revision: control.control_revision, host_lease_epoch: control.host_lease_epoch},
  }});
  phase='return';
  await page.waitForFunction(() => {
    const video = document.querySelector('.guest-room-stage > video');
    const audio = document.getElementById('host-audio');
    return video?.videoWidth > 0 && audio?.srcObject?.getAudioTracks().length;
  }, undefined, {timeout: 20000});
  if (!(await fixtureLive())) throw Error('Generated source authorization expired');
  if(recoveryProof){
    phase='recovery_observation';
    const baseline=JSON.parse(await fs.readFile(root+'/native-program-owner.json','utf8'));
    if(baseline.transport_recoveries!==0)throw Error('Recovery began before observer');
    await fs.writeFile(root+'/return-recovery-ready','ready',{mode:0o600});
    const samples=await page.evaluate(async()=>{
      const samples=[];const start=performance.now();
      while(performance.now()-start<45000){
        const v=document.querySelector('.guest-room-stage > video'),a=document.getElementById('host-audio');
        samples.push({at_ms:Math.round(performance.now()-start),video_time:v?.currentTime??0,width:v?.videoWidth??0,
          video_id:v?.srcObject?.getVideoTracks()[0]?.id??null,audio_id:a?.srcObject?.getAudioTracks()[0]?.id??null,
          audio_live:a?.srcObject?.getAudioTracks()[0]?.readyState==='live'});
        await new Promise(r=>setTimeout(r,250));
      }return samples;
    });
    const native=JSON.parse(await fs.readFile(root+'/native-program-owner.json','utf8'));
    const windows=[samples.filter(s=>s.at_ms<8000),samples.filter(s=>s.at_ms>=17000&&s.at_ms<20000),samples.filter(s=>s.at_ms>=30000)];
    const advancing=windows.map(window=>window.filter(s=>s.audio_live&&s.width===1280).length>=10 && window.some((s,i)=>i>0&&s.video_id===window[i-1].video_id&&s.video_time>window[i-1].video_time));
    const report={passed:advancing.every(Boolean)&&native.transport_recoveries===2,advancing_windows:advancing,native_recoveries:native.transport_recoveries,
      initial_recoveries:baseline.transport_recoveries,video_tracks:new Set(samples.map(s=>s.video_id).filter(Boolean)).size,audio_tracks:new Set(samples.map(s=>s.audio_id).filter(Boolean)).size,samples,
      qualification:'Actual browser host-return tracks across two forced native SDK closes; generated AV, muted playback; staging only'};
    await fs.writeFile(root+'/native-return-recovery.json',JSON.stringify(report,null,2),{mode:0o600});
    control=(await request(room+'/rtc-control')).rtc;
    await request('/v1/app/live/guests/'+guest.id+'/revoke',{rtc:{request_id:randomUUID(),expected:{run_id:control.run_id,control_revision:control.control_revision,host_lease_epoch:control.host_lease_epoch}}});
    console.log(JSON.stringify({passed:report.passed,advancing_windows:advancing,native_recoveries:native.transport_recoveries,video_tracks:report.video_tracks,audio_tracks:report.audio_tracks}));
    if(!report.passed)process.exitCode=1;
  }else {
  phase='record';
  const result = await page.evaluate(async () => {
    const video = document.querySelector('.guest-room-stage > video');
    const audio = document.getElementById('host-audio');
    const mime = 'video/mp4;codecs=avc1.42001E,mp4a.40.2';
    if (!MediaRecorder.isTypeSupported(mime)) throw Error('MP4 recorder unavailable');
    const stream = new MediaStream([...video.srcObject.getVideoTracks(), ...audio.srcObject.getAudioTracks()]);
    const recorder = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 2000000, audioBitsPerSecond: 128000});
    const chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const finished = new Promise((resolve, reject) => {
      recorder.onstop = resolve; recorder.onerror = () => reject(Error('Recorder failed'));
    });
    recorder.start(500);
    await new Promise(resolve => setTimeout(resolve, 30000));
    recorder.stop(); await finished;
    const data = new Uint8Array(await new Blob(chunks, {type: mime}).arrayBuffer());
    return {bytes: Array.from(data), width: video.videoWidth, height: video.videoHeight, mime};
  });
  if (!(await fixtureLive())) throw Error('Generated source ended during recording');
  let stageAndRemoval=false;
  if(base==='https://api.boomin.ai'){
    const receipt=async()=>{
      const rtc=(await request(room+'/rtc-control')).rtc;
      return {request_id:randomUUID(),expected:{run_id:rtc.run_id,control_revision:rtc.control_revision,host_lease_epoch:rtc.host_lease_epoch}};
    };
    phase='stage';
    await request(room+'/stage',{on_stage:[guest.id],rtc:await receipt()});
    phase='revoke';
    await request('/v1/app/live/guests/'+guest.id+'/revoke',{rtc:await receipt()});
    const roster=(await request(room+'/guests')).guests;
    stageAndRemoval=!roster.some(g=>g.id===guest.id);
    if(!stageAndRemoval)throw Error('Generated observer cleanup failed');
    await fs.unlink(root+'/production-smoke-guest.json');
  }
  await fs.writeFile(root + '/native-program-av-return.mp4', Buffer.from(result.bytes), {mode: 0o600});
  await fs.writeFile(root + '/native-program-av-observer.json', JSON.stringify({
    saved: true, bytes: result.bytes.length, width: result.width, height: result.height,
    mime: result.mime, duration_seconds: 30, source: 'standalone native generated numbered AV',
    observer_synthetic_camera_microphone: true, playback_muted: true,
    production_stage_and_removal_verified:stageAndRemoval,
  }), {mode: 0o600});
  console.log(JSON.stringify({saved: true, bytes: result.bytes.length, width: result.width, height: result.height}));
  }
} catch(error) {
  await fs.writeFile(root+'/native-program-observer-error.json',JSON.stringify({phase,message:String(error),stack:error?.stack}),{mode:0o600});
  console.log(JSON.stringify({saved: false, phase, reason: 'Generated AV setup or capture failed; recording not accepted'}));
  process.exitCode = 1;
} finally {
  await browser?.close();
  if(recoveryProof && observerId){
    try{
      const roster=(await request(room+'/guests')).guests;
      if(roster.some(g=>g.id===observerId)){
        const rtc=(await request(room+'/rtc-control')).rtc;
        if(rtc?.state==='active')await request('/v1/app/live/guests/'+observerId+'/revoke',{rtc:{request_id:randomUUID(),expected:{run_id:rtc.run_id,control_revision:rtc.control_revision,host_lease_epoch:rtc.host_lease_epoch}}});
      }
    }catch{console.log(JSON.stringify({observer_cleanup_unconfirmed:true}));}
  }
}
