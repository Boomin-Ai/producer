/** Opt-in isolated hosted proof. Actual browser guest + native SDK owner.
 * Qualifies permission/subscription retirement, NOT OBS frames or AV timing. */
import assert from 'node:assert/strict';
import {readFile,writeFile,open,unlink} from 'node:fs/promises';
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
const report={qualification:'Actual guest page + native host authority polling and owned SDK subscriptions. No OBS rendering or AV synchronization qualification.',production_changed:false,started_at:new Date().toISOString(),steps:[]};
let run,browser,native,nativeExit,page;
async function request(name,p,body){
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
 const log=await open(directory+'/native-subscription-owner.log','w',0o600);
 native=spawn('/private/tmp/producer-native-sdk-target/debug/examples/subscription_owner',[],{stdio:['ignore',log.fd,log.fd]});
 nativeExit=new Promise(resolve=>native.once('exit',resolve));await log.close();
 await until(async()=>{await fresh();return run?.state==='active' && await counts().then(c=>c.passed===null).catch(()=>false);});
 const link=await request('link',path+'/guest-link',{enabled:true,rotate:true,auto_admit:false,rtc:command()});run=link.rtc.run;
 const joinUrl=new URL(link.join_url);assert.equal(joinUrl.origin,'http://localhost:5175');
 const {chromium}=await import('/private/tmp/producer-guest-browser-proof/node_modules/playwright-core/index.mjs');
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
 page=await browser.newPage();let errors=0;
 report.guest_api=[];
 page.on('response',async r=>{
  const u=new URL(r.url());if(u.origin!==base||!u.pathname.includes('/rtc/'))return;
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
 await until(async()=>{const c=await counts();return c.camera_attached>=1&&c.microphone_attached>=1;});
 report.initial=await counts();
 await fresh();run=(await request('mute',`/v1/app/live/guests/${guest.id}/grants`,{grant:'media.mic',enabled:false,rtc:command()})).rtc.run;
 await until(async()=>{const c=await counts();return c.camera_attached>=2&&c.alive===1;});
 report.muted=await counts();assert.equal(report.muted.microphone_attached,report.initial.microphone_attached);
 await fresh();run=(await request('unmute',`/v1/app/live/guests/${guest.id}/grants`,{grant:'media.mic',enabled:true,rtc:command()})).rtc.run;
 await until(async()=>{const c=await counts();return c.camera_attached>=3&&c.microphone_attached>=2&&c.alive===2;});
 report.restored=await counts();
 await fresh();const removedAt=performance.now();run=(await request('revoke',`/v1/app/live/guests/${guest.id}/revoke`,{rtc:command()})).rtc.run;
 await until(async()=>(await counts()).alive===0,5000);
 report.removal_to_zero_owned_tracks_ms=Math.round(performance.now()-removedAt);
 report.removed=await counts();assert.equal(native.exitCode,null);
 await browser.close();browser=null;
 assert.equal(await nativeExit,0);report.final=await counts();assert.equal(report.final.passed,true);
 assert.equal(report.final.alive,0);assert.equal(report.final.sink_closed,1);assert.equal(errors,0);
 await until(async()=>{const ended=await fresh();return !ended||ended.state==='ended';},15000);
 report.run_ended=true;report.passed=true;
 } catch(e) {if(page)report.browser_state=await page.evaluate(()=>({heading:document.querySelector('h1')?.textContent,
  streams:[...document.querySelectorAll('video')].map(v=>v.srcObject?.getTracks().map(t=>({kind:t.kind,state:t.readyState,enabled:t.enabled})))})).catch(()=>null);report.passed=false;report.failure=e instanceof Error&&e.message.startsWith('step:')?e.message:'subscription_qualification_failed';process.exitCode=1;}
finally {
 if(browser)await browser.close();
 // Let the native owner reach its deterministic close/end, even after a proof
 // assertion fails. No force kill or rival connection claims its live lease.
 if(native&&native.exitCode===null)await nativeExit;
 report.source_sha256=Object.fromEntries(await Promise.all(['crates/guest-runtime/src/authority.rs','crates/guest-runtime/src/subscriptions.rs','crates/guest-runtime/src/lib.rs','crates/guest-runtime/examples/subscription_owner.rs','src-tauri/src/rtc_control.rs','src-tauri/src/rtc_owner.rs','scripts/test-native-guest-subscriptions.mjs'].map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')])));
 await writeFile(directory+'/native-subscription-proof.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(report));
}
