// A MOD SEAT (#47): this Producer opened someone else's mod link on an open
// server. A control seat, not a show — no engine, no sources, nothing on the
// set. The roster (admit / remove / stage / order) goes through the server
// with the mod code as the credential; scene cuts travel as frames on the
// room's control channel and land in the host's Producer as if the host had
// pressed the scene. The server is the gate; `grants` only hides.
import { useCallback, useEffect, useRef, useState } from "react";
import { modSeat, type ModLink } from "../lib/modSeat";
import { RoomControlLink, type ControlFrame, type SceneStateFrame } from "../lib/roomControl";
import { moveInOrder, seatAccessFrom } from "../lib/participants";
import { RoleCard } from "./RoleCard";
import type { RoomGuest } from "../lib/ipc";
import { GuestPanel } from "./Live";
import { ModBoard } from "./ModBoard";
import { DEFAULT_MOD_BOARD, MOD_BOARD_PREF, normalizeModBoard, seatFeeds, throwUpState, type ModBoardLayout } from "../lib/modBoard";
import { prefGet } from "../lib/prefs";
import { EMPTY_MOD_STAGE, type ModStageState } from "../lib/stageTruth";

export function ModSeat({ link, onLeave }: { link: ModLink; onLeave: () => void }) {
  const [title, setTitle] = useState<string>("Room");
  const [grants, setGrants] = useState<Set<string>>(new Set());
  const [roster, setRoster] = useState<RoomGuest[]>([]);
  const [stage, setStage] = useState<string[]>([]);
  const [scenes, setScenes] = useState<SceneStateFrame | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [gone, setGone] = useState(false);
  const controlRef = useRef<RoomControlLink | null>(null);
  /** The board's own layout (lib/modBoard.ts) — the same pref a Boomin seat saves. */
  const [boardLayout, setBoardLayout] = useState<ModBoardLayout>(DEFAULT_MOD_BOARD);
  useEffect(() => {
    let alive = true;
    prefGet(MOD_BOARD_PREF)
      .then((v) => alive && setBoardLayout(normalizeModBoard(v)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const rosterRef = useRef<RoomGuest[]>([]);
  rosterRef.current = roster;
  const stageRef = useRef<string[]>([]);
  stageRef.current = stage;

  const fail = useCallback((e: unknown) => {
    const msg = String(e).replace(/^Error:\s*/, "");
    setErr(msg);
    if (/revoked|not valid/i.test(msg)) setGone(true);
  }, []);

  // Bootstrap + the roster poll (3 s, like the host's).
  useEffect(() => {
    let alive = true;
    const boot = async () => {
      try {
        const b = await modSeat.bootstrap(link);
        if (!alive) return;
        setTitle(b.room.title ?? "Room");
        setGrants(new Set(b.grants));
        setStage(b.stage.on_stage);
        setErr(null);
      } catch (e) {
        fail(e);
      }
    };
    const tick = async () => {
      try {
        const r = await modSeat.roster(link);
        if (!alive) return;
        setRoster(r.guests ?? []);
        setStage(r.stage?.on_stage ?? []);
        setErr(null);
      } catch (e) {
        fail(e);
      }
    };
    void boot().then(tick);
    const t = window.setInterval(() => void tick(), 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [link, fail]);

  // The control channel: scene list in, cuts out.
  useEffect(() => {
    const c = new RoomControlLink({
      origin: link.origin,
      session: () => modSeat.session(link),
      onFrame: (f: ControlFrame) => {
        if (f.type === "scene.state") setScenes(f as SceneStateFrame);
        else if (f.type === "error") {
          const e = f as { code: string; status?: number };
          setErr(e.code === "forbidden" ? "This seat can't cut scenes." : e.code === "unknown_scene" ? "That scene is gone." : e.code);
          window.setTimeout(() => setErr(null), 3000);
        }
      },
      onOpen: () => setOnline(true),
      onClose: () => setOnline(false),
    });
    controlRef.current = c;
    c.start();
    return () => {
      c.stop();
      controlRef.current = null;
    };
  }, [link]);

  const can = (g: string) => grants.has(g);
  // The same card a Boomin room shows — the seat's grants as one DTO.
  const access = seatAccessFrom(grants);
  const cut = useCallback((sceneId: string) => {
    if (!controlRef.current?.cut(sceneId)) setErr("Not connected to the room yet.");
  }, []);

  // ⌘1–9 cut, mirroring the host's chords. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || !scenes || !can("room.scene")) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const sc = scenes.scenes[n - 1];
      if (!sc) return;
      e.preventDefault();
      cut(sc.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const stageToggle = async (guestId: string) => {
    const cur = stageRef.current;
    const next = cur.includes(guestId) ? cur.filter((x) => x !== guestId) : [...cur, guestId];
    setStage(next);
    try {
      const r = await modSeat.setStage(link, next);
      setStage(r.on_stage);
    } catch (e) {
      setStage(cur);
      fail(e);
    }
  };
  const order = async (guestId: string, dir: -1 | 1) => {
    const admitted = rosterRef.current
      .filter((g) => !!g.render_url)
      .sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9))
      .map((g) => g.id);
    const next = moveInOrder(admitted, guestId, dir);
    setRoster((rs) => rs.map((g) => ({ ...g, position: next.indexOf(g.id) })));
    await modSeat.order(link, next).catch(fail);
  };

  if (gone) {
    return (
      <div className="modseat">
        <header className="rm-top" data-tauri-drag-region>
          <button className="rm-leave" onClick={onLeave} title="Back">←</button>
          <span className="modseat-title">Mod seat</span>
        </header>
        <div className="modseat-gone">This mod link is no longer valid. Ask the host for a new one.</div>
      </div>
    );
  }

  // The open server's stage list IS the truth here (no honest-staging
  // frames on this line yet): confirmed = the server's list, nothing pending.
  const stageState: ModStageState = { ...EMPTY_MOD_STAGE, confirmed: stage };
  // A mod link carries no media: the feed windows say so, the throw-up is off.
  return (
    <div className="modseat">
      <header className="rm-top" data-tauri-drag-region>
        <button className="rm-leave" onClick={onLeave} title="Leave the seat">←</button>
        <span className="modseat-title">{title}</span>
        <RoleCard access={access} host={new URL(link.origin).host} compact />
        <span className={`modseat-dot${online ? " on" : ""}`} title={online ? "Connected to the room" : "Reconnecting…"} />
      </header>
      {/* The same board a Boomin seat gets (views/ModBoard.tsx), on the open
        * server's data: scene pads off the control channel, the roster off
        * the mod code, no return feed and no media (a mod link carries neither). */}
      <ModBoard
        title={title}
        access={access}
        host={new URL(link.origin).host}
        pending={false}
        boomin={false}
        online={online}
        program={null}
        scenes={scenes ? { scenes: scenes.scenes, active_scene_id: scenes.active_scene_id } : null}
        onCut={cut}
        people={
          <GuestPanel
            thumbs={{}}
            roster={roster}
            error={null}
            items={[]}
            role={can("room.admit") || can("room.stage") || can("room.remove") ? "mod" : "viewer"}
            stage={stage}
            stageState={stageState}
            onAdmit={(id) => void modSeat.admit(link, id).catch(fail)}
            onRemove={(id) => void modSeat.remove(link, id).catch(fail)}
            onMute={() => {}}
            onShow={() => {}}
            onStageToggle={(id) => void stageToggle(id)}
            onOrder={(id, dir) => void order(id, dir)}
          />
        }
        grants={grants}
        feeds={seatFeeds(grants)}
        media={null}
        throwUp={throwUpState({ stage: stageState, seatId: null, grants, canAsk: can("room.stage") })}
        onThrowUp={() => {}}
        layout={boardLayout}
        error={err}
      />
    </div>
  );
}
