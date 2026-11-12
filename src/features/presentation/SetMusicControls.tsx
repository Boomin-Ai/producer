import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {dj,queueTrack,type DJLibrary} from '../../lib/dj';
import {commandDj,useDjStatus} from '../../lib/djObserver';
import {ensureStarterAudio} from '../../lib/starterAudio';
import type {OperatorComponent} from './schema';
import {NumberSlider} from './NumberSlider';
import './SetMusicControls.css';

function MusicIcon({kind}:{kind:'play'|'pause'|'stop'|'music'}){
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">{kind==='pause'?<><rect x="5" y="4" width="3" height="12" rx="1"/><rect x="12" y="4" width="3" height="12" rx="1"/></>:kind==='stop'?<rect x="5" y="5" width="10" height="10" rx="1.5"/>:kind==='music'?<path d="M8 4v9.1a3.6 3.6 0 0 0-1.5-.3C4.6 12.8 3 14 3 15.5S4.6 18 6.5 18s3.5-1.1 3.5-2.5V7l6-1.5v5.6a3.6 3.6 0 0 0-1.5-.3C12.6 10.8 11 12 11 13.5s1.6 2.5 3.5 2.5 3.5-1.1 3.5-2.5V1.5L8 4Z"/>:<path d="M6 3.7a.8.8 0 0 1 1.2-.7l9.2 6.3a.8.8 0 0 1 0 1.4L7.2 17a.8.8 0 0 1-1.2-.7V3.7Z"/>}</svg>;
}

/** Registered operator component; no autoplay and no serialized machine paths.
 * Uses the same native DJ mixer as the DJ panel, not a second audio player. */
export function SetMusicControls({definition,compact=false,disabled=false}:{definition:OperatorComponent;compact?:boolean;disabled?:boolean}){
  const {status,pending,error:playbackError}=useDjStatus(!disabled),[library,setLibrary]=useState<DJLibrary>(),[selected,setSelected]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const id=useId(),[position,setPosition]=useState({left:8,top:8});
  const lifetime=useRef(0),enabled=useRef(false);
  useLayoutEffect(()=>{enabled.current=!disabled;++lifetime.current;return()=>{enabled.current=false;++lifetime.current;};},[disabled,definition.id]);
  useEffect(()=>{if(disabled)return;let alive=true;void ensureStarterAudio().then(async pack=>{const lib=await dj.library();if(!lib?.tracks||!pack?.assets)throw Error('Music library is unavailable.');if(!alive)return;const preferred=lib.tracks.find(t=>t.path===pack.assets.find(a=>a.id===definition.defaultTrack)?.path)?.id??'';setLibrary(lib);setSelected(old=>lib.tracks.some(t=>t.id===old)?old:preferred);setError('');}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[disabled,definition.defaultTrack,retry]);
  const track=library?.tracks.find(t=>t.id===selected),deck=status?.active??0,current=status?.decks[deck],same=!!track&&current?.track?.id===track.id,playing=same&&current?.state===1;
  const previousTrack=useRef<string|undefined>(undefined);
  useEffect(()=>{const active=current?.track?.id,previous=previousTrack.current;previousTrack.current=active;if(active&&library?.tracks.some(t=>t.id===active))setSelected(old=>!old||old===previous?active:old);},[current?.track?.id,library]);
  const run=(fn:(check:()=>void)=>Promise<unknown>)=>{const epoch=lifetime.current;const check=()=>{if(!enabled.current||epoch!==lifetime.current)throw new DOMException('Music control is no longer active.','AbortError');};setError('');void fn(check).catch(e=>{if(enabled.current&&epoch===lifetime.current)setError(String(e));});};
  const toggle=async(check:()=>void)=>{
    if(!track)return;
    let loaded=false;
    await commandDj(now=>{check();const n=now.active,d=now.decks[n];loaded=d.track?.id!==track.id;return !loaded?(d.state===1?{kind:'pause',deck:n}:{kind:'play',deck:n}):{kind:'load',deck:n,track:queueTrack(track)};});
    // Loading prepares a deck; play is always an explicit consequence of this click.
    if(loaded){check();await commandDj(now=>{check();if(now.decks[now.active].track?.id!==track.id)throw Error('The DJ track changed. Select it again.');return {kind:'play',deck:now.active};});}
  };
  const content=<section className="set-music" aria-label={definition.label}>
    <div className="set-music-heading"><strong>{definition.label}</strong><small>{playing?'Playing':same&&current?.position_ms?'Paused':'Ready'}</small></div>
    <div className="set-music-track"><button type="button" aria-label={playing?'Pause music':'Play music'} title={playing?'Pause music':'Play music'} disabled={disabled||pending||!track} onClick={()=>run(toggle)}><MusicIcon kind={playing?'pause':'play'}/></button>
      <select aria-label="Waiting music track" disabled={disabled||pending||!library} value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Choose music</option>{library?.tracks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select>
      <button type="button" aria-label="Stop music" title="Stop music" disabled={disabled||pending||!same} onClick={()=>run(check=>commandDj(now=>{check();if(now.decks[now.active].track?.id!==track?.id)throw Error('The DJ track changed.');return {kind:'stop',deck:now.active};}))}><MusicIcon kind="stop"/></button>
    </div>
    <NumberSlider owner={definition} label="Music volume" unit="%" value={Math.round((status?.volume??.65)*100)} min={0} max={100} step={1} defaultValue={65} disabled={disabled||!status} pending={pending} onCommit={value=>{const epoch=lifetime.current;return commandDj(now=>{if(!enabled.current||epoch!==lifetime.current)throw new DOMException('Music control is no longer active.','AbortError');return {kind:'mix',volume:value/100,crossfader:now.crossfader,fade:now.fade,repeat:now.repeat,shuffle:now.shuffle,duck:now.duck};});}}/>
    {(error||playbackError)?<p role="alert">{error||playbackError} <button type="button" onClick={()=>setRetry(n=>n+1)}>Retry music</button></p>:<small className="set-music-note">{disabled?'Playback is available in the host room.':'Shared with DJ · playback changes only when you press a control.'}</small>}
  </section>;
  if(!compact)return content;
  return <><button type="button" className="set-music-mini" aria-label="Open waiting music" title={definition.label} popoverTarget={id} onClick={e=>{const r=e.currentTarget.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(r.left,innerWidth-328)),top:Math.max(8,Math.min(r.top>260?r.top-250:r.bottom+8,innerHeight-270))});}}><MusicIcon kind="music"/><span>{playing?'Playing':definition.label}</span></button>{createPortal(<div id={id} popover="auto" className="set-music-popover set-controls" style={position}>{content}</div>,document.body)}</>;
}
