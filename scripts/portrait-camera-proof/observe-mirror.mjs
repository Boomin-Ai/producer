import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const report=process.argv[2];if(!report)throw Error('Pass the native camera probe report path');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function phase(expected){
 const until=Date.now()+300000;
 while(Date.now()<until){
  let state;try{state=JSON.parse(await readFile(report,'utf8'));}catch{}
  if(state?.stage==='failed')throw Error(state.error);
  if(state?.stage==='camera_running'&&state.phase===expected)return state;
  if(state?.stage==='complete'||state?.phase>expected)throw Error('Missed native probe phase');
  await sleep(200);
 }
 throw Error('Native mirror probe timed out');
}
await phase(0);
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext({permissions:['camera']});const page=await context.newPage();
 await page.goto(process.env.PRODUCER_PREVIEW_ORIGIN??'http://127.0.0.1:1432/scripts/native-probe.html');
 await page.evaluate(async()=>{
  const device=(await navigator.mediaDevices.enumerateDevices()).find(d=>d.kind==='videoinput'&&d.label==='Producer Portrait Camera');
  if(!device)throw Error('Portrait camera is unavailable');
  const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{deviceId:{exact:device.deviceId},width:{ideal:1080},height:{ideal:1920}}});
  const video=document.createElement('video');video.muted=true;video.srcObject=stream;document.body.append(video);await video.play();
  window.mirrorProof={video,stream,track:stream.getVideoTracks()[0]};
 });
 const samples=[];
 for(let index=0;index<3;index++){
  const state=await phase(index);await sleep(1500);
  const sample=await page.evaluate(()=>{
   const {video,stream,track}=window.mirrorProof;const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
   const c=canvas.getContext('2d');c.drawImage(video,0,0);
   const p=(x,y)=>[...c.getImageData(Math.floor(x*canvas.width),Math.floor(y*canvas.height),1,1).data].slice(0,3);
   return {width:canvas.width,height:canvas.height,time:video.currentTime,sameTrack:track===stream.getVideoTracks()[0]&&track.readyState==='live',tl:p(.1,.05),tr:p(.9,.05),bl:p(.1,.95),br:p(.9,.95),center:p(.5,.5)};
  });
  const matches=(p,channel)=>p[channel]>180&&p.every((v,i)=>i===channel||v<70);
  assert.equal(sample.width,1080);assert.equal(sample.height,1920);assert(sample.sameTrack);
  assert(matches(state.mirrored?sample.tr:sample.tl,0),'Red marker on wrong side');
  assert(matches(state.mirrored?sample.bl:sample.br,1),'Green marker on wrong side');
  assert(matches(sample.center,2),'Center should remain blue');
  if(samples.length)assert(sample.time>samples.at(-1).time,'Camera playback reset or stalled');
  samples.push({...sample,mirrored:state.mirrored,phase:index});
 }
 await page.evaluate(()=>window.mirrorProof.stream.getTracks().forEach(t=>t.stop()));
 await writeFile('/private/tmp/producer-live-mirror-proof.json',JSON.stringify({passed:true,samples},null,2));
 console.log('PASS: real portrait-camera frames mirror and restore without restarting the receiving track.');
}finally{await browser.close();}
