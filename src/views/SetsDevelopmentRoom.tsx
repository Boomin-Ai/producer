import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { ipc, type LiveRoom } from "../lib/ipc";
import { LiveView } from "./Live";
/** Same room, picker and editor as the product, backed by isolated dev storage. */
export function SetsDevelopmentRoom() {
  const [room, setRoom] = useState<LiveRoom>(),
    [error, setError] = useState("");
  const smokeStarted = useRef(false);
  useEffect(() => {
    void invoke<boolean>("live_set_v2_smoke_enabled").then(enabled=>{
      if(enabled && !new URLSearchParams(location.search).has('roomInspect') && !smokeStarted.current) { smokeStarted.current=true; void import("../features/sets-v2/roomSmoke").then(m=>m.roomSmoke(new URLSearchParams(location.search).get('roomTiming')==='1',new URLSearchParams(location.search).get('roomResolution')==='1',new URLSearchParams(location.search).get('roomShowcase')==='1')); }
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const smoke = await invoke<boolean>("live_set_v2_smoke_enabled");
      const name = new URLSearchParams(location.search).has("roomColor") ? "Producer color check" : smoke ? "Producer dev smoke" : "Producer dev";
      const rooms = await ipc.liveListRooms();
      let room = rooms.filter(r=>r.name===name).sort((a,b)=>(b.config?.length??0)-(a.config?.length??0))[0] ?? (await ipc.liveCreateRoom(name));
      if(smoke){
        const config=JSON.parse(room.config||'{}');
        config.layout={top:[],left:['scenes','sources'],right:[],bottom:['setControls'],hidden:['guests','vote','mods','mixer','stats','dj','chat','channels','updates']};
        await ipc.liveUpdateRoom(room.id,{config:JSON.stringify(config)});
        room={...room,config:JSON.stringify(config)};
      }
      if (!cancelled) setRoom(room);
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
      onLeave={() =>
        void ipc.liveListRooms().then((rooms) => {
          const next = rooms.find((r) => r.id === room.id);
          if (next) setRoom(next);
        })
      }
    />
  );
}
