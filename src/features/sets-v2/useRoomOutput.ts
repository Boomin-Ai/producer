import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ipc, type LiveSources } from "../../lib/ipc";
import type { RehearsalSession } from "../presentation/rehearsal";
import {
  setOutputProjection,
  type SetOutputControls,
} from "../presentation/useSetOutput";
import type { SlotFraming } from "../presentation/schema";
import { AssetTransport } from "../presentation/assetTransport";
import {authoredCrossfadeMs} from '../presentation/animation';
import { compileRoomScene } from "./roomCompiler";
type NativeStatus = {
  generation: number;
  preparedRevision: number;
  renderedRevision: number;
  ready: boolean;
  warmed: boolean;
  queued: boolean;
  transitioning: boolean;
  renderSerial: number;
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Normal room controls consume this adapter; engineering lab controls do not
 * participate. A failed preparation retains the previously rendered native set. */
export function useRoomOutput(
  session: RehearsalSession,
  roomId: string | null,
  sources: LiveSources,
  enabled: boolean,
  initialBindings: Record<string, string>,
  onBindings?: (b: Record<string, string>) => void,
  initialFraming: Record<string, SlotFraming> = {},
  onFraming?: (f: Record<string, SlotFraming>) => void,
): SetOutputControls {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const [bindings, setBindings] = useState(initialBindings),
    [framing, setFraming] = useState(initialFraming);
  const [pendingChange, setPendingChange] = useState<"set" | "segment" | "content">("content");
  const shownSelection = useRef({definition: "", layout: "", phase: ""});
  const [active, setActive] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [selectToShow, setSelectToShow] = useState(
    () => localStorage.getItem("producer.sets.selection") !== "edit",
  );
  const latest = useRef({
    session,
    roomId,
    sources,
    enabled,
    bindings,
    framing,
  });
  latest.current = { session, roomId, sources, enabled, bindings, framing };
  const media = useRef(new AssetTransport());
  const portraitRevision = useRef(0), portraitOperation = useRef(0), portraitShownLayout=useRef("");
  const revision = useRef(0),
    generation = useRef(0),
    operation = useRef(0),
    flight = useRef(false),
    confirmed = useRef(""),
    shownLayout = useRef(""),
    alive = useRef(true),
    currentRoom = useRef(roomId),
    isActive = useRef(false);
  const request = (value: Record<string, unknown>) =>
    invoke<NativeStatus>("live_set_v2", {
      request: { generation: generation.current, ...value },
    });
  const project = () => {
    const current = latest.current,
      p = setOutputProjection(current.session, 1);
    const visit = (n: typeof p.root) => {
      if (n.slotId && current.framing[n.slotId])
        n.framing = current.framing[n.slotId];
      n.children.forEach(visit);
    };
    visit(p.root);
    return p;
  };
  const signature = (p = project(), current = latest.current) => {
    return JSON.stringify({
      root: p.root,
      assets: media.current.signature(p).assets,
      tracks: p.timeline?.tracks,
      bindings: current.bindings,
      framing: current.framing,
    });
  };
  const apply = async () => {
    if (!latest.current.enabled || flight.current) return;
    const ticket = ++operation.current,
      current = latest.current;
    flight.current = true;
    const snapshot = current.session.snapshot();
    const selection = {definition: current.session.package.id, layout: snapshot.layoutId, phase: snapshot.show.phase};
    const previous = shownSelection.current;
    setPendingChange(previous.definition !== selection.definition ? "set" : previous.layout !== selection.layout || previous.phase !== selection.phase ? "segment" : "content");
    setBusy(true);
    setError("");
    let attempted = 0;
    const started=performance.now();
    const timing=(stage:string,extra:Record<string,unknown>={})=>{if(import.meta.env.DEV)window.dispatchEvent(new CustomEvent('producer:set-render-timing',{detail:{stage,at:performance.now(),elapsedMs:performance.now()-started,definition:selection.definition,layout:selection.layout,phase:selection.phase,revision:attempted,...extra}}));};
    timing('apply-start');
    try {
      const room = await ipc.liveSetStatus();
      generation.current = room.generation;
      const engine = await ipc.liveEngineStatus();
      if (ticket !== operation.current) return;
      const prior = await request({ op: "status" }).catch(() => ({preparedRevision: 0, renderedRevision: 0}));
      revision.current = Math.max(revision.current, prior.preparedRevision, prior.renderedRevision);
      const full = project();
      const fingerprint = signature(full, current);
      const layout = current.session.snapshot().layoutId;
      const p = media.current.compact(full);
      p.revision = ++revision.current;
      attempted = revision.current;
      const height = engine.video_height ?? 720,
        width = Math.round((height * 16) / 9);
      timing('compile-start');
      const plan = await compileRoomScene(p, {
        definitionId: current.session.package.id,
        instanceId: "room-" + (current.roomId ?? "local").slice(0, 50),
        canvasId: current.session.snapshot().layoutId,
        target: {
          id: "program",
          orientation: "landscape",
          width,
          height,
          scaling: "contain",
        },
        bindings: current.bindings,
      });
      if (ticket !== operation.current) return;
      timing('compile-done');
      await request({ op: "prepare", revision: attempted, plan });
      timing('prepare-submitted');
      for (let i = 0; i < 500; i++) {
        if (ticket !== operation.current) {
          await request({ op: "cancel", revision: attempted }).catch(() => {});
          return;
        }
        const status = await request({ op: "status" });
        if (status.preparedRevision !== attempted)
          throw Error("Set preparation was replaced");
        if (status.ready && status.warmed) {timing('ready-warmed');break;}
        if (i === 499)
          throw Error(
            "The next set is still preparing. The current output is retained.",
          );
        await sleep(25);
      }
      if (ticket !== operation.current) return;
      const transition =
        authoredCrossfadeMs(full.timeline?.transition,isActive.current&&(shownSelection.current.definition!==selection.definition||shownLayout.current!==layout),snapshot.paused);
      timing('take-request',{transitionMs:transition});
      await request({
        op: "take",
        revision: attempted,
        durationMs: transition,
        mode: "dissolve",
      });
      let sawTransition=false;
      for (let i = 0; i < 200; i++) {
        const status = await request({ op: "status" });
        if(status.transitioning&&!sawTransition){sawTransition=true;timing('transition-first-observed',{renderSerial:status.renderSerial});}
        if (status.renderedRevision === attempted && !status.transitioning) {
          timing('render-complete',{renderSerial:status.renderSerial});
          if (!alive.current || current.roomId !== latest.current.roomId)
            return;
          media.current.acknowledge(full);
          confirmed.current = fingerprint;
          shownLayout.current = layout;
          shownSelection.current = selection;
          isActive.current = true;
          setActive(true);
          return;
        }
        if (i === 199)
          throw Error(
            "Set rendering did not confirm. The current output is retained.",
          );
        await sleep(20);
      }
    } catch (e) {
      timing('error',{error:String(e)});
      if (attempted)
        await request({ op: "cancel", revision: attempted }).catch(() => {});
      if (alive.current && ticket === operation.current) setError(String(e));
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const returnToRoom = async () => {
    ++operation.current;
    ++portraitOperation.current;
    try {
      const status = await request({ op: "return" });
      generation.current = status.generation;
      isActive.current = false;
      setActive(false);
      // A deliberate return stays on the room until content or selection changes.
      confirmed.current = signature();
      shownLayout.current = "";
      media.current.clear();
      setError("");
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  };
  useEffect(() => {
    ++operation.current;
    ++portraitOperation.current;
    setError("");
  }, [session]);
  useEffect(() => {
    setError("");
  }, [
    bindings,
    framing,
    state.layoutId,
    JSON.stringify(state.values),
    JSON.stringify(state.feeds),
  ]);
  useEffect(() => {
    alive.current = true;
    if (currentRoom.current !== roomId) {
      currentRoom.current = roomId;
      setBindings(initialBindings);
      setFraming(initialFraming);
      isActive.current = false;
      setActive(false);
      confirmed.current = "";
      setError("");
    }
    return () => {
      alive.current = false;
      ++operation.current;
    };
  }, [roomId]);
  useEffect(() => {
    if (!enabled || busy || error) return;
    // Changes to the selected set flow through the same normal Show/Next controls.
    // Choosing an unconfigured set opens its existing source editor first.
    if (!active && !(selectToShow && Object.keys(bindings).length)) return;
    let fingerprint: string;
    try {
      fingerprint = signature();
    } catch (e) {
      setError(String(e));
      return;
    }
    if (fingerprint === confirmed.current) return;
    const timer = setTimeout(() => void apply(), 40);
    return () => clearTimeout(timer);
  }, [
    enabled,
    busy,
    error,
    active,
    selectToShow,
    state,
    session,
    bindings,
    framing,
  ]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(
      () =>
        void request({ op: "pause", paused: !!state.paused }).catch(() => {}),
      0,
    );
    return () => clearTimeout(timer);
  }, [enabled, state.paused]);
  const applyPortrait = async (
    projection: import("../presentation/projection").OutputProjection,
    layoutId?:string,
  ) => {
    const current = latest.current;
    const portraitKey=current.session.package.id+":"+(layoutId??current.session.snapshot().layoutId);
    const ticket = ++portraitOperation.current;
    const room = await ipc.liveSetStatus();
    generation.current = room.generation;
    const engine = await ipc.liveEngineStatus();
    const width = engine.video_height ?? 720,
      height = Math.round((width * 16) / 9);
    const send = (value: Record<string, unknown>) => {
      if (ticket !== portraitOperation.current || !alive.current) throw Error("Portrait selection changed");
      return invoke<NativeStatus>("live_set_v2", {request: {generation: room.generation, ...value, outputId: "portrait"}});
    };
    const status = await send({ op: "status" }).catch(() => undefined);
    portraitRevision.current =
      Math.max(
        portraitRevision.current,
        status?.preparedRevision ?? 0,
        status?.renderedRevision ?? 0,
      ) + 1;
    const candidate = portraitRevision.current;
    projection.revision = candidate;
    const plan = await compileRoomScene(projection, {
      definitionId: current.session.package.id,
      instanceId: "room-" + (current.roomId ?? "local").slice(0, 50),
      canvasId: layoutId??current.session.snapshot().layoutId,
      target: {
        id: "portrait",
        orientation: "portrait",
        width,
        height,
        scaling: "contain",
      },
      bindings: current.bindings,
    });
    await send({ op: "prepare", revision: candidate, plan });
    for (let i = 0; i < 500; i++) {
      const state = await send({ op: "status" });
      if (state.ready && state.warmed) break;
      if (i === 499) throw Error("Portrait is still preparing");
      await sleep(25);
    }
    await send({
      op: "take",
      revision: candidate,
      durationMs: authoredCrossfadeMs(projection.timeline?.transition,!!status?.renderedRevision&&portraitShownLayout.current!==portraitKey,!!current.session.snapshot().paused),
      mode: "dissolve",
    });
    for (let i = 0; i < 200; i++) {
      const state = await send({ op: "status" });
      if (
        state.renderedRevision === candidate &&
        !state.transitioning
      ) { portraitShownLayout.current=portraitKey; return; }
      if (i === 199) throw Error("Portrait did not confirm its rendered frame");
      await sleep(20);
    }
  };
  return {
    renderer: "native",
    applyPortrait,
    stopPortrait: async () => {
      ++portraitOperation.current;
      await request({ op: "return", outputId: "portrait" });
    },
    selectToShow,
    setSelectToShow: (value) => {
      localStorage.setItem("producer.sets.selection", value ? "show" : "edit");
      setSelectToShow(value);
    },
    active,
    busy,
    pendingChange,
    error,
    bindings,
    framing,
    sources,
    apply,
    returnToRoom,
    bind: (slot, source) => {
      const next = { ...latest.current.bindings };
      if (source) next[slot] = source;
      else delete next[slot];
      latest.current.bindings=next;
      setBindings(next);
      setError("");
      onBindings?.(next);
    },
    frame: (slot, value) => {
      const next = { ...latest.current.framing, [slot]: value };
      latest.current.framing=next;
      setFraming(next);
      setError("");
      onFraming?.(next);
    },
  };
}
