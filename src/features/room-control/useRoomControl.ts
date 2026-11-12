import {useEffect,useRef} from 'react';
import {registerRoomControl,type ControlSurface} from './runtime';

/** Live closures without a second state owner or media-frame serialization. */
export function useRoomControl(name:string,roomId:string|undefined,enabled:boolean,snapshot:()=>unknown,commands:ControlSurface['commands'],hostAssistant=false) {
  const latest=useRef({snapshot,commands});latest.current={snapshot,commands};
  const catalog=Object.keys(commands).sort().join('|');
  useEffect(()=>{
    if(!enabled||!hostAssistant&&(!import.meta.env.DEV||import.meta.env.VITE_ROOM_CLI!=='1'))return;
    const surface:ControlSurface={epoch:crypto.randomUUID(),roomId,snapshot:()=>latest.current.snapshot(),commands:Object.fromEntries(Object.keys(commands).map(key=>[key,args=>latest.current.commands[key](args)]))};
    return registerRoomControl(name,surface);
  },[name,roomId,enabled,catalog,hostAssistant]);
}
