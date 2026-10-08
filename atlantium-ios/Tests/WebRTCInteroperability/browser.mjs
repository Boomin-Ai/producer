import http from 'node:http';
import {spawn} from 'node:child_process';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const iceServers = process.env.ICE_JSON ? JSON.parse(process.env.ICE_JSON) : null;
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage();
const server=http.createServer(async(req,res)=>{
  if(req.url!='/offer'){res.end('<html><body>WebRTC integration</body></html>');return}
  try{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const offer=JSON.parse(Buffer.concat(chunks));
    const answer=await page.evaluate(async ({offer,iceServers})=>{
      const peer=window.peer=new RTCPeerConnection(iceServers ? {iceServers,iceTransportPolicy:"relay"} : {});
      peer.ondatachannel=event=>{window.channel=event.channel;event.channel.onmessage=e=>{if(e.data==='native-ping')event.channel.send('browser-pong')}};
      const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;const ctx=canvas.getContext('2d');ctx.fillStyle='cyan';ctx.fillRect(0,0,320,240);
      document.body.append(canvas);const video=canvas.captureStream(10);let tick=0;window.paint=setInterval(()=>{ctx.fillStyle=tick++%2?'red':'cyan';ctx.fillRect(0,0,320,240);video.getVideoTracks()[0].requestFrame?.()},100);
      window.audio=new AudioContext();const oscillator=window.audio.createOscillator();const gain=window.audio.createGain();gain.gain.value=0;const destination=window.audio.createMediaStreamDestination();oscillator.connect(gain);gain.connect(destination);oscillator.start();
      await peer.setRemoteDescription(offer);
      for(const track of video.getTracks())peer.addTrack(track,video);
      for(const track of destination.stream.getTracks())peer.addTrack(track,destination.stream);
      await peer.setLocalDescription(await peer.createAnswer());
      if(peer.iceGatheringState!=='complete')await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('browser ICE timeout')),30000);peer.onicegatheringstatechange=()=>{if(peer.iceGatheringState==='complete'){clearTimeout(timer);resolve()}}});
      return peer.localDescription.toJSON();
    },{offer,iceServers});
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(answer));
  }catch(error){console.error(error);res.statusCode=500;res.end('{}')}
});
await new Promise(resolve=>server.listen(8894,'127.0.0.1',resolve));
try{
  await page.goto('http://127.0.0.1:8894');
  const child=spawn(process.argv[2],[],{stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  const timer=setTimeout(()=>child.kill(),45000);
  const code=await new Promise(resolve=>child.on('exit',resolve));clearTimeout(timer);
  if(code!==0)throw new Error('Native/browser interop failed: '+code);
}finally{server.close();await browser.close()}
