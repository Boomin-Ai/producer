import atmosphereSet from '../../docs/shows/atmosphere.json';
import {dataIntegrations} from '../lib/dataIntegrations';
import {guests} from '../lib/ipc';
import factsShow from '../../docs/shows/just-facts.json';
import {parsePackage} from '../features/presentation/schema';
import {upgradeJustFacts,upgradeJustFactsShow} from '../features/presentation/upgradeJustFacts';
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
  const bootstrap=useRef<Promise<LiveRoom>|undefined>(undefined);
  const smokeStarted = useRef(false);
  const studioStarted=useRef(false);
  const atmosphere=import.meta.env.DEV&&import.meta.env.VITE_ATMOSPHERE_STUDIO==='1';
  const studio=!atmosphere&&import.meta.env.DEV&&import.meta.env.VITE_SCENE3D_STUDIO;
  useEffect(()=>{if(room&&studio&&import.meta.env.VITE_SCENE3D_STUDIO_PROOF==="1"&&!studioStarted.current){studioStarted.current=true;void import("../features/sets-v2/studioRoomProof").then(m=>m.studioRoomProof());}},[room,studio]);
  const weatherStarted=useRef(false);
  useEffect(()=>{if(room&&import.meta.env.DEV&&import.meta.env.VITE_ATMOSPHERE_PROOF==='1'&&!weatherStarted.current){weatherStarted.current=true;void import('../features/sets-v2/atmosphereRoomProof').then(m=>m.atmosphereRoomProof());}},[room]);
  const navigationStarted=useRef(false);
  useEffect(()=>{if(room&&import.meta.env.DEV&&import.meta.env.VITE_NAVIGATION_LIFETIME_PROOF==='1'&&!navigationStarted.current){navigationStarted.current=true;void import('../features/sets-v2/navigationLifetimeProof').then(m=>m.navigationLifetimeProof());}},[room]);
  const viewCacheStarted=useRef(false);
  useEffect(()=>{if(room&&import.meta.env.DEV&&import.meta.env.VITE_VIEW_CACHE_PROOF==='1'&&!viewCacheStarted.current){viewCacheStarted.current=true;void import('../features/sets-v2/viewCacheRoomProof').then(m=>m.viewCacheRoomProof());}},[room]);
  const designStarted=useRef(false);
  useEffect(()=>{if(room&&import.meta.env.DEV&&import.meta.env.VITE_ATMOSPHERE_DESIGN_PROOF==='1'&&!designStarted.current){designStarted.current=true;void import('../features/sets-v2/atmosphereDesignProof').then(m=>m.atmosphereDesignProof());}},[room]);
  const factsStarted=useRef(false);
  useEffect(()=>{if(room&&import.meta.env.DEV&&import.meta.env.VITE_JUST_FACTS_PROOF==='1'&&!factsStarted.current){factsStarted.current=true;void import('../features/sets-v2/justFactsRoomProof').then(m=>m.justFactsRoomProof());}},[room]);
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
      else if(enabled && !studio && !new URLSearchParams(location.search).has('roomInspect') && !smokeStarted.current) { smokeStarted.current=true; void import("../features/sets-v2/roomSmoke").then(m=>m.roomSmoke(new URLSearchParams(location.search).get('roomTiming')==='1',new URLSearchParams(location.search).get('roomResolution')==='1',new URLSearchParams(location.search).get('roomShowcase')==='1')); }
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    bootstrap.current??=(async () => {
      const smoke = await invoke<boolean>("live_set_v2_smoke_enabled");
      const name = atmosphere ? "Atmosphere Studio" : studio ? "Producer 3D Studio" : scene3d ? "Producer 3D GPU lab" : new URLSearchParams(location.search).has("roomColor") ? "Producer color check" : smoke ? "Producer dev smoke" : "Producer dev";
      const workspace=await invoke<{endpointId:string;serverRoomId:string;runProof?:boolean;moduleBindings:import('../../shared/set-runtime/contract').ModuleBindings}|null>('live_set_v2_dev_workspace');
      if(workspace)setActiveEndpointId(workspace.endpointId);
      const rooms = await ipc.liveListRooms();
      let room = rooms.filter(r=>r.name===name).sort((a,b)=>(b.config?.length??0)-(a.config?.length??0))[0] ?? (await ipc.liveCreateRoom(name));
      if(atmosphere&&workspace){
        const config=JSON.parse(room.config||'{}');
        if(config.presentation?.package?.id===atmosphereSet.id&&JSON.stringify(config.presentation.package)!==JSON.stringify(atmosphereSet)){config.presentation.package=atmosphereSet;await ipc.liveUpdateRoom(room.id,{config:JSON.stringify(config)});room={...room,config:JSON.stringify(config)};}
        if(!config.presentation?.package){
          // Reuse one existing camera binding without adding duplicate sources.
          const previous=rooms.filter(r=>r.name==='Producer 3D Studio').sort((a,b)=>(b.config?.length??0)-(a.config?.length??0))[0];
          const prior=JSON.parse(previous?.config||'{}'),host=prior.presentation?.bindings?.host;
          const camera=prior.sources?.extras?.find((s:{id:string})=>s.id===host);
          const remote=await guests.request(workspace.endpointId,'POST','/v1/app/live/rooms',{title:name,external_ref:room.id});
          const saved=await dataIntegrations.list(workspace.endpointId),weather=saved.connections.find(c=>c.connection.kind==='weather');
          Object.assign(config,{server_room_id:(remote.body as {room:{id:string}}).room.id,sources:{extras:camera?[camera]:[]},sizes:{bottom:420},layout:{top:[],left:['scenes','sources'],right:[],bottom:['setControls'],hidden:['guests','vote','mods','mixer','stats','dj','chat','channels','updates']},presentation:{package:atmosphereSet,bindings:host?{host}:{},framing:prior.presentation?.framing??{},moduleBindings:weather?{weather:{id:weather.connection.id,revision:weather.revision}}:{}}});
          await ipc.liveUpdateRoom(room.id,{config:JSON.stringify(config)});room={...room,config:JSON.stringify(config)};
        }
      }
      if(atmosphere&&import.meta.env.VITE_ATMOSPHERE_DESIGN_PROOF==='1'){const config=JSON.parse(room.config||'{}');config.sizes={...config.sizes,bottom:420};await ipc.liveUpdateRoom(room.id,{config:JSON.stringify(config)});room={...room,config:JSON.stringify(config)};}
      // This isolated study was previously saved as 0.1 (lighting only).
      // Upgrade that exact fixture on a normal reopen as well as in proof mode;
      // preserve room bindings/framing and authored text defaults.
      if(studio){
        const upgrade=(previous:typeof studio3d)=>({
          ...structuredClone(studio3d),
          set:{...structuredClone(studio3d.set),values:{...studio3d.set.values,...previous.set.values}},
        });
        const config=JSON.parse(room.config||'{}');
        const previous=config.presentation?.package;
        if(previous?.id===studio3d.id&&previous.version==='0.1.0'){
          config.presentation={...config.presentation,package:upgrade(previous)};
          await ipc.liveUpdateRoom(room.id,{config:JSON.stringify(config)});
          room={...room,config:JSON.stringify(config)};
        }
        if(previous?.id==='just-facts'&&['1.0.0','1.0.1'].includes(previous.version)){
          config.presentation={...config.presentation,package:parsePackage(upgradeJustFactsShow(upgradeJustFacts(previous),parsePackage(factsShow)))};
          await ipc.liveUpdateRoom(room.id,{config:JSON.stringify(config)});
          room={...room,config:JSON.stringify(config)};
        }
        for(const entry of await ipc.setLibraryList()){
          if(entry.id==='just-facts'){
            const saved=JSON.parse(await ipc.setLibraryRead(entry.file));
            if(['1.0.0','1.0.1'].includes(saved.version))await ipc.setLibrarySave(JSON.stringify(parsePackage(upgradeJustFactsShow(upgradeJustFacts(saved),parsePackage(factsShow)))));
          }
          if(entry.id!==studio3d.id)continue;
          const saved=JSON.parse(await ipc.setLibraryRead(entry.file));
          if(saved.version==='0.1.0')await ipc.setLibrarySave(JSON.stringify(upgrade(saved)));
        }
      }
      if(smoke&&!new URLSearchParams(location.search).has('roomInspect')){
        const config=JSON.parse(room.config||'{}');
        if(workspace){config.server_room_id=workspace.serverRoomId;if(config.presentation)config.presentation.moduleBindings={...config.presentation.moduleBindings,...workspace.moduleBindings};}
        if(studio){config.presentation={...config.presentation,package:studio3d,moduleBindings:{}};config.sizes={...config.sizes,bottom:420};}
        config.layout={top:[],left:['scenes','sources'],right:[],bottom:['setControls'],hidden:['guests','vote','mods','mixer','stats','dj','chat','channels','updates']};
        await ipc.liveUpdateRoom(room.id,{config:JSON.stringify(config)});
        room={...room,config:JSON.stringify(config)};
      }
      if(workspace?.runProof)window.setTimeout(()=>void import('../features/sets-v2/weatherRoomProof').then(m=>m.weatherRoomProof()),1000);
      return room;
    })();
    void bootstrap.current.then(room=>{if(!cancelled)setRoom(room);}).catch(e=>{if(!cancelled)setError(String(e));});
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
