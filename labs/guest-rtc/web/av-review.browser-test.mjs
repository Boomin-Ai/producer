// Generated canvas/tone only; checks the actual browser AV review codec/flush.
import http from 'node:http';
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const server=http.createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><canvas width="640" height="480"></canvas></body></html>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try {
 browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result=await page.evaluate(async()=>{
  const canvas=document.querySelector('canvas');const paint=canvas.getContext('2d');const video=canvas.captureStream(30);
  const context=new AudioContext({sampleRate:48000});await context.resume();const source=context.createOscillator();const destination=context.createMediaStreamDestination();source.connect(destination);source.start();
  const recorder=new MediaRecorder(new MediaStream([...video.getVideoTracks(),...destination.stream.getAudioTracks()]),{mimeType:'video/webm;codecs=vp8,opus',videoBitsPerSecond:750000,audioBitsPerSecond:64000});
  const chunks=[];recorder.ondataavailable=event=>chunks.push(event.data);
  const finished=new Promise(resolve=>{recorder.onstop=resolve;});
  recorder.start(200);const timer=setInterval(()=>{paint.fillStyle=paint.fillStyle==='#ffffff'?'#000000':'#ffffff';paint.fillRect(0,0,640,480);},33);
  await new Promise(resolve=>setTimeout(resolve,1500));recorder.stop();await finished;clearInterval(timer);source.stop();for(const track of video.getTracks())track.stop();await context.close();
  const blob=new Blob(chunks,{type:recorder.mimeType});const header=new Uint8Array(await blob.slice(0,4).arrayBuffer());
  const element=document.createElement('video');element.muted=true;element.src=URL.createObjectURL(blob);document.body.append(element);
  await new Promise((resolve,reject)=>{element.onloadedmetadata=resolve;element.onerror=reject;});await element.play();
  const result={bytes:blob.size,header:[...header],width:element.videoWidth,height:element.videoHeight,mime:recorder.mimeType,tracks:recorder.stream.getTracks().map(track=>track.kind)};element.pause();URL.revokeObjectURL(element.src);return result;
 });
 assert.ok(result.bytes>1000);assert.equal(result.width,640);assert.equal(result.height,480);assert.deepEqual(result.header,[26,69,223,163]);assert.deepEqual(result.tracks.sort(),['audio','video']);
 console.log(JSON.stringify({test:'private-av-review-generated-codec-and-flush',...result,camera_used:false,microphone_used:false,private_media_saved:false}));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
