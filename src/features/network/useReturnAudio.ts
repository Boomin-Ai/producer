/** Playback state for one caller-owned return-audio element. No media/device
 * ownership: never captures, stops tracks, changes mute/volume or claims that
 * a physical speaker is audible. */
import {useCallback,useEffect,useRef,useState} from 'react';
import type {GuestSeat} from '../../lib/guestSeat';

export type ReturnAudioStatus='waiting'|'blocked'|'starting'|'playing'|'paused'|'error';
type Input={seat:Pick<GuestSeat,'resumeAudio'>|null;stream:MediaStream|null};
type View={status:ReturnAudioStatus;message:string};
type Binding=Input&{element:HTMLAudioElement;active:boolean;attempt:number;seenPlaying:boolean;settled:boolean;
 failure:'blocked'|'error'|null;paused:boolean;finish:()=>void};
const TIMEOUT_MS=5000;
const messages:Record<ReturnAudioStatus,string>={
 waiting:'Waiting for host audio.',blocked:'Audio playback is blocked. Use the audio button to try again.',
 starting:'Starting host audio…',playing:'Host audio playback is running.',
 paused:'Host audio playback is paused. Use the audio button to resume.',
 error:'Host audio could not start. Use the audio button to try again.',
};
function liveAudio(stream:MediaStream|null){return !!stream?.getAudioTracks().some(track=>track.readyState==='live');}
function playing(element:HTMLAudioElement){return !element.paused&&!element.ended&&element.readyState>=2;}
function blocked(reason:unknown){return !!reason&&typeof reason==='object'&&'name' in reason&&reason.name==='NotAllowedError';}

export function useReturnAudio({seat,stream}:Input){
 const audioRef=useRef<HTMLAudioElement>(null),binding=useRef<Binding|null>(null),input=useRef<Input>({seat,stream});
 input.current={seat,stream};
 const [view,setView]=useState<View>({status:'waiting',message:messages.waiting});
 const current=useCallback((owner:Binding)=>owner.active&&binding.current===owner&&audioRef.current===owner.element&&
  input.current.seat===owner.seat&&input.current.stream===owner.stream&&owner.element.srcObject===owner.stream,[]);
 const show=useCallback((owner:Binding,status:ReturnAudioStatus)=>{
  if(current(owner))setView(old=>old.status===status?old:{status,message:messages[status]});
 },[current]);
 const reflect=useCallback((owner:Binding)=>{
  if(!current(owner))return;
  if(!liveAudio(owner.stream)){show(owner,'waiting');return;}
  if(owner.failure){show(owner,owner.failure);return;}
  if(owner.paused){show(owner,'paused');return;}
  // A fulfilled play promise or a live track by itself proves no playback.
  if(owner.settled&&owner.seenPlaying&&playing(owner.element))show(owner,'playing');
  else show(owner,'starting');
 },[current,show]);
 const start=useCallback((owner:Binding,gesture:boolean):Promise<void>=>{
  if(!current(owner))return Promise.resolve();
  owner.finish();const attempt=++owner.attempt;
  owner.failure=null;owner.paused=false;owner.settled=false;owner.seenPlaying=playing(owner.element);
  show(owner,liveAudio(owner.stream)?'starting':'waiting');
  let finish:()=>void=()=>{};
  const done=new Promise<void>(resolve=>{finish=resolve;});
  let complete=false;
  const timer=setTimeout(()=>{
   if(current(owner)&&owner.attempt===attempt){owner.failure='error';reflect(owner);}
   finishOnce();
  },TIMEOUT_MS);
  const finishOnce=()=>{if(complete)return;complete=true;clearTimeout(timer);finish();};
  owner.finish=finishOnce;
  // Both APIs are invoked in this stack, before any await/then. This preserves
  // the trusted click for WebKit's AudioContext and media autoplay policies.
  let resume:Promise<unknown>,play:Promise<unknown>;
  try{resume=Promise.resolve(gesture?owner.seat?.resumeAudio():undefined);}catch(error){resume=Promise.reject(error);}
  try{play=Promise.resolve(owner.element.play());}catch(error){play=Promise.reject(error);}
  void Promise.allSettled([resume,play]).then(results=>{
   if(!complete&&current(owner)&&owner.attempt===attempt){
    owner.settled=true;
    const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
    if(failures.length)owner.failure=failures.some(result=>blocked(result.reason))?'blocked':'error';
    reflect(owner);
    // Successful promises without actual playback stay bounded too: retain
    // the deadline until a real playing event/state is observed.
    if(owner.failure||!liveAudio(owner.stream)||owner.paused||owner.seenPlaying&&playing(owner.element))finishOnce();
   }
  });
  return done;
 },[current,reflect,show]);
 const enableAudio=useCallback(()=>{
  const owner=binding.current;return owner?start(owner,true):Promise.resolve();
 },[start]);

 useEffect(()=>{
  const element=audioRef.current;
  if(!element){setView({status:'waiting',message:messages.waiting});return;}
  const owner:Binding={seat,stream,element,active:true,attempt:0,seenPlaying:false,settled:false,failure:null,paused:false,finish:()=>{}};
  binding.current=owner;
  if(element.srcObject!==stream)element.srcObject=stream;
  const onPlaying=()=>{
   if(!current(owner)||!playing(element))return;
   owner.seenPlaying=true;owner.paused=false;reflect(owner);
   if(owner.settled&&!owner.failure)owner.finish();
  };
  const onPause=()=>{
   // Queued events from a previous source cannot override current DOM truth.
   if(!current(owner)||!element.paused)return;
   owner.seenPlaying=false;owner.paused=true;reflect(owner);if(owner.settled)owner.finish();
  };
  const onError=()=>{
   if(!current(owner)||!element.error)return;
   owner.failure='error';reflect(owner);owner.finish();
  };
  const onEnded=()=>{
   if(!current(owner)||!element.ended&&liveAudio(stream))return;
   owner.seenPlaying=false;owner.paused=true;reflect(owner);if(owner.settled)owner.finish();
  };
  element.addEventListener('playing',onPlaying);element.addEventListener('pause',onPause);
  element.addEventListener('error',onError);element.addEventListener('ended',onEnded);
  let removeTracks:()=>void=()=>{};
  const tracksChanged=()=>{
   removeTracks();const tracks=stream?.getAudioTracks()??[];
   const ended=()=>{if(!current(owner))return;if(!liveAudio(stream)){owner.finish();owner.attempt++;owner.seenPlaying=false;show(owner,'waiting');}};
   tracks.forEach(track=>track.addEventListener('ended',ended));
   removeTracks=()=>tracks.forEach(track=>track.removeEventListener('ended',ended));
   if(current(owner)){
    if(liveAudio(stream))void start(owner,false);
    else{owner.finish();owner.attempt++;show(owner,'waiting');}
   }
  };
  stream?.addEventListener('addtrack',tracksChanged);stream?.addEventListener('removetrack',tracksChanged);
  tracksChanged();
  return ()=>{
   owner.active=false;owner.attempt++;owner.finish();removeTracks();
   element.removeEventListener('playing',onPlaying);element.removeEventListener('pause',onPause);
   element.removeEventListener('error',onError);element.removeEventListener('ended',onEnded);
   stream?.removeEventListener('addtrack',tracksChanged);stream?.removeEventListener('removetrack',tracksChanged);
   if(binding.current===owner)binding.current=null;
   // Detach only this binding. Never pause a replacement or stop owned tracks.
   if(element.srcObject===stream)element.srcObject=null;
  };
 },[seat,stream,current,reflect,show,start]);
 return {audioRef,status:view.status,message:view.message,enableAudio};
}
