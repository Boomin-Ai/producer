import {useEffect,useRef,useState} from 'react';
import type {EndpointInfo,LiveRoom} from '../../lib/ipc';
import type {GuestSeatSpec} from '../../lib/guestSeat';
import {parseProducerJoinLink,resolveProducerInvitation} from '../../lib/producerJoin';
import {producerInvitationLabel} from './providerLabels';
import './producer-join.css';

export function ProducerJoin({endpoint,rooms,invitation,onClose,onEnter,nativeProgramAvailable=false}:{endpoint:EndpointInfo|null;rooms:LiveRoom[];invitation?:GuestSeatSpec;onClose:()=>void;onEnter:(seat:GuestSeatSpec,signal:AbortSignal)=>void|Promise<void>;nativeProgramAvailable?:boolean}){
 const [url,setUrl]=useState(''),[api,setApi]=useState(''),[name,setName]=useState(endpoint?.name??''),[mode,setMode]=useState<'program'|'webcam'>(rooms.length?'program':'webcam'),[roomId,setRoomId]=useState(rooms[0]?.id??''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const operation=useRef<AbortController|null>(null),alive=useRef(true);
 const close=()=>{operation.current?.abort();onClose();};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;operation.current?.abort();};},[]);
 const enter=async()=>{
  if(operation.current)return;setBusy(true);setError('');const abort=new AbortController();operation.current=abort;
  try{
   if(mode==='program'&&!rooms.some(r=>r.id===roomId))throw Error('Choose the local room whose Set you want to send.');
   let seat:GuestSeatSpec;
   if(invitation)seat=invitation;
   else{
    const link=parseProducerJoinLink(url,api),joinUrl=await resolveProducerInvitation(link,name,`Producer/${endpoint?.brand_slug??'selfhost'}`,abort.signal);
    seat={joinUrl,apiBase:link.apiBase,hostName:new URL(url).hostname,title:'Producer appearance',producerCam:false,endpointId:endpoint?.id??''};
   }
   if(alive.current&&!abort.signal.aborted)await onEnter({...seat,videoSource:mode,localRoomId:mode==='program'?roomId:undefined},abort.signal);
  }catch(e){if(alive.current&&!abort.signal.aborted)setError(e instanceof Error?e.message:'Could not open this invitation.');}
  finally{if(operation.current===abort)operation.current=null;if(alive.current)setBusy(false);}
 };
 return <section className="producer-join" aria-label="Join a Producer room">
  <header><div><small>{producerInvitationLabel(invitation)}</small><h1>{invitation?`Appear with ${invitation.hostName}`:'Join another Producer'}</h1></div><button onClick={close} aria-label="Close Producer invitation">×</button></header>
  <p>Bring your Set into their show. The host controls admission and when you appear on stage.</p>
  <form onSubmit={e=>{e.preventDefault();void enter();}}>
   {!invitation&&<><label>Room or invitation link<input aria-label="Producer invitation link" type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://their-server/connect/guest/…" required disabled={busy}/></label><label>Your name<input value={name} onChange={e=>setName(e.target.value)} maxLength={80} required disabled={busy}/></label><details><summary>Guest API address</summary><p>Boomin links resolve automatically. For a separate self-hosted API, enter its HTTPS address.</p><input aria-label="Guest API address" type="url" value={api} onChange={e=>setApi(e.target.value)} placeholder="Automatic from invitation" disabled={busy}/></details></>}
   <fieldset disabled={busy}><legend>What do you want to send?</legend><label className="producer-send-option"><input type="radio" name="producer-video" checked={mode==='program'} disabled={!rooms.length} onChange={()=>setMode('program')}/><span><strong>My room and Set</strong><small>{nativeProgramAvailable?'720p30 for Boomin rooms. Other servers use Producer Virtual Camera.':'Composed output and processed audio. Requires Producer Virtual Camera.'}</small></span></label>
    <label className="producer-send-option"><input type="radio" name="producer-video" checked={mode==='webcam'} onChange={()=>setMode('webcam')}/><span><strong>Webcam and microphone</strong><small>Send just your camera and voice.</small></span></label>
   </fieldset>
   {mode==='program'&&<label>Local room<select aria-label="Room to send" value={roomId} onChange={e=>setRoomId(e.target.value)} disabled={busy}>{rooms.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
   {error&&<p role="alert">{error}</p>}
   <footer><small>{mode==='program'?'Your room opens locally. Nothing is sent until the host admits you.':'Your camera and microphone start only after the host admits you.'}</small><button type="submit" disabled={busy}>{busy?'Opening invitation…':'Join room'}</button></footer>
  </form>
 </section>;
}
