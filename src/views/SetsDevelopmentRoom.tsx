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
      if(enabled && !smokeStarted.current) { smokeStarted.current=true; void import("../features/sets-v2/roomSmoke").then(m=>m.roomSmoke()); }
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const smoke = await invoke<boolean>("live_set_v2_smoke_enabled");
      const name = smoke ? "Producer dev smoke" : "Producer dev";
      const rooms = await ipc.liveListRooms();
      const room = rooms.find((r) => r.name === name) ?? (await ipc.liveCreateRoom(name));
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
