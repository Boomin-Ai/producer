// Observe the real virtual camera. Permission is granted only for video;
// select the exact portrait device before getUserMedia, never a default mic/cam.
import {writeFile} from 'node:fs/promises';
const live=process.argv.includes('--live');
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
try {
 const context=await browser.newContext({permissions:['camera']});
 const page=await context.newPage();
 await page.goto(process.env.PRODUCER_PREVIEW_ORIGIN??'http://127.0.0.1:1432/scripts/native-probe.html');
 const result=await page.evaluate(async()=>{
  const device=(await navigator.mediaDevices.enumerateDevices()).find(d=>d.kind==='videoinput'&&d.label==='Producer Virtual Camera');
  if(!device)throw Error('Producer Virtual Camera is not installed/approved yet');
  const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{deviceId:{exact:device.deviceId},width:{ideal:1080},height:{ideal:1920},frameRate:{ideal:30}}});
  try{
   const video=document.createElement('video');video.muted=true;video.srcObject=stream;document.body.append(video);await video.play();
   await new Promise(r=>setTimeout(r,3000));
   const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
   const ctx=canvas.getContext('2d');ctx.drawImage(video,0,0);
   const pixel=(x,y)=>[...ctx.getImageData(Math.floor(canvas.width*x),Math.floor(canvas.height*y),1,1).data].slice(0,3);
   const topLeft=pixel(.1,.05),bottomRight=pixel(.9,.95),center=pixel(.5,.5);
   const time=video.currentTime;await new Promise(r=>setTimeout(r,2000));
   const correct=(p,dominant)=>p[dominant]>180&&p.every((v,i)=>i===dominant||v<70);
   return {width:canvas.width,height:canvas.height,topLeft,bottomRight,center,advancing:video.currentTime>time+1,
    upright:correct(topLeft,0)&&correct(bottomRight,1)&&correct(center,2),image:canvas.toDataURL('image/png')};
  }finally{stream.getTracks().forEach(t=>t.stop());}
 });
 const png=result.image.split(',')[1];delete result.image;
 await writeFile(process.argv[2]??'/private/tmp/producer-portrait-camera-frame.png',Buffer.from(png,'base64'));
 await writeFile('/private/tmp/producer-portrait-camera-capture.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
 if(result.width!==1080||result.height!==1920||(!live&&!result.upright)||!result.advancing)throw Error('Portrait camera acceptance failed');
} finally {await browser.close();}
