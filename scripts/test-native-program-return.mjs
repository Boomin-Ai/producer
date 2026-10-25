/** Actual generated OBS program → native SDK → Cloud → existing guest page.
 * Numeric diagnostics only. No physical microphone/camera or production room. */
import assert from 'node:assert/strict';
import {readFile,writeFile,open,unlink,rename} from 'node:fs/promises';
import {createHmac,randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
assert.equal(process.env.PRODUCER_RTC_STAGING_PRIVATE,'/private/tmp/producer-rtc-staging');
const directory=process.env.PRODUCER_RTC_STAGING_PRIVATE;
const config=JSON.parse(await readFile(directory+'/secrets.json','utf8'));
const operator=JSON.parse(await readFile(directory+'/operator.json','utf8'));
assert.equal(new URL(config.DATABASE_URL).hostname,'ep-odd-glade-akm62j6w.c-3.us-west-2.aws.neon.tech');
assert.deepEqual(JSON.parse(config.RTC_PILOT_ROOMS),[operator.roomId]);
const claims=JSON.parse(Buffer.from(operator.token.split('.')[1],'base64url'));
assert.equal(claims.sub,operator.actorId);assert.equal(claims.type,'user');
claims.iat=Math.floor(Date.now()/1000);claims.exp=claims.iat+3600;
const head=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
operator.token=head+'.'+payload+'.'+createHmac('sha256',config.JWT_SECRET).update(head+'.'+payload).digest('base64url');
await writeFile(directory+'/operator.json',JSON.stringify(operator),{mode:0o600});
const base='https://boomin-rtc-pilot.kleveland-bishop.workers.dev',path='/v1/app/live/rooms/'+operator.roomId;
const binary=process.env.PRODUCER_RTC_PROOF_BINARY ?? '/Users/klevelandbishop/Library/Caches/producer-rtc-build/debug/producer';
const report={passed:false,production_changed:false,ordinary_room_ui_exercised:false,qualification:'Generated OBS program through actual native publisher, LiveKit Cloud and the existing guest page; no physical AEC or audiovisual synchronization qualification.',steps:[]};
const observationMs=Number(process.env.PRODUCER_RTC_RETURN_OBSERVE_MS??2000);
assert(Number.isInteger(observationMs)&&observationMs>=2000&&observationMs<=20000);
report.guest_observation_ms=observationMs;
let native,nativeExit,browser,page,watchdog;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,ms=15000){const end=performance.now()+ms;while(performance.now()<end){if(await check())return;await wait(150);}throw Error('native_program_timeout');}
async function get(p){const response=await fetch(base+p,{headers:{Authorization:`Bearer ${operator.token}`},signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok){report.control_read_http_status=response.status;throw Error('native_program_control_read_failed');}return response.json();}
async function counts(){return JSON.parse(await readFile(directory+'/native-program-owner.json','utf8'));}
async function command(name,command){
 const begun=performance.now();const request_id=randomUUID();await writeFile(directory+'/native-room-command.pending',JSON.stringify({request_id,command}),{mode:0o600});await rename(directory+'/native-room-command.pending',directory+'/native-room-command.json');
 let reply;await until(async()=>{reply=await readFile(directory+'/native-room-reply.json','utf8').then(JSON.parse).catch(()=>null);return reply?.request_id===request_id;},20000);
 report.steps.push({name,status:reply.status,elapsed_ms:Math.round(performance.now()-begun)});assert.equal(reply.status,200);return reply.body;
}
try {
 report.checkpoint='idle_guard';const prior=(await get(path+'/rtc-control')).rtc;assert(!prior||prior.state==='ended'||(process.env.PRODUCER_RTC_EXPIRED_RECOVERY_PROOF==='1'&&['active','fencing'].includes(prior.state)&&prior.host_lease_expires_at_ms<=Date.now()));
 if(prior){report.expired_recovery_expected={run_id:prior.run_id,epoch:prior.host_lease_epoch};}
 for(const file of ['native-program-owner.json','native-room-command.json','native-room-reply.json'])await unlink(directory+'/'+file).catch(()=>{});
 const log=await open(directory+'/native-program-owner.log','w',0o600);
 native=spawn(binary,[],{env:{...process.env,PRODUCER_RTC_PROGRAM_PROOF:'1',PRODUCER_ENGINE_PLUGINS:directory+'/obs-fixture-plugins',LIVEKIT_LAB_TIMED_MIXER:'1',LIVEKIT_LAB_RTCP_PROBE:'1',RUST_LOG:'off'},stdio:['ignore',log.fd,log.fd]});
 nativeExit=new Promise(resolve=>native.once('exit',resolve));await log.close();
 watchdog=setTimeout(()=>{report.fixture_watchdog_fired=true;native.kill('SIGTERM');},120000);watchdog.unref();
 report.checkpoint='owner_ready';await until(async()=>{const c=await counts().catch(()=>null);return c?.passed===null&&c.audio_submitted>0&&c.video_submitted>0;},45000);
 const active=(await get(path+'/rtc-control')).rtc;
 if(report.expired_recovery_expected){assert.equal(active.run_id,report.expired_recovery_expected.run_id);assert.equal(active.host_lease_epoch,report.expired_recovery_expected.epoch+1);assert.equal(active.state,'active');report.expired_recovery_verified=true;}
 const old=(await get(path+'/guests')).guests??[];
 for(const guest of old.filter(g=>/^Native (subscription|program) [0-9a-f]{8}$/.test(g.display_name??'')&&g.state==='admitted'))await command('fixture_revoke',{operation:'revoke',participant_id:guest.id});
 const link=await command('link',{operation:'link',rotate:true});const joinUrl=new URL(link.join_url);assert.equal(joinUrl.origin,'http://localhost:5175');
 const {chromium}=await import('/Users/klevelandbishop/Library/Application Support/Producer RTC Pilot/browser/node_modules/playwright-core/index.mjs');
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required','--mute-audio']});
 page=await browser.newPage();let errors=0;page.on('pageerror',()=>errors++);
 const name='Native program '+randomUUID().slice(0,8);
 await page.goto(joinUrl.href,{waitUntil:'domcontentloaded'});await page.getByPlaceholder('Your name').fill(name);await page.getByRole('button',{name:'Join the show',exact:true}).click();await page.getByText("You're in the queue",{exact:true}).waitFor({timeout:20000});
 let guest;await until(async()=>{guest=((await get(path+'/guests')).guests??[]).find(g=>g.display_name===name);return !!guest;});
 await command('admit',{operation:'admit',participant_id:guest.id});await command('stage',{operation:'stage',on_stage:[guest.id]});
 report.checkpoint='browser_return';await until(()=>page.evaluate(()=>{
  const audio=document.getElementById('host-audio');const video=document.querySelector('.guest-room-stage > video');
  return !!audio?.srcObject?.getAudioTracks().length&&!!video&&video.videoWidth>0;
 }),20000);
 report.return_media=await page.evaluate(async(observationMs)=>{
  const audio=document.getElementById('host-audio');let video=document.querySelector('.guest-room-stage > video');
  const context=new AudioContext();await context.resume();let stream=audio.srcObject;let source=context.createMediaStreamSource(stream);const analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);
  const samples=new Float32Array(analyser.fftSize);let maximumRms=0,frames=0,streamChanges=0,maximumFrameGap=0,lastFrame=performance.now(),silentWindows=0,maximumSilentWindows=0;
  // HTML playback counters reset when a fenced generation replaces srcObject.
  // Count rendered callbacks instead of subtracting two resettable counters.
  let callback;const rendered=()=>{const now=performance.now();maximumFrameGap=Math.max(maximumFrameGap,now-lastFrame);lastFrame=now;frames++;callback=video.requestVideoFrameCallback(rendered);};callback=video.requestVideoFrameCallback(rendered);
  const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;const draw=canvas.getContext('2d');
  for(let i=0;i<Math.ceil(observationMs/50);i++){
   await new Promise(r=>setTimeout(r,50));
   const current=document.querySelector('.guest-room-stage > video');if(current&&current!==video){video.cancelVideoFrameCallback(callback);video=current;callback=video.requestVideoFrameCallback(rendered);}
   if(audio.srcObject&&audio.srcObject!==stream){source.disconnect();stream=audio.srcObject;source=context.createMediaStreamSource(stream);source.connect(analyser);streamChanges++;}
   analyser.getFloatTimeDomainData(samples);const rms=Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length);maximumRms=Math.max(maximumRms,rms);silentWindows=rms<0.01?silentWindows+1:0;maximumSilentWindows=Math.max(maximumSilentWindows,silentWindows);
  }
  video.cancelVideoFrameCallback(callback);draw.drawImage(video,0,0,8,8);const pixel=[...draw.getImageData(4,4,1,1).data].slice(0,3);source.disconnect();await context.close();
  return {width:video.videoWidth,height:video.videoHeight,decoded_frames:frames,stream_changes:streamChanges,maximum_rms:maximumRms,center_rgb:pixel,maximum_frame_gap_ms:Math.round(maximumFrameGap),maximum_silent_window_ms:maximumSilentWindows*50};
 },observationMs);
 assert(report.return_media.decoded_frames>=10);assert(report.return_media.maximum_rms>0.01);assert(report.return_media.center_rgb[0]>150&&report.return_media.center_rgb[1]<80&&report.return_media.center_rgb[2]<80);
 if(process.env.PRODUCER_RTC_PROGRAM_DELAY_PROOF!=='1'){assert(report.return_media.maximum_frame_gap_ms<1000);assert(report.return_media.maximum_silent_window_ms<1000);}
 await command('revoke',{operation:'revoke',participant_id:guest.id});await browser.close();browser=null;
 report.checkpoint='owner_shutdown';assert.equal(await nativeExit,0);report.final=await counts();assert.equal(report.final.passed,true);assert.equal(errors,0);
 if(process.env.PRODUCER_RTC_PROGRAM_DELAY_PROOF==='1')assert(report.final.timing.publisher_recoveries>=1);
 await until(async()=>{const run=(await get(path+'/rtc-control')).rtc;return !run||run.state==='ended';});report.run_ended=true;report.passed=true;
}catch{report.failure='native_program_return_not_qualified';process.exitCode=1;}
finally{
 if(browser)await browser.close();if(native&&native.exitCode===null)await nativeExit;
 clearTimeout(watchdog);
 report.owner=await counts().catch(()=>null);
 report.source_sha256=Object.fromEntries(await Promise.all(['crates/guest-runtime/src/lib.rs','crates/guest-runtime/src/program.rs','crates/guest-session/src/lib.rs','src-tauri/src/rtc_owner.rs','src-tauri/src/rtc_control.rs','src-tauri/src/live/rtc_program.rs','scripts/test-native-program-return.mjs'].map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
 report.binary_sha256=createHash('sha256').update(await readFile(binary)).digest('hex');
 await writeFile(directory+'/native-program-proof.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
}
