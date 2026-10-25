// Isolate the browser API from LiveKit/native timing. Synthetic camera/audio,
// no device permission or audible playback. Save only bounded numeric metadata.
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const here=path.dirname(fileURLToPath(import.meta.url));
const server=http.createServer(async(request,response)=>{
  if(request.url==='/worker.js') {
    response.writeHead(200,{'Content-Type':'text/javascript'});
    response.end(await readFile(path.join(here,'encoded-clock-worker.js')));
  } else if(request.url==='/') response.end('<!doctype html><title>Encoded clock API control</title>');
  else response.writeHead(404).end();
});
let browser;
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const report=await page.evaluate(async()=>{
    const reports={},errors=[],workers=[],tracks=[],transforms=[];
    const context=new AudioContext({sampleRate:48000});
    const destination=context.createMediaStreamDestination();
    const oscillator=context.createOscillator();oscillator.connect(destination);oscillator.start();
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const paint=canvas.getContext('2d');let frame=0;
    const timer=setInterval(()=>{paint.fillStyle=++frame%2?'white':'black';paint.fillRect(0,0,320,180);},33);
    const sender=new RTCPeerConnection({encodedInsertableStreams:true}),receiver=new RTCPeerConnection();
    sender.onicecandidate=event=>{if(event.candidate) receiver.addIceCandidate(event.candidate).catch(e=>errors.push(String(e)));};
    receiver.onicecandidate=event=>{if(event.candidate) sender.addIceCandidate(event.candidate).catch(e=>errors.push(String(e)));};
    try {
      await context.resume();
      for(const track of [...canvas.captureStream(30).getTracks(),...destination.stream.getTracks()]) {
        tracks.push(track);
        const rtp=sender.addTrack(track);
        if(typeof RTCRtpScriptTransform!=='function' || !('transform' in rtp)) {reports[track.kind]={supported:false};continue;}
        const worker=new Worker('/worker.js');workers.push(worker);
        await new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(new Error('Worker startup timeout')),3000);
          worker.onerror=event=>reject(new Error(event.message));
          worker.onmessage=event=>{
            reports[track.kind]={...reports[track.kind],...event.data};
            if(event.data.worker_ready){clearTimeout(timeout);resolve();}
          };
        });
        const transform=new RTCRtpScriptTransform(worker,{kind:track.kind,publication:'direct-control'});
        transforms.push(transform);rtp.transform=transform;
        reports[track.kind].transform_associated=rtp.transform===transform;
      }
      await sender.setLocalDescription(await sender.createOffer());
      await receiver.setRemoteDescription(sender.localDescription);
      await receiver.setLocalDescription(await receiver.createAnswer());
      await sender.setRemoteDescription(receiver.localDescription);
      await new Promise(resolve=>setTimeout(resolve,5000));
      const stats=[...(await sender.getStats()).values()].filter(item=>item.type==='outbound-rtp').map(({kind,packetsSent,bytesSent})=>({kind,packetsSent,bytesSent}));
      return {browser:navigator.userAgent,source:'canvas plus WebAudio destination',encoded_insertable_streams_requested:true,reports,errors,stats,
        sender_state:sender.connectionState,receiver_state:receiver.connectionState,
        hardware_capture_used:false,speaker_playback_used:false,media_payload_retained:false};
    } finally {
      clearInterval(timer);tracks.forEach(track=>track.stop());oscillator.stop();
      sender.close();receiver.close();workers.forEach(worker=>worker.terminate());await context.close();
    }
  });
  const output=path.resolve(here,'../evidence/browser-encoded-clock-api-control.json');
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({report:output,errors:report.errors,
    tracks:Object.fromEntries(Object.entries(report.reports).map(([kind,value])=>[kind,{frames:value.frames??0,capture_time_present:value.capture_time_present??0,worker_ready:value.worker_ready}]))}));
} finally {
  await browser?.close();await new Promise(resolve=>server.close(resolve));
}
