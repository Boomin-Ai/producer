import {setActiveEndpointId} from '../lib/workspace';
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { ipc, type LiveRoom } from "../lib/ipc";
import studio3d from '../../docs/shows/grand-arena-3d-study.json';
import { LiveView } from "./Live";
/** Same room, picker and editor as the product, backed by isolated dev storage. */
export function SetsDevelopmentRoom() {
  const [room, setRoom] = useState<LiveRoom>(),
    [error, setError] = useState("");
  const smokeStarted = useRef(false);
  const studioStarted=useRef(false);
  const studio=import.meta.env.DEV&&import.meta.env.VITE_SCENE3D_STUDIO;
  useEffect(()=>{if(room&&studio&&import.meta.env.VITE_SCENE3D_STUDIO_PROOF==="1"&&!studioStarted.current){studioStarted.current=true;void import("../features/sets-v2/studioRoomProof").then(m=>m.studioRoomProof());}},[room,studio]);
  const scene3dStarted = useRef(false);
  const scene3d = import.meta.env.DEV && import.meta.env.VITE_SCENE3D_PROOF;
  useEffect(()=>{
    if(room && scene3d && !scene3dStarted.current){
      scene3dStarted.current=true;
      void import('../features/sets-v2/scene3dRoomProof').then(m=>m.scene3dRoomProof(JSON.parse(scene3d)));
    }
  },[room,scene3d]);
  useEffect(() => {
    void invoke<boolean>("live_set_v2_smoke_enabled").then(enabled=>{
      if(enabled && new URLSearchParams(location.search).has('roomApplyCheck') && !smokeStarted.current) { smokeStarted.current=true; void import('../features/sets-v2/roomSmoke').then(m=>m.roomApplyCheck()); }
      else if(enabled && !new URLSearchParams(location.search).has('roomInspect') && !smokeStarted.current) { smokeStarted.current=true; void import("../features/sets-v2/roomSmoke").then(m=>m.roomSmoke(new URLSearchParams(location.search).get('roomTiming')==='1',new URLSearchParams(location.search).get('roomResolution')==='1',new URLSearchParams(location.search).get('roomShowcase')==='1')); }
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const smoke = await invoke<boolean>("live_set_v2_smoke_enabled");
      const name = studio ? "Producer 3D Studio" : scene3d ? "Producer 3D GPU lab" : new URLSearchParams(location.search).has("roomColor") ? "Producer color check" : smoke ? "Producer dev smoke" : "Producer dev";
      const workspace=await invoke<{endpointId:string;serverRoomId:string;runProof?:boolean;moduleBindings:import('../../shared/set-runtime/contract').ModuleBindings}|null>('live_set_v2_dev_workspace');
      if(workspace)setActiveEndpointId(workspace.endpointId);
      const rooms = await ipc.liveListRooms();
      let room = rooms.filter(r=>r.name===name).sort((a,b)=>(b.config?.length??0)-(a.config?.length??0))[0] ?? (await ipc.liveCreateRoom(name));
      if(smoke){
        const config=JSON.parse(room.config||'{}');
        if(workspace){config.server_room_id=workspace.serverRoomId;if(config.presentation)config.presentation.moduleBindings={...config.presentation.moduleBindings,...workspace.moduleBindings};}
        if(studio){config.presentation={...config.presentation,package:studio3d,moduleBindings:{}};config.sizes={...config.sizes,bottom:420};}
        config.layout={top:[],left:['scenes','sources'],right:[],bottom:['setControls'],hidden:['guests','vote','mods','mixer','stats','dj','chat','channels','updates']};
        await ipc.liveUpdateRoom(room.id,{config:JSON.stringify(config)});
        room={...room,config:JSON.stringify(config)};
      }
      if (!cancelled){setRoom(room);if(workspace?.runProof)window.setTimeout(()=>void import('../features/sets-v2/weatherRoomProof').then(m=>m.weatherRoomProof()),1000);}
    })().catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);
  if (!room)
    return (
      <main className="shell">
        <div className="boot">{error || "Opening Producer dev…"}</div>
      </main>
    );
  return (
    <LiveView
      room={room}
      onLeave={() => location.assign('/')}
    />
  );
}
