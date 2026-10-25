/** Opt-in isolated hosted proof. Actual browser guest + native SDK owner.
 * Qualifies permission/subscription retirement, NOT OBS frames or AV timing. */
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
const unsigned=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
operator.token=unsigned+'.'+createHmac('sha256',config.JWT_SECRET).update(unsigned).digest('base64url');
await writeFile(directory+'/operator.json',JSON.stringify(operator),{mode:0o600});
const base='https://boomin-rtc-pilot.kleveland-bishop.workers.dev',path='/v1/app/live/rooms/'+operator.roomId;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const report={qualification:'Actual guest page + native host authority polling and owned SDK subscriptions; optional timed decode/OBS copy boundary. No ordinary-room rendering or AV synchronization qualification.',production_changed:false,started_at:new Date().toISOString(),steps:[]};
let run,browser,native,nativeExit,page;
async function request(name,p,body){
 if(process.env.PRODUCER_RTC_COMMAND_PROOF==='1' && ['fixture_revoke','link','admit','stage','mute','unmute','revoke'].includes(name)) {
  const participant_id=p.split('/')[5];
  const command=name==='link'?{operation:'link',rotate:body.rotate}:name==='stage'?{operation:'stage',on_stage:body.on_stage}:
   name==='mute'||name==='unmute'?{operation:'grant',participant_id,grant:body.grant,enabled:body.enabled}:
   {operation:name==='fixture_revoke'?'revoke':name,participant_id};
  const request_id=randomUUID();
  await writeFile(directory+'/native-room-command.pending',JSON.stringify({request_id,command}),{mode:0o600});
  await rename(directory+'/native-room-command.pending',directory+'/native-room-command.json');
  let reply;await until(async()=>{reply=await readFile(directory+'/native-room-reply.json','utf8').then(JSON.parse).catch(()=>null);return reply?.request_id===request_id;},20000);
  report.steps.push({name,status:reply.status,native_owner:true});if(reply.status!==200)throw Error('native_room_control_rejected');return reply.body;
 }
 const r=await fetch(base+p,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${operator.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000),redirect:'error'});
 if(!r.ok)throw new Error(`step:${name}:http:${r.status}`);
 const v=await r.json();report.steps.push({name,status:r.status});return v;
}
async function fresh(){run=(await request('state',path+'/rtc-control')).rtc;return run;}
const command=()=>({request_id:randomUUID(),expected:{run_id:run.run_id,control_revision:run.control_revision,host_lease_epoch:run.host_lease_epoch}});
async function counts(){return JSON.parse(await readFile(directory+'/native-subscription-owner-result.json','utf8'));}
async function until(check,timeout=12000){const end=performance.now()+timeout;while(performance.now()<end){if(await check())return;await wait(150);}throw Error('subscription_qualification_timeout');}
try {
 const prior=await fresh();assert(!prior||prior.state==='ended','Isolated room must be idle');
 await unlink(directory+'/native-subscription-owner-result.json').catch(()=>{});
 await unlink(directory+'/native-room-command.json').catch(()=>{});
 await unlink(directory+'/native-room-reply.json').catch(()=>{});
 const log=await open(directory+'/native-subscription-owner.log','w',0o600);
 native=spawn('/private/tmp/producer-native-sdk-target/debug/examples/subscription_owner',[],{stdio:['ignore',log.fd,log.fd]});
 nativeExit=new Promise(resolve=>native.once('exit',resolve));await log.close();
 await until(async()=>{await fresh();return run?.state==='active' && await counts().then(c=>c.passed===null).catch(()=>false);});
 // Failed earlier proofs can leave admitted fixture rows at the room's normal
 // capacity. Revoke only this driver's generated seats in this disposable,
 // allowlisted staging room; do not increase capacity or alter unrelated seats.
 const old=(await request('fixture_roster',path+'/guests')).guests.filter(g=>
  /^Native subscription [0-9a-f]{8}$/.test(g.display_name??'') && g.state==='admitted');
 report.fixture_seats_retired=0;
 for(const guest of old) {
  await fresh();run=(await request('fixture_revoke',`/v1/app/live/guests/${guest.id}/revoke`,{rtc:command()})).rtc.run;
  report.fixture_seats_retired++;
 }
 const link=await request('link',path+'/guest-link',{enabled:true,rotate:true,auto_admit:false,rtc:command()});run=link.rtc.run;
 const joinUrl=new URL(link.join_url);assert.equal(joinUrl.origin,'http://localhost:5175');
 const {chromium}=await import('/private/tmp/producer-guest-browser-proof/node_modules/playwright-core/index.mjs');
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
 page=await browser.newPage();let errors=0;
 await page.addInitScript(()=>{
  const phases=[];window.__rtcProofPhases=phases;
  window.addEventListener('producer-rtc-pilot-phase',e=>{
   if(!['poll','retire_start','retire_end','connect_start','connect_end','publish_start','publish_end','poll_failed'].includes(e.detail))return;
   phases.push({phase:e.detail,ms:Math.round(performance.now())});if(phases.length>128)phases.shift();
  });
 });
 report.guest_api=[];
 page.on('response',async r=>{
  const u=new URL(r.url());if(u.origin!==base)return;
  if(!u.pathname.includes('/rtc/')) {report.guest_api.push({operation:'guest_entry',status:r.status()});return;}
  const row={operation:u.pathname.split('/rtc/')[1],status:r.status()};
  if(row.operation==='state'&&r.status()===200){const v=await r.json().catch(()=>null);row.sources=v?.expected?.publish_sources;row.generation=v?.expected?.authorization_generation;}
  report.guest_api.push(row);if(report.guest_api.length>40)report.guest_api.shift();
 });page.on('pageerror',()=>errors++);
 const name='Native subscription '+randomUUID().slice(0,8);
 await page.goto(joinUrl.href,{waitUntil:'domcontentloaded'});await page.getByPlaceholder('Your name').fill(name);
 await page.getByRole('button',{name:'Join the show',exact:true}).click();
 await page.getByText("You're in the queue",{exact:true}).waitFor({timeout:20000});
 const guest=(await request('roster',path+'/guests')).guests.find(g=>g.display_name===name);assert(guest);
 await fresh();run=(await request('admit',`/v1/app/live/guests/${guest.id}/admit`,{rtc:command()})).rtc.run;
 await wait(1500);assert.equal((await counts()).camera_attached,0);assert.equal((await counts()).microphone_attached,0);
 await fresh();run=(await request('stage',path+'/stage',{on_stage:[guest.id],rtc:command()})).rtc.run;
 report.checkpoint='initial_subscriptions';
 await until(async()=>{const c=await counts();return c.camera_attached>=1&&c.microphone_attached>=1;});
 report.initial=await counts();
 if(process.env.PRODUCER_RTC_DECODED_PROOF==='1') {
  report.checkpoint='initial_decoded_media';
  await until(async()=>{const m=(await counts()).decoded_media;return m?.video_submitted>0&&m.audio_submitted>0;},20000);
  report.initial=await counts();
 }
 report.checkpoint='mute_camera_recovery';
 await fresh();const muteAt=performance.now();run=(await request('mute',`/v1/app/live/guests/${guest.id}/grants`,{grant:'media.mic',enabled:false,rtc:command()})).rtc.run;
 await until(async()=>{const c=await counts();return c.camera_attached>=2&&c.alive===1;});
 report.muted=await counts();assert.equal(report.muted.microphone_attached,report.initial.microphone_attached);
 report.mute_to_camera_ms=Math.round(performance.now()-muteAt);
 if(process.env.PRODUCER_RTC_DECODED_PROOF==='1') {
  const audio=report.muted.decoded_media.audio_submitted;
  await until(async()=>(await counts()).decoded_media.video_submitted>report.muted.decoded_media.video_submitted,20000);
  report.muted=await counts();assert.equal(report.muted.decoded_media.audio_submitted,audio);
 }
 report.checkpoint='unmute_pair_recovery';
 await fresh();const unmuteAt=performance.now();run=(await request('unmute',`/v1/app/live/guests/${guest.id}/grants`,{grant:'media.mic',enabled:true,rtc:command()})).rtc.run;
 await until(async()=>{const c=await counts();return c.camera_attached>=3&&c.microphone_attached>=2&&c.alive===2;});
 report.restored=await counts();
 report.unmute_to_pair_ms=Math.round(performance.now()-unmuteAt);
 if(process.env.PRODUCER_RTC_DECODED_PROOF==='1') {
  await until(async()=>(await counts()).decoded_media.audio_submitted>report.muted.decoded_media.audio_submitted,20000);
  report.restored=await counts();
 }
 report.checkpoint='removal';
 await fresh();const removedAt=performance.now();run=(await request('revoke',`/v1/app/live/guests/${guest.id}/revoke`,{rtc:command()})).rtc.run;
 await until(async()=>(await counts()).alive===0,5000);
 report.removal_to_zero_owned_tracks_ms=Math.round(performance.now()-removedAt);
 report.removed=await counts();assert.equal(native.exitCode,null);
 if(process.env.PRODUCER_RTC_DECODED_PROOF==='1') {
  await wait(250);const after=await counts();
  assert.equal(after.decoded_media.audio_submitted,report.removed.decoded_media.audio_submitted);
  assert.equal(after.decoded_media.video_submitted,report.removed.decoded_media.video_submitted);
  assert.equal(after.decoded_media.video_observers,0);
 }
 report.browser_phases=await page.evaluate(()=>window.__rtcProofPhases);
 await browser.close();browser=null;
 report.checkpoint='owner_shutdown';
 assert.equal(await nativeExit,0);report.final=await counts();assert.equal(report.final.passed,true);
 assert.equal(report.final.alive,0);assert.equal(report.final.sink_closed,1);assert.equal(errors,0);
 await until(async()=>{const ended=await fresh();return !ended||ended.state==='ended';},15000);
 report.run_ended=true;report.passed=true;
 } catch(e) {report.failure_kind=e instanceof SyntaxError?'partial_report_read':e?.name==='AssertionError'?'assertion':'request_or_timeout';if(page)report.browser_state=await page.evaluate(()=>({phases:window.__rtcProofPhases,heading:document.querySelector('h1')?.textContent,
  streams:[...document.querySelectorAll('video')].map(v=>v.srcObject?.getTracks().map(t=>({kind:t.kind,state:t.readyState,enabled:t.enabled})))})).catch(()=>null);report.passed=false;report.failure=e instanceof Error&&e.message.startsWith('step:')?e.message:'subscription_qualification_failed';process.exitCode=1;}
