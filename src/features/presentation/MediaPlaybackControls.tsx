import {invoke,isTauri} from '@tauri-apps/api/core';
import {importAsset,type MediaAsset} from './assets';
import {useState,useSyncExternalStore} from 'react';
import type {RehearsalSession} from './rehearsal';
import {layoutMedia,mediaConfig,playable,type PlaybackConfig} from './playback';
export function MediaPlaybackControls({session,edit=false}:{session:RehearsalSession;edit?:boolean}){
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[selected,setSelected]=useState('');
 const load=async(id:string,file:File|undefined)=>{if(!file)return;setBusy(true);setError('');try{session.replaceMedia(id,await importAsset(file));}catch(e){setError(String(e));}finally{setBusy(false);}};
 const loadLocal=async(id:string)=>{setBusy(true);setError('');try{const asset=await invoke<MediaAsset|null>('set_media_import');if(asset)session.replaceMedia(id,asset);}catch(e){setError(String(e));}finally{setBusy(false);}};
 const state=useSyncExternalStore(session.subscribe,session.snapshot),doc=session.package;
 const ids=[...layoutMedia(doc,state.layoutId,false,state)].filter(id=>playable(doc.set.assets?.[id]?.mime??'')||mediaConfig(doc,id).hostControls);
 const visible=edit?ids:ids.filter(id=>mediaConfig(doc,id).hostControls);
 if(!visible.length)return null;
 return <section className={edit?'set-media-config':'set-media-transport'} aria-label={edit?'Media playback settings':'Media playback'}>
 {error&&<p role="alert">{error}</p>}
 {edit&&<h3>Media <span>{visible.length}</span></h3>}
 {!edit&&visible.length>1&&<select aria-label="Media player" value={visible.includes(selected)?selected:visible[0]} onChange={e=>setSelected(e.target.value)}>{visible.map(id=><option key={id} value={id}>{doc.set.assets![id].name}</option>)}</select>}
 {(edit?visible:[visible.includes(selected)?selected:visible[0]]).map(id=>{const c=mediaConfig(doc,id),t=state.media?.[id];const change=(key:keyof PlaybackConfig,value:string|boolean)=>session.configureMedia(id,{...c,[key]:value});
 return <div className="set-media-item" key={id}><strong title={doc.set.assets![id].name}>{doc.id==='ai-signal'&&id==='reaction-media'?'Reaction player':doc.set.assets![id].name}</strong>
 {edit&&<div className="set-media-options">
 <label>Start<select aria-label="Start" value={c.start} onChange={e=>change('start',e.target.value)}><option value="entry">On segment entry</option><option value="manual">Manual</option></select></label>
 <label>Playback<select aria-label="Playback" value={String(c.loop)} onChange={e=>change('loop',e.target.value==='true')}><option value="false">Once</option><option value="true">Loop</option></select></label>
 <label>On exit<select aria-label="On exit" value={c.exit} onChange={e=>change('exit',e.target.value)}><option value="reset">Stop and reset</option><option value="pause">Pause</option><option value="continue">Continue</option></select></label>
 <label>On return<select aria-label="On return" value={c.return} onChange={e=>change('return',e.target.value)}><option value="restart">Restart</option><option value="resume">Resume</option></select></label>
 <label className="set-media-toggle"><input type="checkbox" checked={c.hostControls} onChange={e=>change('hostControls',e.target.checked)}/>Show host controls</label>
 <small>Muted · Asset audio is not routed to the room mixer.</small>
 </div>}
 {isTauri()?<button disabled={busy} onClick={()=>void loadLocal(id)}>{busy?'Loading…':edit?'Load media':'Load'}</button>:<label className="set-media-load">{busy?'Loading…':edit?'Load media':'Load'}<input hidden aria-label={`Load media for ${doc.set.assets![id].name}`} type="file" accept="video/mp4,video/webm,video/quicktime,image/png,image/jpeg,image/webp,image/gif,.json" disabled={busy} onChange={e=>{void load(id,e.target.files?.[0]);e.target.value='';}}/></label>}
 {edit&&<small>{doc.set.assets![id].data.startsWith('producer-media:')?'Linked local file · no embedded upload limit':'Embedded asset · up to 12 MB. Producer’s Load media links full-length files.'}</small>}
 <div className="set-media-buttons"><button aria-label={t?.playing?'Pause media':'Play media'} title={t?.playing?'Pause media':'Play media'} disabled={!playable(doc.set.assets![id].mime)} onClick={()=>session.mediaCommand(id,t?.playing?'pause':'play')}>{edit?(t?.playing?'Pause media':'Play media'):(t?.playing?'Ⅱ':'▶')}</button><button aria-label="Stop media" title="Stop media" className="set-media-stop" disabled={!playable(doc.set.assets![id].mime)} onClick={()=>session.mediaCommand(id,'stop')}>{edit?'Stop media':'■'}</button><button disabled={!playable(doc.set.assets![id].mime)} aria-label="Restart media" title="Restart media" onClick={()=>session.mediaCommand(id,'restart')}>{edit?'Restart':'↻'}</button></div>
 </div>;})}</section>;
}
