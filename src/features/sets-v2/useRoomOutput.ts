import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ipc, listenLiveEvents, type LiveSources } from "../../lib/ipc";
import {
  setOutputProjection,
  type SetOutputControls,
} from "../presentation/useSetOutput";
import type { SlotFraming } from "../presentation/schema";
import { AssetTransport } from "../presentation/assetTransport";
import {authoredCrossfadeMs} from '../presentation/animation';
import {PreparedScenes,layoutProjections,morphTargets,runtimePlan,type SceneSpec,type NativeSceneStatus} from './preparedScenes';
import {RehearsalSession} from '../presentation/rehearsal';
type NativeStatus = NativeSceneStatus & {
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
  const deliberatelyHidden=useRef(false);
  useEffect(()=>{deliberatelyHidden.current=false;},[session.package.id,roomId]);
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
  const portraitOperation = useRef(0), portraitShownLayout=useRef("");
  const cacheGeneration=useRef<number|undefined>(undefined);
  const generation = useRef(0),
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
  const [preparationVersion,notifyPreparation]=useState(0);
  const [canvas,setCanvas]=useState({width:1280,height:720});
  const canvasRef=useRef(canvas);
  const canvasReadyRoom=useRef<string|null|undefined>(undefined);
  const [canvasReady,setCanvasReady]=useState(false);
  const waitForCanvas=async()=>{
    const waitingRoom=latest.current.roomId;
    for(let i=0;i<600;i++){
      if(!alive.current||!latest.current.enabled||latest.current.roomId!==waitingRoom)return false;
      if(canvasReadyRoom.current===latest.current.roomId)return true;
      await sleep(25);
    }
    throw Error('Room canvas settings are not ready');
  };
  const [draftCandidate,setDraftCandidate]=useState<{doc:import('../presentation/schema').PresentationPackage;bindings:Record<string,string>;framing:Record<string,SlotFraming>}>();
  const [retryVersion,setRetryVersion]=useState(0);
  const bank=useRef<PreparedScenes|null>(null);
  const scene3dCapability=useRef<Promise<boolean>|undefined>(undefined);
  const invalidateRoom=()=>{
    ++operation.current;++portraitOperation.current;
    confirmed.current="";shownLayout.current="";portraitShownLayout.current="";
    isActive.current=false;setError("");
    bank.current?.reset();setRetryVersion(v=>v+1);
  };
  if(!bank.current)bank.current=new PreparedScenes(async value=>{
    const scenes=(value.plan as {scenes3d?:Record<string,unknown>}|undefined)?.scenes3d;
    if(scenes&&Object.keys(scenes).length){scene3dCapability.current??=invoke<boolean>('live_set_v2_scene3d_enabled').catch(()=>false);if(!await scene3dCapability.current)throw Error('This 3D Set requires an updated Producer app.');}
    const room=await ipc.liveSetStatus();
    if(cacheGeneration.current!==undefined&&cacheGeneration.current!==room.generation)invalidateRoom();
    cacheGeneration.current=room.generation;generation.current=room.generation;
    return invoke<NativeStatus>('live_set_v2',{request:{generation:room.generation,...value}}).catch(e=>{if(value.op==='status'&&/Prepare (a v2|the portrait) set first/.test(String(e)))return {preparedRevision:0,renderedRevision:0,renderSerial:0,ready:false,warmed:false,queued:false,transitioning:false,cachedKeys:[],generation:room.generation};throw e;});
  },()=>notifyPreparation(v=>v+1));
  const specsFor=(selected:RehearsalSession,selectedBindings:Record<string,string>,selectedFraming:Record<string,SlotFraming>):SceneSpec[]=>{
    const inventory=layoutProjections(selected);
    const projections=inventory.map(i=>i.projection);
    const version=JSON.stringify(media.current.signature({...inventory[0].projection,assets:selected.package.set.assets}).assets);
    return inventory.map(item=>{
      const frame=(n:typeof item.projection.root)=>{if(n.slotId&&selectedFraming[n.slotId])n.framing=selectedFraming[n.slotId];n.children.forEach(frame);};frame(item.projection.root);
      return {projection:item.projection,phase:item.phase,layout:item.layout,definition:selected.package.id,instance:'room-'+(roomId??'local').slice(0,50),bindings:selectedBindings,target:item.projection.height>item.projection.width?{id:'portrait',orientation:'portrait',width:canvas.height,height:Math.round(canvas.height*16/9),scaling:'contain'}:{id:'program',orientation:'landscape',...canvas,scaling:'contain'},targets:morphTargets(projections,item.projection),assetVersion:version+JSON.stringify(Object.values(selectedBindings).map(id=>{const source=sources.items?.find(s=>s.id===id);return [id,source?.src_w,source?.src_h];}))};
    });
  };
  const inventory=useMemo(()=>specsFor(session,bindings,framing),[session.package,JSON.stringify(state.values),JSON.stringify(state.feeds),JSON.stringify(state.modules),JSON.stringify(bindings),JSON.stringify(framing),JSON.stringify(sources.items?.map(s=>[s.id,s.src_w,s.src_h,s.has_frame])),canvas,roomId]);
  const candidates=useMemo(()=>draftCandidate?specsFor(new RehearsalSession(draftCandidate.doc,undefined,'prepare'),draftCandidate.bindings,draftCandidate.framing):[],[draftCandidate,canvas,roomId]);
  const specsRef=useRef(inventory);specsRef.current=inventory;
  useEffect(()=>{
    if(!enabled||!canvasReady||canvasReadyRoom.current!==roomId)return;let cancelled=false;
    const authoredSpecs=[...candidates,...inventory];
    // Prepare each design in its own output orientation; don't allocate a second
    // fitted copy of every portrait layout on the landscape renderer.
    const selected=inventory.find(s=>s.layout===state.layoutId);
    const fallback=selected&&selected.target.id!=='program'?{...selected,target:{id:'program',orientation:'landscape' as const,...canvas,scaling:'contain' as const}}:undefined;
    const specs=[...authoredSpecs,...(fallback?[fallback]:[])];
    const prioritized=[...specs].sort((a,b)=>Number(b.layout===state.layoutId)-Number(a.layout===state.layoutId));
    void bank.current!.retain(specs).then(()=>bank.current!.preload(prioritized,()=>cancelled));
    return()=>{cancelled=true;};
  },[enabled,canvasReady,inventory,candidates,retryVersion]);
  const bankDisposal=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>{clearTimeout(bankDisposal.current);return()=>{bankDisposal.current=setTimeout(()=>bank.current?.dispose(),0);};},[]);
  useEffect(()=>{
    if(!enabled)return;
    let cancelled=false,observed=0,stop:(()=>void)|undefined;
    canvasReadyRoom.current=undefined;setCanvasReady(false);
    const resize=(height:number)=>{
      if(cancelled||height===canvasRef.current.height)return;
      const next={height,width:Math.round(height*16/9)};
      canvasRef.current=next;invalidateRoom();setCanvas(next);
    };
    const refresh=async()=>{
      const version=observed;
      const [room,engine]=await Promise.all([ipc.liveSetStatus(),ipc.liveEngineStatus()]);
      if(cancelled||version!==observed)return;
      const changed=cacheGeneration.current!==undefined&&cacheGeneration.current!==room.generation;
      cacheGeneration.current=room.generation;generation.current=room.generation;
      if(engine.engine_ready===false||!engine.video_height)return;
      const height=engine.video_height;
      if(height!==canvasRef.current.height)resize(height);
      else if(changed)invalidateRoom();
      canvasReadyRoom.current=roomId;setCanvasReady(true);
    };
    void listenLiveEvents(event=>{
      if(cancelled||event.type!=="video_changed")return;
      ++observed;resize(event.height);void refresh().catch(()=>{});
    }).then(unsubscribe=>{if(cancelled)unsubscribe();else stop=unsubscribe;}).catch(()=>{});
    void refresh().catch(()=>{});
    const timer=setInterval(()=>{void refresh().catch(()=>{});},1500);
    return()=>{cancelled=true;canvasReadyRoom.current=undefined;clearInterval(timer);stop?.();};
  },[enabled,roomId]);
  const layoutReadiness=Object.fromEntries(inventory.map(spec=>[spec.layout,bank.current!.readiness(spec)]));
  void preparationVersion;
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
      canvas:canvasRef.current,
      root: p.root,
      assets: media.current.signature(p).assets,
      tracks: p.timeline?.tracks,
      bindings: current.bindings,
      framing: current.framing,
    });
  };
  const apply = async () => {
    deliberatelyHidden.current=false;
    if (!latest.current.enabled || flight.current) return;
    const selectedSession=latest.current.session;
    try { if(!await waitForCanvas()||flight.current||latest.current.session!==selectedSession)return; }
    catch(e){if(alive.current)setError(String(e));return;}
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
      if (ticket !== operation.current) return;
      const full=project();
      const fingerprint=signature(full,current),layout=current.session.snapshot().layoutId;
      const base=specsRef.current.find(s=>s.layout===layout);if(!base)throw Error('Selected layout is not in preparation inventory');
      const spec:SceneSpec={...base,projection:full,phase:snapshot.show.phase,target:{id:'program',orientation:'landscape',...canvasRef.current,scaling:'contain'}};
      timing('cache-request');
      await bank.current!.take(spec,async(entry,candidateRevision)=>{
      if(ticket!==operation.current||current.session.snapshot().layoutId!==layout||current.session.snapshot().show.phase!==snapshot.show.phase||signature()!==fingerprint)return;
      attempted=candidateRevision;
      const plan=runtimePlan(entry.plan!,full);
      timing('activate-request',{cacheKey:entry.key});
      await request({op:'activate',revision:attempted,key:entry.key,plan});
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
          timing('render-complete',{renderSerial:status.renderSerial,moduleCommit:full.moduleCommit});
          if(full.moduleCommit)window.dispatchEvent(new CustomEvent('producer:module-presented',{detail:{output:'program',generation:generation.current,nativeRevision:attempted,renderSerial:status.renderSerial,moduleCommit:full.moduleCommit}}));
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
      });
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
      cacheGeneration.current = status.generation;
      isActive.current = false;deliberatelyHidden.current=true;
      setActive(false);
      // A deliberate return stays on the room until content or selection changes.
      confirmed.current = signature();
      shownLayout.current = "";
      media.current.clear();
      bank.current?.reset();setRetryVersion(v=>v+1);
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
    if (!enabled || !canvasReady || busy || error) return;
    // Changes to the selected set flow through the same normal Show/Next controls.
    // Choosing an unconfigured set opens its existing source editor first.
    if (!active && (deliberatelyHidden.current||!(selectToShow && Object.keys(bindings).length))) return;
    let fingerprint: string;
    try {
      fingerprint = signature();
    } catch (e) {
      setError(String(e));
      return;
    }
    if (fingerprint === confirmed.current) return;
    const timer = setTimeout(() => void apply(), 0);
    return () => clearTimeout(timer);
  }, [
    enabled,
    canvasReady,
    busy,
    error,
    active,
    selectToShow,
    state,
    session,
    canvas,
    retryVersion,
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
    if(!await waitForCanvas())return;
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
    const id=layoutId??current.session.snapshot().layoutId;
    const base=specsRef.current.find(s=>s.layout===id);if(!base)throw Error('Portrait layout is not in preparation inventory');
    const spec:SceneSpec={...base,projection,target:{id:'portrait',orientation:'portrait',width,height,scaling:'contain'}};
    await bank.current!.take(spec,async(entry,candidate)=>{
      const plan=runtimePlan(entry.plan!,projection);
      await send({op:'activate',key:entry.key,revision:candidate,plan});
      await send({op:'take',revision:candidate,durationMs:authoredCrossfadeMs(projection.timeline?.transition,portraitShownLayout.current!==portraitKey,!!current.session.snapshot().paused),mode:'dissolve'});
    for (let i = 0; i < 200; i++) {
      const state = await send({ op: "status" });
      if (
        state.renderedRevision === candidate &&
        !state.transitioning
      ) { portraitShownLayout.current=portraitKey;if(projection.moduleCommit)window.dispatchEvent(new CustomEvent('producer:module-presented',{detail:{output:'portrait',generation:generation.current,nativeRevision:candidate,renderSerial:state.renderSerial,moduleCommit:projection.moduleCommit}})); return; }
      if (i === 199) throw Error("Portrait did not confirm its rendered frame");
      await sleep(20);
    }
    });
  };
  return {
    renderer: "native",
    layoutReadiness,
    retryPreparation:()=>{bank.current?.retry();setRetryVersion(v=>v+1);},
    prepareDraft:(doc,bindings,framing)=>setDraftCandidate({doc,bindings,framing}),
    clearDraftPreparation:()=>setDraftCandidate(undefined),
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
