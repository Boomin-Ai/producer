import {useCallback,useEffect,useRef,useState} from 'react';
import {ipc} from '../../lib/ipc';
import {clips,clipsError,DEFAULT_CLIPS,OFF_CLIPS,validateClipSettings,type ClipSettings,type ClipStatus,type SavedClip} from './clips';

/** Room-owned, not panel-owned: hiding a dock never discards the buffer.
 * Leaving the room does. Native room release is the final ownership fence. */
export function useClips(roomId:string,ready:boolean,visible:boolean,observed:boolean) {
 const [settings,setSettings]=useState<ClipSettings>(DEFAULT_CLIPS);
 const [capture,setCapture]=useState<ClipStatus>(OFF_CLIPS);
 const [recent,setRecent]=useState<SavedClip[]>([]);
 const [directory,setDirectory]=useState('');
 const [error,setError]=useState('');
 const [pending,setPending]=useState<'capture'|'save'|'folder'|null>(null);
 const state=useRef({roomId,ready,visible,capture,settings});state.current={roomId,ready,visible,capture,settings};
 const operation=useRef(false),alive=useRef(true),generation=useRef(0),preferences=useRef(Promise.resolve());
 const current=()=>alive.current&&state.current.roomId===roomId;
 const refresh=useCallback(async()=>{
  if(state.current.roomId!==roomId)return;const epoch=generation.current;const [status,list]=await Promise.all([clips.status(roomId),clips.list(roomId)]);
  if(!alive.current||state.current.roomId!==roomId||epoch!==generation.current)return;
  setCapture(status.capture);setDirectory(status.directory);setRecent(list);
  if(status.capture.enabled||status.capture.saving)setSettings(status.capture.settings);
  if(status.capture.error)setError(status.capture.error);return {capture:status.capture,recent:list};
 },[roomId]);
 useEffect(()=>{alive.current=true;++generation.current;return()=>{alive.current=false;++generation.current;if(state.current.capture.enabled||state.current.capture.saving)void clips.disable(roomId).catch(()=>{});};},[roomId]);
 useEffect(()=>{let dead=false;void ipc.prefGet(`clips.settings.${roomId}`).then(value=>{if(!dead&&value&&!state.current.capture.enabled){try{setSettings(validateClipSettings(JSON.parse(value)))}catch{/* Ignore invalid old preferences. */}}}).catch(()=>{});return()=>{dead=true;};},[roomId]);
 useEffect(()=>{if(!ready||!visible||!observed)return;void refresh().catch(e=>{if(current())setError(clipsError(e));});},[ready,visible,observed,refresh]);
 useEffect(()=>{if(!ready||!visible||(!capture.enabled&&!capture.saving))return;let dead=false;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{await refresh()}catch(e){if(!dead)setError(clipsError(e))}if(!dead)timer=setTimeout(poll,1000);};timer=setTimeout(poll,1000);return()=>{dead=true;clearTimeout(timer);};},[ready,visible,capture.enabled,capture.saving,refresh]);
 useEffect(()=>{if(visible)return;if(state.current.capture.enabled||state.current.capture.saving)void clips.disable(roomId).then(status=>{if(alive.current)setCapture(status)}).catch(e=>{if(alive.current)setError(clipsError(e))});},[visible,roomId]);
 const act=async<T,>(kind:NonNullable<typeof pending>,run:()=>Promise<T>):Promise<T>=>{
  if(operation.current)throw Error('Wait for the current Clips action.');
  if(!state.current.ready||!state.current.visible)throw Error('Open the room before using Clips.');
  operation.current=true;const epoch=generation.current;setPending(kind);setError('');
  try{return await run()}catch(e){if(alive.current&&epoch===generation.current)setError(clipsError(e));throw e}finally{operation.current=false;if(alive.current&&epoch===generation.current)setPending(null);}
 };
 const configure=async(value:ClipSettings)=>{
  if(state.current.capture.enabled||state.current.capture.saving||operation.current)throw Error('Stop rolling capture before changing its settings.');
  const valid=validateClipSettings(value);setSettings(valid);state.current.settings=valid;preferences.current=preferences.current.catch(()=>{}).then(()=>ipc.prefSet(`clips.settings.${roomId}`,JSON.stringify(valid))).then(()=>{});await preferences.current;return valid;
 };
 const setEnabled=(on:boolean)=>act('capture',async()=>{if(on&&state.current.capture.error)await clips.disable(roomId);const status=on?await clips.enable(roomId,state.current.settings):await clips.disable(roomId);if(current()){if(!state.current.visible&&status.enabled){await clips.disable(roomId);setCapture(OFF_CLIPS);}else setCapture(status);}return status;});
 const toggle=()=>setEnabled(!state.current.capture.enabled);
 const save=()=>act('save',async()=>{const result=await clips.save(roomId);await refresh();return result;});
 const chooseFolder=()=>act('folder',async()=>{const path=await clips.pickDirectory();if(path&&current())setDirectory(path);return path;});
 return {capture,settings,recent,directory,error,pending,ready,refresh,configure,setEnabled,toggle,save,chooseFolder};
}
export type ClipsController=ReturnType<typeof useClips>;
