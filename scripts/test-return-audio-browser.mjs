/** Actual React hook + GreenRoomBar and real DOM/MediaStream lifecycle.
 * Only the media-element playback surface and seat resume/transport are
 * simulated. No network, native bridge, audio samples, speakers or devices. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const seatMock=`export class GuestSeat {}`;
const bundle=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {useReturnAudio} from './src/features/network/useReturnAudio';
 import {GreenRoomBar} from './src/views/GuestSeat';
 const root=createRoot(document.getElementById('root'));
 function Harness({seat,stream}){const audio=useReturnAudio({seat,stream});window.hook=audio;return <><audio ref={audio.audioRef} autoPlay/><output data-testid="status">{audio.status}</output><p data-testid="message">{audio.message}</p><button onClick={()=>{window.calls.push({kind:'click'});void audio.enableAudio();window.calls.push({kind:'click-returned'});}}>Enable test audio</button></>;}
 window.renderHook=(seat,stream)=>root.render(<Harness seat={seat} stream={stream}/>);
 window.renderBar=(seat)=>root.render(<GreenRoomBar seat={seat} spec={{title:'Synthetic room',hostName:'Synthetic host',videoSource:'program',nativeProgram:window.nativeProgram}} onLeave={()=>{}}/>);
 window.unmountHook=()=>root.unmount();
 `,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',define:{'import.meta.env':'{}'},
 plugins:[{name:'return-audio-fixtures',setup(b){b.onResolve({filter:/\.css$/},()=>({path:'css',namespace:'mock'}));b.onResolve({filter:/\/lib\/guestSeat$/},()=>({path:'seat',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='css'?'':seatMock,loader:'js'}));}}],
});
const module=process.env.PRODUCER_PLAYWRIGHT_MODULE;
const {chromium}=await import(module?(module.startsWith('file:')?module:pathToFileURL(resolve(module)).href):new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
const results=[];
async function fixture({play='blocked',resume='resolve',stream=true,bar=false,clock=false,native=false}={}){
 const page=await browser.newPage();page.setDefaultTimeout(5000);const errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{requests.push(route.request().url());return route.request().url()==='https://producer-fixture.invalid/'?route.fulfill({contentType:'text/html',body:'<main id="root"></main>'}):route.abort();});
 await page.goto('https://producer-fixture.invalid/');
 if(clock)await page.clock.install();
 await page.evaluate(options=>{
  window.calls=[];window.nativeProgram=options.native;window.playMode=options.play;window.resumeMode=options.resume;window.pendingPlays=[];window.pendingResumes=[];window.elements=new WeakMap();window.allStreams=[];window.forbidden=[];
  window.fetch=()=>{window.forbidden.push('fetch');return Promise.reject(Error('network forbidden'));};window.WebSocket=class{constructor(){window.forbidden.push('socket');throw Error('socket forbidden');}};
  for(const method of ['getUserMedia','getDisplayMedia','enumerateDevices'])navigator.mediaDevices[method]=()=>{window.forbidden.push(method);return Promise.reject(Error('devices forbidden'));};
  const metadata=element=>{let value=window.elements.get(element);if(!value){value={stream:null,paused:true,readyState:0,ended:false,error:null};window.elements.set(element,value);}return value;};
  // A real element receives every attachment/listener; only browser playback
  // state is simulated because policy failures cannot depend on test-machine
  // autoplay preferences. No stream is handed to a native speaker renderer.
  for(const key of ['paused','readyState','ended','error'])Object.defineProperty(HTMLMediaElement.prototype,key,{configurable:true,get(){return metadata(this)[key];}});
  Object.defineProperty(HTMLMediaElement.prototype,'srcObject',{configurable:true,get(){return metadata(this).stream;},set(value){Object.assign(metadata(this),{stream:value,paused:true,readyState:0,ended:false,error:null});window.calls.push({kind:'attach',audio:this.tagName==='AUDIO'});}});
  window.audioEvent=(kind,patch={},element=document.querySelector('audio'))=>{Object.assign(metadata(element),patch);element.dispatchEvent(new Event(kind));};
  HTMLMediaElement.prototype.pause=function(){window.calls.push({kind:'pause-called'});metadata(this).paused=true;this.dispatchEvent(new Event('pause'));};
  HTMLMediaElement.prototype.play=function(){
   const element=this;window.calls.push({kind:'play',active:navigator.userActivation.isActive,audio:this.tagName==='AUDIO'});
   if(window.playMode==='throw')throw Error('PRIVATE_PLAY_THROW');
   if(window.playMode==='blocked')return Promise.reject(new DOMException('PRIVATE_AUTOPLAY','NotAllowedError'));
   if(window.playMode==='error')return Promise.reject(new DOMException('PRIVATE_MEDIA','NotSupportedError'));
   if(window.playMode==='pending')return new Promise((resolve,reject)=>window.pendingPlays.push({resolve,reject,element}));
   if(window.playMode==='no-event')return Promise.resolve();
   Object.assign(metadata(element),{paused:false,readyState:2,ended:false,error:null});queueMicrotask(()=>element.dispatchEvent(new Event('playing')));return Promise.resolve();
  };
  window.makeStream=()=>{const track=new MediaStreamTrackGenerator({kind:'audio'}),stream=new MediaStream([track]);window.allStreams.push(stream);return stream;};
  window.makeSeat=()=>{
   let state={phase:'live',mediaMode:'program',transport:'livekit',hasProgram:false,cameraOff:false,muted:false,nativeProgram:options.native,nativePlayback:false,nativeAudioAvailable:false,programPreview:null};const listeners=new Set();
   return {patch(patch){state={...state,...patch};for(const listener of listeners)listener();},resumeAudio(){window.calls.push({kind:'resume',active:navigator.userActivation.isActive});queueMicrotask(()=>window.calls.push({kind:'resume-microtask'}));
    if(window.resumeMode==='throw')throw Error('PRIVATE_RESUME_THROW');if(window.resumeMode==='error')return Promise.reject(Error('PRIVATE_RESUME_REJECT'));if(window.resumeMode==='blocked')return Promise.reject(new DOMException('PRIVATE_CONTEXT','NotAllowedError'));
    if(window.resumeMode==='pending')return new Promise((resolve,reject)=>window.pendingResumes.push({resolve,reject}));return Promise.resolve();},
    snapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},localStream:()=>null,programStream:()=>null,hostAudioStream:()=>options.native?null:window.currentStream,toggleMute(){},toggleCamera(){}};
  };
  window.currentStream=options.stream?window.makeStream():null;window.currentSeat=window.makeSeat();
 },{play,resume,stream,native});
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.evaluate(bar=>bar?window.renderBar(window.currentSeat):window.renderHook(window.currentSeat,window.currentStream),bar);
 if(!bar)await page.getByTestId('status').waitFor();else await page.locator('.rm-seat').waitFor();
 return {page,errors,requests,async close(){assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.forbidden),[]);assert.deepEqual(requests,['https://producer-fixture.invalid/']);await page.close();}};
}
async function status(page,value){await page.getByTestId('status').filter({hasText:new RegExp('^'+value+'$')}).waitFor();}
async function run(name,test){await test();results.push(name);}
try{
 await run('autoplay denial surfaces blocked; trusted click starts both resume/play synchronously then recovers',async()=>{
  const h=await fixture();await status(h.page,'blocked');assert.match(await h.page.getByTestId('message').innerText(),/blocked/);
  await h.page.evaluate(()=>{window.calls=[];window.playMode='resolve';});await h.page.getByRole('button',{name:'Enable test audio'}).click();await status(h.page,'playing');
  const calls=await h.page.evaluate(()=>window.calls);assert.deepEqual(calls.slice(0,4).map(c=>c.kind),['click','resume','play','click-returned']);assert(calls[1].active&&calls[2].active);assert.equal(await h.page.locator('audio').count(),1);assert.doesNotMatch(await h.page.getByTestId('message').innerText(),/audible|hear|speaker/i);await h.close();
 });
 await run('missing host stream stays waiting even after explicit enable; errors are not invented',async()=>{
  const h=await fixture({stream:false,play:'error'});await status(h.page,'waiting');assert.equal(await h.page.evaluate(()=>window.calls.some(c=>c.kind==='play')),false);
  await h.page.getByRole('button',{name:'Enable test audio'}).click();await status(h.page,'waiting');assert.equal(await h.page.evaluate(()=>window.calls.filter(c=>c.kind==='resume').length),1);await h.close();
 });
 for(const [play,resume]of[['error','resolve'],['throw','resolve'],['resolve','error'],['resolve','throw']])await run('actual play/resume failure remains visible and sanitized: '+play+'/'+resume,async()=>{
  const h=await fixture({play:'blocked'});await status(h.page,'blocked');await h.page.evaluate(({play,resume})=>{window.calls=[];window.playMode=play;window.resumeMode=resume;},{play,resume});
  await h.page.getByRole('button',{name:'Enable test audio'}).click();await status(h.page,'error');assert.deepEqual(await h.page.evaluate(()=>window.calls.slice(0,4).map(c=>c.kind)),['click','resume','play','click-returned']);assert.doesNotMatch(await h.page.locator('body').innerText(),/PRIVATE/);await h.close();
 });
 await run('successful promises without real element playback time out instead of claiming playing',async()=>{
  const h=await fixture({play:'no-event',clock:true});await status(h.page,'starting');await h.page.clock.fastForward(5100);await status(h.page,'error');await h.close();
 });
 await run('hung seat resume is bounded despite element playing; late completion cannot clear the error',async()=>{
  const h=await fixture({clock:true});await status(h.page,'blocked');await h.page.evaluate(()=>{window.playMode='resolve';window.resumeMode='pending';});
  await h.page.getByRole('button',{name:'Enable test audio'}).click();await status(h.page,'starting');await h.page.clock.fastForward(5100);await status(h.page,'error');
  await h.page.evaluate(()=>window.pendingResumes[0].resolve());await h.page.waitForTimeout(20);await status(h.page,'error');await h.close();
 });
 await run('old play rejection after stream replacement cannot override current playback or replace the element',async()=>{
  const h=await fixture({play:'pending'});await status(h.page,'starting');await h.page.evaluate(()=>{window.firstAudio=document.querySelector('audio');window.oldStream=window.currentStream;window.playMode='resolve';window.currentStream=window.makeStream();window.renderHook(window.currentSeat,window.currentStream);});await status(h.page,'playing');
  await h.page.evaluate(()=>window.pendingPlays[0].reject(new DOMException('PRIVATE_OLD','NotAllowedError')));await h.page.waitForTimeout(20);await status(h.page,'playing');
  assert(await h.page.evaluate(()=>document.querySelector('audio')===window.firstAudio&&window.firstAudio.srcObject===window.currentStream&&window.oldStream.getAudioTracks()[0].readyState==='live'));assert.equal(await h.page.evaluate(()=>window.calls.filter(c=>c.kind==='pause-called').length),0);await h.close();
 });
 await run('old seat resume completion and stale queued events cannot override the replacement binding',async()=>{
  const h=await fixture();await status(h.page,'blocked');await h.page.evaluate(()=>{window.playMode='resolve';window.resumeMode='pending';});await h.page.getByRole('button',{name:'Enable test audio'}).click();await status(h.page,'starting');
  await h.page.evaluate(()=>{window.currentSeat=window.makeSeat();window.resumeMode='resolve';window.renderHook(window.currentSeat,window.currentStream);});await status(h.page,'playing');
  await h.page.evaluate(()=>{window.pendingResumes[0].reject(Error('PRIVATE_OLD_SEAT'));window.audioEvent('pause');window.audioEvent('error');window.audioEvent('ended');});await h.page.waitForTimeout(20);await status(h.page,'playing');await h.close();
 });
 await run('playing, pause, error and ended follow actual current element state',async()=>{
  const h=await fixture({play:'resolve'});await status(h.page,'playing');await h.page.evaluate(()=>window.audioEvent('pause',{paused:true}));await status(h.page,'paused');
  await h.page.getByRole('button',{name:'Enable test audio'}).click();await status(h.page,'playing');await h.page.evaluate(()=>window.audioEvent('error',{error:{code:3}}));await status(h.page,'error');
  await h.page.getByRole('button',{name:'Enable test audio'}).click();await status(h.page,'playing');await h.page.evaluate(()=>window.audioEvent('ended',{ended:true,paused:true}));await status(h.page,'paused');await h.close();
 });
 await run('last host track removal returns waiting without stopping tracks or changing element mute/volume',async()=>{
  const h=await fixture({play:'resolve'});await status(h.page,'playing');const before=await h.page.locator('audio').evaluate(a=>({muted:a.muted,volume:a.volume}));
  await h.page.evaluate(()=>{window.savedTrack=window.currentStream.getAudioTracks()[0];window.currentStream.removeTrack(window.savedTrack);window.currentStream.dispatchEvent(new Event('removetrack'));});await status(h.page,'waiting');
  assert(await h.page.evaluate(()=>window.savedTrack.readyState==='live'));assert.deepEqual(await h.page.locator('audio').evaluate(a=>({muted:a.muted,volume:a.volume})),before);await h.close();
 });
 await run('unmount cancels pending work, detaches only the old element and retains live source tracks',async()=>{
  const h=await fixture({play:'pending'});await status(h.page,'starting');await h.page.evaluate(()=>{window.oldAudio=document.querySelector('audio');window.unmountHook();window.pendingPlays[0].reject(Error('PRIVATE_LATE'));window.oldAudio.dispatchEvent(new Event('playing'));});await h.page.waitForTimeout(20);
  assert(await h.page.evaluate(()=>window.oldAudio.srcObject===null&&window.allStreams.every(s=>s.getAudioTracks().every(t=>t.readyState==='live'))));assert.equal(await h.page.locator('audio').count(),0);assert.equal(await h.page.evaluate(()=>window.calls.filter(c=>c.kind==='pause-called').length),0);await h.close();
 });
 await run('actual GreenRoomBar integration reflects blocked→Listening with one stable audio owner',async()=>{
  const h=await fixture({bar:true});await h.page.getByRole('status').filter({hasText:/blocked/}).waitFor();await h.page.evaluate(()=>{window.firstAudio=document.querySelector('audio');window.calls=[];window.playMode='resolve';});
  const retry=h.page.getByRole('button',{name:/^(Enable audio|Retry audio)$/});await retry.click();await h.page.getByRole('button',{name:'Listening',exact:true}).waitFor();assert(await h.page.getByRole('button',{name:'Listening',exact:true}).isDisabled());
  assert.equal(await h.page.locator('audio').count(),1);assert(await h.page.evaluate(()=>window.firstAudio===document.querySelector('audio')));assert.equal(await h.page.evaluate(()=>window.calls.filter(c=>c.kind==='play').length),1);assert.equal(await h.page.evaluate(()=>window.calls.filter(c=>c.kind==='resume').length),1);await h.close();
 });
 await run('actual GreenRoomBar keeps a trusted-click escape from hung autoplay and ignores its late rejection',async()=>{
  const h=await fixture({bar:true,play:'pending'});const enabling=h.page.getByRole('button',{name:'Enabling audio…',exact:true});await enabling.waitFor();assert(await enabling.isEnabled());
  await h.page.evaluate(()=>{window.firstAudio=document.querySelector('audio');window.playMode='resolve';});await enabling.click();
  await h.page.getByRole('button',{name:'Listening',exact:true}).waitFor();
  await h.page.evaluate(()=>window.pendingPlays[0].reject(new DOMException('PRIVATE_OLD_AUTOPLAY','NotAllowedError')));await h.page.waitForTimeout(20);
  assert(await h.page.getByRole('button',{name:'Listening',exact:true}).isDisabled());assert.equal(await h.page.locator('audio').count(),1);
  assert(await h.page.evaluate(()=>window.firstAudio===document.querySelector('audio')));assert.equal(await h.page.evaluate(()=>window.calls.filter(c=>c.kind==='play').length),2);assert.equal(await h.page.evaluate(()=>window.calls.filter(c=>c.kind==='resume').length),1);await h.close();
 });
 await run('native GreenRoomBar uses a labelled return image and confirms monitoring only after control acknowledgement plus recent audio',async()=>{
  const h=await fixture({native:true,bar:true,stream:false});assert.equal(await h.page.locator('video,audio').count(),0);
  const enable=h.page.getByRole('button',{name:'Enable audio',exact:true});assert(await enable.isEnabled());
  await h.page.evaluate(()=>window.currentSeat.patch({nativeAudioAvailable:true,hasProgram:true,programPreview:'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='}));
  await h.page.getByRole('img',{name:'Return preview',exact:true}).waitFor();assert(await enable.isEnabled());
  await enable.click();assert.equal(await h.page.evaluate(()=>window.calls.filter(c=>c.kind==='resume').length),1);assert.equal(await h.page.evaluate(()=>window.calls.filter(c=>c.kind==='play').length),0);
  assert.equal(await h.page.getByRole('button',{name:'Monitoring enabled',exact:true}).count(),0);
  await h.page.evaluate(()=>window.currentSeat.patch({nativePlayback:true}));const enabled=h.page.getByRole('button',{name:'Monitoring enabled',exact:true});await enabled.waitFor();assert(await enabled.isDisabled());
  assert.doesNotMatch(await h.page.locator('.rm-seat-audio-status').innerText(),/audible|hear|speaker|listening/i);
  await h.page.evaluate(()=>window.currentSeat.patch({nativeAudioAvailable:false,hasProgram:false,programPreview:null}));await enable.waitFor();assert(await enable.isEnabled());assert.equal(await h.page.getByRole('img').count(),0);await h.close();
 });
 await run('native monitoring errors and hung requests remain bounded, retryable and fenced across seat replacement',async()=>{
  const h=await fixture({native:true,bar:true,stream:false,resume:'error',clock:true});await h.page.getByRole('button',{name:'Enable audio',exact:true}).click();
  const retry=h.page.getByRole('button',{name:'Retry audio',exact:true});await retry.waitFor();assert(await retry.isEnabled());assert.doesNotMatch(await h.page.locator('body').innerText(),/PRIVATE/);
  await h.page.evaluate(()=>{window.resumeMode='pending';});await retry.click();await h.page.getByRole('button',{name:'Enabling audio…',exact:true}).waitFor();await h.page.clock.fastForward(5100);await retry.waitFor();
  await h.page.evaluate(()=>{window.pendingResumes[0].resolve();window.currentSeat.patch({nativePlayback:true,nativeAudioAvailable:true});});await h.page.waitForTimeout(20);assert(await retry.isEnabled());
  await h.page.evaluate(()=>{window.resumeMode='pending';});await retry.click();await h.page.getByRole('button',{name:'Enabling audio…',exact:true}).waitFor();
  await h.page.evaluate(()=>{window.currentSeat=window.makeSeat();window.renderBar(window.currentSeat);});await h.page.getByRole('button',{name:'Enable audio',exact:true}).waitFor();
  await h.page.evaluate(()=>window.pendingResumes[1].reject(Error('PRIVATE_OLD_NATIVE')));await h.page.waitForTimeout(20);assert.equal(await retry.count(),0);await h.close();
 });
 console.log(`PASS: ${results.length} return-audio browser cases with real React hook/GreenRoomBar and DOM; mocked playback and seat only, no network/devices/native/media output.`);
 for(const result of results)console.log('PASS '+result);
}finally{await browser.close();}
