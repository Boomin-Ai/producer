export const guestPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Join Kleveland · Producer</title>
<style>
:root{color-scheme:dark;background:#08111b;color:#edf4f8;font:16px system-ui}
body{margin:0} main{max-width:42rem;margin:6vh auto;padding:24px;box-sizing:border-box}
h1{font-size:1.8rem;letter-spacing:-.03em}
form{display:flex;flex-wrap:wrap;gap:10px;align-items:end}
label{display:grid;gap:5px;color:#a3b6c0}
button,input{font:inherit;padding:10px 13px;border-radius:8px;border:1px solid #3e5361}
button{cursor:pointer;background:#18382f;color:#bbf2db}
[role=status]{color:#a3b6c0;min-height:1.25em}
.stage{position:relative;background:#05090c;border-radius:12px;overflow:hidden}
.stage:not(.live) #program{display:none}
.stage:not(.live) #local{display:block;width:100%;max-height:48svh;object-fit:contain}
.stage.live #program{display:block;width:100%;max-height:75dvh;object-fit:contain}
.stage.live #local{position:absolute;right:12px;bottom:12px;width:min(28%,150px);aspect-ratio:4/3;object-fit:cover;border:1px solid #738896;border-radius:8px;background:#0b111a}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-top:12px}
.controls p{margin:0;flex:1}
body.immersive main{position:fixed;inset:0;display:flex;flex-direction:column;max-width:none;height:100dvh;margin:0;padding:0;background:#05090c}
body.immersive h1,body.immersive form{display:none}
body.immersive .stage{flex:1;min-height:0;border-radius:0}
body.immersive .stage.live #program{width:100%;height:100%;max-height:none}
body.immersive .controls{padding:8px max(12px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left))}
[hidden]{display:none!important}
</style>
<main><h1>Join the studio</h1>
<form><label>Your guest name<input maxlength="48" required autocomplete="nickname"></label><button>Join as a guest</button></form>
<div class="stage"><video id="program" autoplay playsinline></video><video id="local" muted autoplay playsinline></video></div>
<div class="controls"><p role="status" aria-live="polite"></p><button id="focus" hidden>Full view</button><button id="leave" hidden>Leave studio</button></div></main>
<script>
const secret=location.hash.slice(1), headers={Authorization:'Bearer '+secret,'Content-Type':'application/json'};
const form=document.querySelector('form'), nameInput=document.querySelector('input'), statusText=document.querySelector('[role=status]');
const local=document.querySelector('#local'),program=document.querySelector('#program');
const leave=document.querySelector('#leave'),focus=document.querySelector('#focus'),surface=document.querySelector('.stage');
let stream, peer, stage, generation=0, layoutReady=false;
function immersive(active){document.body.classList.toggle('immersive',active);focus.textContent=active?'Exit full view':'Full view'}
function layout(){
 if(!program.videoWidth || !program.videoHeight)return;
 surface.classList.add('live');focus.hidden=false;
 if(!layoutReady){layoutReady=true;immersive(program.videoHeight>program.videoWidth)}
}
program.onloadedmetadata=layout;program.onresize=layout;
focus.onclick=()=>immersive(!document.body.classList.contains('immersive'));
try{nameInput.value=localStorage.getItem('producer.guest.name')||''}catch{}
function stop(message){generation++;if(peer){peer.onconnectionstatechange=null;peer.close();peer=null}stream?.getTracks().forEach(t=>t.stop());stream=null;local.srcObject=null;program.srcObject=null;surface.classList.remove('live');layoutReady=false;focus.hidden=true;immersive(false);leave.hidden=true;form.hidden=false;statusText.textContent=message}
form.onsubmit=async(event)=>{
 event.preventDefault();const attempt=++generation;form.hidden=true;leave.hidden=false;
 try {
  if(!/^[a-f0-9]{64}$/.test(secret))throw Error('This invitation is incomplete.');
  const offer=await fetch(location.pathname+'/offer',{headers});if(!offer.ok)throw Error('Ask the host for a fresh guest link.');
  const desc=await offer.json();if(generation!==attempt)return;
  statusText.textContent='Starting camera and microphone…';
  const captured=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:{echoCancellation:true}});
  if(generation!==attempt){captured.getTracks().forEach(t=>t.stop());return}
  stream=captured;local.srcObject=stream;
  const pc=peer=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]});
  const remote=new MediaStream();program.srcObject=remote;pc.ontrack=e=>remote.addTrack(e.track);
  pc.ondatachannel=({channel})=>{if(channel.label==='producer-stage/1'){channel.binaryType='arraybuffer';channel.onmessage=e=>{if(e.data instanceof ArrayBuffer){stage=new Uint8Array(e.data)[0]?'On stage':'Backstage';statusText.textContent=stage}}}};
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='connected')statusText.textContent=stage||'Connected';if(pc.connectionState==='failed')stop('Connection lost. Ask the host for a fresh link.')};
  stream.getTracks().forEach(t=>pc.addTrack(t,stream));await pc.setRemoteDescription({type:'offer',sdp:desc.sdp});await pc.setLocalDescription(await pc.createAnswer());
  await new Promise(resolve=>{const timer=setTimeout(resolve,6000);pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete'){clearTimeout(timer);resolve()}};pc.onicegatheringstatechange()});
  if(attempt!==generation)return;
  let id=crypto.randomUUID().replaceAll('-','');try{id=localStorage.getItem('producer.guest.id')||id;localStorage.setItem('producer.guest.id',id);localStorage.setItem('producer.guest.name',nameInput.value)}catch{}
  const answer=await fetch(location.pathname+'/answer',{method:'POST',headers,body:JSON.stringify({protocol:'producer-rtc/1',type:'answer',sdp:pc.localDescription.sdp,guest:{id,name:nameInput.value.trim()}})});
  if(!answer.ok)throw Error('Invitation expired or already claimed. Ask the host for a fresh link.');
  if(attempt===generation && pc.connectionState!=='connected')statusText.textContent='Waiting for the host to admit you…';
 }catch(e){if(attempt===generation)stop(e.message)}
};
leave.onclick=()=>stop('You left the studio.');onpagehide=()=>stop('');
</script></html>`;