finally {
 if(browser)await browser.close();
 // Let the native owner reach its deterministic close/end, even after a proof
 // assertion fails. No force kill or rival connection claims its live lease.
 if(native&&native.exitCode===null)await nativeExit;
 report.source_sha256=Object.fromEntries(await Promise.all(['crates/guest-runtime/src/authority.rs','crates/guest-runtime/src/subscriptions.rs','crates/guest-runtime/src/lib.rs','crates/guest-runtime/src/media.rs','crates/guest-runtime/src/timing/queue.rs','crates/guest-runtime/src/timing/sender_clock.rs','crates/guest-runtime/src/timing/presentation.rs','crates/guest-runtime/src/timing/playout_clock.rs','crates/guest-runtime/examples/subscription_owner.rs','crates/guest-runtime/examples/support/obs_scene.rs','crates/guest-runtime/Cargo.lock','src-tauri/src/live/rtc_media.rs','src-tauri/src/live/rtc_ingest.rs','src-tauri/src/live/guest_ingest.c','src-tauri/src/rtc_control.rs','src-tauri/src/rtc_owner.rs','scripts/test-native-guest-subscriptions.mjs'].map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
 report.binary_sha256=createHash('sha256').update(await readFile('/private/tmp/producer-native-sdk-target/debug/examples/subscription_owner')).digest('hex');
 await writeFile(directory+'/native-subscription-proof.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(report));
}
