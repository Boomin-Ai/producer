import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {notifyError} from '../../lib/notices';
type Update={session:number;state:string;text:string;is_final:boolean;message?:string};
export function LiveCaptions({enabled,onText,maxLength=160}:{enabled:boolean;onText:(text:string)=>void;maxLength?:number}){
 const [state,setState]=useState('off'),session=useRef<number|null>(null),lastText=useRef(''),active=useRef(true),text=useRef(onText),limit=useRef(maxLength);text.current=onText;limit.current=Math.max(16,Math.min(160,maxLength));
 const stop=async()=>{const id=session.current;session.current=null;setState('off');lastText.current='';text.current('');if(id!==null)await invoke('live_transcription_stop',{session:id}).catch(()=>{});};
 useEffect(()=>{active.current=true;let disposed=false;let unlisten:(()=>void)|undefined;
  void listen<Update>('live://transcript',({payload:p})=>{if(disposed||!active.current||session.current!==p.session)return;
   if(p.state==='error'){setState('off');session.current=null;lastText.current='';text.current('');notifyError(p.message??'Live captions disconnected',{key:'transcription'});return;}
   if(p.text&&p.text!==lastText.current){lastText.current=p.text;const tail=p.text.slice(-limit.current);text.current(p.text.length>limit.current?tail.replace(/^\S*\s/,''):tail);}
  }).then(fn=>{if(!disposed)unlisten=fn;else fn();});
  return()=>{disposed=true;active.current=false;unlisten?.();const id=session.current;session.current=null;if(id!==null)void invoke('live_transcription_stop',{session:id}).catch(()=>{});};
 },[]);
 useEffect(()=>{if(!enabled)void stop();},[enabled]);
 const start=async()=>{if(!enabled)return;setState('connecting');
  try{const id=await invoke<number>('live_transcription_start');if(!active.current){void invoke('live_transcription_stop',{session:id});return;}session.current=id;setState('listening');}
  catch(e){if(active.current){setState('off');notifyError(e,{key:'transcription'});}}
 };
 if(!enabled)return null;
 return <button className={`hd-chip${state==='listening'?' on':''}`} disabled={state==='connecting'} aria-pressed={state==='listening'} title="Live microphone captions through your saved Deepgram connection" onClick={()=>void(state==='listening'?stop():start())}>{state==='connecting'?'Connecting captions…':state==='listening'?'Stop captions':'Captions'}</button>;
}
