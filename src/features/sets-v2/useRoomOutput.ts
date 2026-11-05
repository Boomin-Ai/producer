import { recordTraceEvent, snapshotTraceContext } from "../../lib/performanceTrace";
import {outputLayout} from '../presentation/layoutViews';
import { invoke } from "../../lib/nativeInvoke";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ipc, uiLog, listenLiveEvents, type LiveSources } from "../../lib/ipc";
import {
  setOutputProjection,
  type SetOutputControls,
} from "../presentation/useSetOutput";
import type { SlotFraming } from "../presentation/schema";
import { AssetTransport } from "../presentation/assetTransport";
import {authoredCrossfadeMs} from '../presentation/animation';
import {PreparedScenes,sceneTransport,layoutProjections,moduleViewProjections,valueControlProjections,warmInventory,preparationInventory,morphTargets,runtimePlan,type SceneSpec,type NativeSceneStatus} from './preparedScenes';
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
const chartSeries=(projection:import('../presentation/projection').OutputProjection)=>{const data:unknown[]=[];const visit=(n:typeof projection.root)=>{if(n.chart)data.push([n.chart.id,n.chart.data]);n.children.forEach(visit);};visit(projection.root);return data.length?JSON.stringify(data):'';};
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
  const [portraitLayout,setPortraitLayout]=useState<string|null>(null);
  const portraitConfig=useRef(portraitLayout);portraitConfig.current=portraitLayout;
  const configurePortrait=useCallback((layout:string|null)=>setPortraitLayout(layout),[]);
  const [bindings, setBindings] = useState(initialBindings),
    [framing, setFraming] = useState(initialFraming);
  const [pendingChange, setPendingChange] = useState<"set" | "segment" | "content">("content");
  const shownCharts=useRef(''),portraitShownCharts=useRef('');
  const shownSelection = useRef({definition: "", layout: "", phase: ""});
  const deliberatelyHidden=useRef(false);
  useEffect(()=>{deliberatelyHidden.current=false;},[session.package.id,roomId]);
  const [active, setActive] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [presentedSession, setPresentedSession] = useState<RehearsalSession | null>(null);
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
    flight = useRef<Promise<boolean> | null>(null),
    returnIntent = useRef(0),
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
  const [draftCandidate,setDraftCandidate]=useState<{doc:import('../presentation/schema').PresentationPackage;bindings:Record<string,string>;framing:Record<string,SlotFraming>;phase?:string}>();
  const [retryVersion,setRetryVersion]=useState(0);
  const bank=useRef<PreparedScenes|null>(null);
  const transport=useRef<ReturnType<typeof sceneTransport<NativeStatus>>|null>(null);
  const scene3dCapability=useRef<Promise<boolean>|undefined>(undefined);
  const invalidateRoom=()=>{
    ++operation.current;++portraitOperation.current;
    confirmed.current="";shownLayout.current="";portraitShownLayout.current="";shownCharts.current="";portraitShownCharts.current="";
    isActive.current=false;setPresentedSession(null);setError("");
    bank.current?.reset();setRetryVersion(v=>v+1);
  };
  if(!transport.current)transport.current=sceneTransport<NativeStatus>(value=>invoke<NativeStatus>('live_set_v2',{request:value}),async()=>(await ipc.liveSetStatus()).generation,next=>{
    const previous=cacheGeneration.current;cacheGeneration.current=next;generation.current=next;
    if(previous!==undefined&&previous!==next)invalidateRoom();
  });
  if(!bank.current)bank.current=new PreparedScenes(async value=>{
    const scenes=(value.plan as {scenes3d?:Record<string,unknown>}|undefined)?.scenes3d;
    if(scenes&&Object.keys(scenes).length){scene3dCapability.current??=invoke<boolean>('live_set_v2_scene3d_enabled').catch(()=>false);if(!await scene3dCapability.current)throw Error('This 3D Set requires an updated Producer app.');}
    return transport.current!.send(value).catch(e=>{if(/Set first-frame timeout|Media did not decode its first frame/.test(String(e)))uiLog(`[sets] ${value.outputId??'program'} generation=${generation.current}: ${String(e)}`);if(value.op==='status'&&/Prepare (a v2|the portrait) set first/.test(String(e)))return {preparedRevision:0,renderedRevision:0,renderSerial:0,ready:false,warmed:false,queued:false,transitioning:false,cachedKeys:[],generation:generation.current};throw e;});
  },()=>notifyPreparation(v=>v+1),undefined,()=>{const context=snapshotTraceContext();return(stage,fields)=>recordTraceEvent(`set.prepare.${stage}`,fields,'set',context);});
  const bindingDimensions = (selectedBindings: Record<string, string>) =>
    JSON.stringify(Object.values(selectedBindings).map(id => {
      const source = sources.items?.find(item => item.id === id);
      return [id, source?.src_w, source?.src_h];
    }));
  const specsFor=(selected:RehearsalSession,selectedBindings:Record<string,string>,selectedFraming:Record<string,SlotFraming>,exactLayouts?:ReadonlySet<string>):SceneSpec[]=>{
    const layouts=layoutProjections(selected);
    const snapshot=selected.snapshot();
    const exact=exactLayouts?layouts.filter(item=>exactLayouts.has(item.layout)).map(item=>({
      ...item,phase:snapshot.show.phase,projection:setOutputProjection(selected,1,item.layout),
    })):[];
    const inventory=[...layouts,...valueControlProjections(selected,layouts),...(selected.snapshot().workspaceMode==='prepare'?[]:moduleViewProjections(selected))];
    const projections=inventory.map(i=>i.projection);
    const version=JSON.stringify(media.current.signature({...inventory[0].projection,assets:selected.package.set.assets}).assets);
    return [...exact,...inventory].map(item=>{
      const frame=(n:typeof item.projection.root)=>{if(n.slotId&&selectedFraming[n.slotId])n.framing=selectedFraming[n.slotId];n.children.forEach(frame);};frame(item.projection.root);
      return {controlId:'controlId' in item?String(item.controlId):undefined,speculative:item.variant,projection:item.projection,phase:item.phase,layout:item.layout,definition:selected.package.id,instance:'room-'+(roomId??'local').slice(0,50),bindings:selectedBindings,target:item.projection.height>item.projection.width?{id:'portrait',orientation:'portrait',width:canvas.height,height:Math.round(canvas.height*16/9),scaling:'contain'}:{id:'program',orientation:'landscape',...canvas,scaling:'contain'},targets:morphTargets(projections,item.projection),assetVersion:version+bindingDimensions(selectedBindings)};
    });
  };
  const inventory=useMemo(()=>enabled?specsFor(session,bindings,framing):[],[enabled,session.package,state.layoutId,state.workspaceMode,JSON.stringify(state.values),JSON.stringify(state.feeds),JSON.stringify(state.modules),JSON.stringify(bindings),JSON.stringify(framing),bindingDimensions(bindings),canvas,roomId]);
  const draftLayouts=useMemo(()=>{
    if(!draftCandidate)return undefined;
    const set=draftCandidate.doc.set, layout=set.initialLayout;
    return new Set([outputLayout(set,layout,'landscape'),outputLayout(set,layout,'portrait')]);
  },[draftCandidate]);
  const candidates=useMemo(()=>{
    if(!draftCandidate)return [];
    const draft=new RehearsalSession(draftCandidate.doc,undefined,'prepare');
    const layout=draftCandidate.doc.set.initialLayout;
    if(draftCandidate.phase)draft.send({type:'segment.select',phaseId:draftCandidate.phase});
    if(draft.snapshot().layoutId!==layout)draft.send({type:'control',action:{type:'layout.select',layoutId:layout}});
    return specsFor(draft,draftCandidate.bindings,draftCandidate.framing,draftLayouts);
  },[draftCandidate,draftCandidate&&bindingDimensions(draftCandidate.bindings),draftLayouts,canvas,roomId]);
  const specsRef=useRef(inventory);specsRef.current=inventory;
  useEffect(()=>{
    if(!enabled||!canvasReady||canvasReadyRoom.current!==roomId)return;let cancelled=false;
    // Prepare each design in its own output orientation; don't allocate a second
    // fitted copy of every portrait layout on the landscape renderer.
    const selected=inventory.find(s=>s.layout===state.layoutId);
    const fallback=selected&&selected.target.id!=='program'&&outputLayout(session.package.set,state.layoutId,'landscape')===state.layoutId?{...selected,target:{id:'program',orientation:'landscape' as const,...canvas,scaling:'contain' as const}}:undefined;
    const currentVariants=session.package.set.views&&Object.values(session.package.set.views).find(variants=>Object.values(variants).includes(state.layoutId));
    const currentLayouts=new Set<string>(currentVariants?Object.values(currentVariants):[state.layoutId]);
    const authoredSpecs=preparationInventory(inventory,candidates,currentLayouts);
    const priorityLayouts=new Set([...draftLayouts??[],...currentLayouts]);
    const specs=warmInventory([...authoredSpecs,...(fallback?[fallback]:[])],priorityLayouts);
    // A prior take can still pin its outgoing snapshot after the first new
    // frame appears. Defer speculative work until that transaction releases it.
    bank.current!.setInventory(specs);
    // Give a current-content take the first turn. CPU ownership changes now;
    // optional native eviction/preloading runs after that take or at idle.
    const timer=busy?undefined:setTimeout(()=>void bank.current!.retain(specs).then(()=>bank.current!.preload(specs,()=>cancelled)),40);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[enabled,canvasReady,inventory,candidates,draftLayouts,retryVersion,state.layoutId,busy]);
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
      const [,engine]=await Promise.all([transport.current!.refreshGeneration(),ipc.liveEngineStatus()]);
      if(cancelled||version!==observed)return;
      if(engine.engine_ready===false||!engine.video_height)return;
      const height=engine.video_height;
      if(height!==canvasRef.current.height)resize(height);
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
  const layoutReadiness=Object.fromEntries(inventory.filter((spec,index)=>inventory.findIndex(other=>other.layout===spec.layout)===index).map(spec=>[spec.layout,bank.current!.readiness(spec)]));
  const controlReadiness=Object.fromEntries(inventory.filter(s=>s.controlId).map(s=>{
    const variants=inventory.filter(other=>other.controlId===s.controlId),states=variants.map(v=>bank.current!.readiness(v));
    return [s.controlId!,states.find(v=>v.state==='error')??states.find(v=>v.state!=='ready')??{state:'ready' as const}];
  }));
  void preparationVersion;
  const project = (current = latest.current) => {
    const p = setOutputProjection(current.session, 1,outputLayout(current.session.package.set,current.session.snapshot().layoutId,'landscape'));
    const visit = (n: typeof p.root) => {
      if (n.slotId && current.framing[n.slotId])
        n.framing = current.framing[n.slotId];
      n.children.forEach(visit);
    };
    visit(p.root);
    return p;
  };
  const signature = (p = project(), current = latest.current) => {
    const selected=current.session.snapshot().layoutId;
    const portraitId=portraitConfig.current===null?undefined:portraitConfig.current==='auto'?outputLayout(current.session.package.set,selected,'portrait'):portraitConfig.current;
    const portrait=portraitId?setOutputProjection(current.session,1,portraitId):undefined;
    return JSON.stringify({
      canvas:canvasRef.current,
      portrait:portraitConfig.current,
      portraitRoot:portrait?.root,
      portraitTracks:portrait?.timeline?.tracks,
      root: p.root,
      assets: media.current.signature(p).assets,
      tracks: p.timeline?.tracks,
      bindings: current.bindings,
      framing: current.framing,
    });
  };
  const reportFailure=(current:typeof latest.current,output:'program'|'portrait',moduleCommit:import('../presentation/projection').OutputProjection['moduleCommit'],stage:'prepare'|'render',nativeRevision=0)=>{
    const commit=current.session.moduleSnapshot();
    if(!alive.current||!latest.current.enabled||current.roomId!==latest.current.roomId||current.session!==latest.current.session||!moduleCommit||moduleCommit.domain!=='live'||moduleCommit.setEpoch!==commit.setEpoch||moduleCommit.revision!==commit.revision)return;
    // Native errors may contain asset paths or integration URLs. Relay only a bounded generic explanation.
    window.dispatchEvent(new CustomEvent('producer:module-presentation-failed',{detail:{roomId:current.roomId,output,generation:generation.current,nativeRevision,renderSerial:0,moduleCommit,status:'failed',stage,error:stage==='prepare'?'The requested output could not be prepared. The host can retry.':'The requested frame was not confirmed. The host can retry.'}}));
  };
  const takeOnce = async (): Promise<boolean> => {
    const waitingReturnIntent=returnIntent.current,selectedContext=latest.current,selectedSession=selectedContext.session,selectedState=selectedSession.snapshot();
    const stillSelected = () => alive.current && latest.current.enabled
      && latest.current.roomId === selectedContext.roomId && latest.current.session === selectedSession;
    const initialCommit=selectedState.moduleConnection==='live'&&selectedState.workspaceMode==='live'?{...selectedState.moduleCommit,domain:'live' as const}:undefined;
    // Initial saved-canvas discovery can reset generation/size before any
    // preparation exists. Keep this Apply intent while waiting for the real
    // canvas; an explicit return, changed room/session or unmount cancels it.
    try { if(!await waitForCanvas()||returnIntent.current!==waitingReturnIntent||!stillSelected())return false; }
    catch(e){if(stillSelected()&&returnIntent.current===waitingReturnIntent){setError(String(e));reportFailure(selectedContext,'program',initialCommit,'prepare');}throw e;}
    const ticket = ++operation.current;
    const stillTaking = () => ticket === operation.current && stillSelected();
    let current = selectedContext;
    let selection = {definition:selectedSession.package.id,layout:selectedState.layoutId,phase:selectedState.show.phase};
    setBusy(true);
    setError("");
    let rendered = false;
    let portraitAttempted=0;
    let attempted = 0,failedCommit:import('../presentation/projection').OutputProjection['moduleCommit']=initialCommit;
    let takeGeneration = generation.current;
    const interrupted = Symbol('Set take superseded');
    let failureStage:'prepare'|'render'='prepare';
    const started=performance.now();
    const traceContext=snapshotTraceContext();
    const timing=(stage:string,extra:Record<string,unknown>={})=>{recordTraceEvent(`set.${stage}`,{elapsedMs:performance.now()-started,revision:attempted,...Object.fromEntries(Object.entries(extra).filter(([,value])=>typeof value==='number'||typeof value==='boolean'))} as Record<string,number|boolean>,'set',traceContext);if(import.meta.env.DEV)window.dispatchEvent(new CustomEvent('producer:set-render-timing',{detail:{stage,at:performance.now(),elapsedMs:performance.now()-started,definition:selection.definition,layout:selection.layout,phase:selection.phase,revision:attempted,...extra}}));};
    const cancelAttempt = async () => {
      if(portraitAttempted)await request({op:'cancel',generation:takeGeneration,outputId:'portrait',revision:portraitAttempted}).catch(()=>{});
      if(attempted)await request({op:'cancel',generation:takeGeneration,revision:attempted}).catch(()=>{});
    };
    try {
      // Saved-canvas discovery and lifecycle changes refresh the generation.
      // Reuse it for a take: every v2 action still rejects a stale generation
      // natively before mutation, then refreshes without replaying the action.
      const roomGeneration = await transport.current!.ensureGeneration();
      if (!stillTaking()) return false;
      takeGeneration = roomGeneration;
      generation.current = takeGeneration;
      // Read layout, phase and the projection from one selection after IPC.
      // An update while checking room status must not invalidate its own take.
      current = latest.current;
      const snapshot = current.session.snapshot();
      const layout = snapshot.layoutId;
      selection = {definition:current.session.package.id,layout,phase:snapshot.show.phase};
      const previous = shownSelection.current;
      setPendingChange(previous.definition !== selection.definition ? "set" : previous.layout !== layout || previous.phase !== selection.phase ? "segment" : "content");
      timing('apply-start');
      const full=project(current);failedCommit=full.moduleCommit;
      const fingerprint=signature(full,current);
      const programLayout=outputLayout(current.session.package.set,layout,'landscape');
      const base=specsRef.current.find(s=>s.layout===programLayout);if(!base)throw Error('Selected layout is not in preparation inventory');
      const spec:SceneSpec={...base,projection:full,phase:snapshot.show.phase,target:{id:'program',orientation:'landscape',...canvasRef.current,scaling:'contain'}};
      const portraitId=portraitConfig.current===null?undefined:portraitConfig.current==='auto'?outputLayout(current.session.package.set,layout,'portrait'):portraitConfig.current;
      const portraitBase=portraitId?specsRef.current.find(s=>s.layout===portraitId):undefined;
      const portraitProjection=portraitId?setOutputProjection(current.session,1,portraitId):undefined;
      if(portraitProjection){const visit=(n:typeof portraitProjection.root)=>{if(n.slotId&&current.framing[n.slotId])n.framing=current.framing[n.slotId];n.children.forEach(visit);};visit(portraitProjection.root);}
      const portraitSpec=portraitBase&&portraitProjection?{...portraitBase,projection:portraitProjection,target:{id:'portrait',orientation:'portrait' as const,width:canvasRef.current.height,height:Math.round(canvasRef.current.height*16/9),scaling:'contain' as const}}:undefined;
      if(portraitId&&!portraitSpec)throw Error('Portrait layout is not in preparation inventory');
      timing('cache-request');
      await bank.current!.takeGroup([spec,...(portraitSpec?[portraitSpec]:[])],async(entries)=>{
      if(!stillTaking()||current.session.snapshot().layoutId!==layout||current.session.snapshot().show.phase!==snapshot.show.phase||signature()!==fingerprint)throw interrupted;
      attempted=entries[0].revision;portraitAttempted=entries[1]?.revision??0;
      failureStage='render';
      timing('activate-request',{cacheKey:entries[0].entry.key});
      for(const [i,candidate]of entries.entries()){
        if (!stillTaking()) throw interrupted;
        await request({op:'activate',generation:takeGeneration,outputId:i?'portrait':'program',revision:candidate.revision,key:candidate.entry.key,plan:runtimePlan(candidate.entry.plan!,i?portraitProjection!:full)});
      }
      if (!stillTaking()) throw interrupted;
      const charts=chartSeries(full),chartUpdate=!!charts&&!!shownCharts.current&&charts!==shownCharts.current;
      const transition =
        authoredCrossfadeMs(full.timeline?.transition,isActive.current&&(shownSelection.current.definition!==selection.definition||shownLayout.current!==layout),snapshot.paused,isActive.current&&!chartUpdate);
      timing('take-request',{transitionMs:transition});
      await request(portraitSpec?{op:'takePair',generation:takeGeneration,programRevision:attempted,portraitRevision:entries[1].revision,durationMs:transition,mode:'dissolve'}:{op:'take',generation:takeGeneration,revision:attempted,durationMs:transition,mode:'dissolve'});
      let sawTransition=false;
      for (let i = 0; i < 200; i++) {
        if (!stillTaking()) throw interrupted;
        const status = await request({ op: "status", generation: takeGeneration });
        if(status.transitioning&&!sawTransition){sawTransition=true;timing('transition-first-observed',{renderSerial:status.renderSerial});}
        const portraitStatus=portraitSpec?await request({op:'status',generation:takeGeneration,outputId:'portrait'}):undefined;
        if (status.renderedRevision === attempted && !status.transitioning&&(!portraitStatus||portraitStatus.renderedRevision===entries[1].revision&&!portraitStatus.transitioning)) {
          timing('render-complete',{renderSerial:status.renderSerial,moduleCommit:full.moduleCommit});
          if (!stillTaking()) throw interrupted;
          if(full.moduleCommit)window.dispatchEvent(new CustomEvent('producer:module-presented',{detail:{roomId:current.roomId,output:'program',generation:generation.current,nativeRevision:attempted,renderSerial:status.renderSerial,moduleCommit:full.moduleCommit}}));
          media.current.acknowledge(full);
          if(portraitProjection){
            media.current.acknowledge(portraitProjection);
            portraitShownLayout.current=current.session.package.id+':'+portraitId;
            portraitShownCharts.current=chartSeries(portraitProjection);
            if(portraitProjection.moduleCommit)window.dispatchEvent(new CustomEvent('producer:module-presented',{detail:{roomId:current.roomId,output:'portrait',generation:generation.current,nativeRevision:entries[1].revision,renderSerial:portraitStatus?.renderSerial,moduleCommit:portraitProjection.moduleCommit}}));
          }
          confirmed.current = fingerprint;
          shownCharts.current=charts;
          shownLayout.current = layout;
          shownSelection.current = selection;
          isActive.current = true;
          setPresentedSession(current.session);
          setActive(true);
          rendered = true;
          return;
        }
        if (i === 199)
          throw Error(
            "Set rendering did not confirm. The current output is retained.",
          );
        await sleep(20);
      }
      });
      return rendered;
    } catch (e) {
      await cancelAttempt();
      if (e === interrupted) {
        timing('superseded');
        return false;
      }
      timing('error',{error:String(e)});
      if (stillTaking()){setError(String(e));reportFailure(current,'program',failedCommit,failureStage,attempted);}
      throw e;
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const startTake = () => {
    const pending = takeOnce();
    flight.current = pending;
    const finish = () => { if (flight.current === pending) flight.current = null; };
    void pending.then(finish, finish);
    return pending;
  };
  const apply = async () => {
    deliberatelyHidden.current=false;
    if (!latest.current.enabled || flight.current) return;
    await startTake().catch(()=>{});
  };
  const applyConfirmed = async () => {
    const {session: requestedSession, roomId: requestedRoom} = latest.current;
    const intent = returnIntent.current;
    deliberatelyHidden.current = false;
    const checkRequest = () => {
      if (!alive.current || requestedSession !== latest.current.session
        || requestedRoom !== latest.current.roomId || intent !== returnIntent.current) {
        throw Error("The Set update was cancelled because the room or output changed.");
      }
      if (!latest.current.enabled) throw Error("Room output is not ready.");
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      checkRequest();
      while (flight.current) await flight.current.catch(()=>{});
      checkRequest();
      try {
        const acknowledged = await startTake();
        checkRequest();
        if (acknowledged) return;
      } catch (error) {
        checkRequest();
        if (attempt === 2 || !/Prepared scene expired|Room (?:generation )?changed; prepare/.test(String(error))) throw error;
      }
    }
    throw Error("The Set changed before output could confirm it. Try showing it again.");
  };
  const returnToRoom = async () => {
    ++returnIntent.current;
    ++operation.current;
    ++portraitOperation.current;
    try {
      const status = await request({ op: "return" });
      transport.current!.observeGeneration(status.generation);
      isActive.current = false;deliberatelyHidden.current=true;
      setPresentedSession(null);
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
    portraitLayout,
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
      setPresentedSession(null);
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
    portraitLayout,
    bindings,
    framing,
  ]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(
      () =>
        void Promise.all([request({op:'pause',paused:!!state.paused}),...(portraitConfig.current!==null?[request({op:'pause',outputId:'portrait',paused:!!state.paused})]:[])]).catch(()=>{}),
      0,
    );
    return () => clearTimeout(timer);
  }, [enabled, state.paused, portraitLayout]);
  const applyPortrait = async (
    projection: import("../presentation/projection").OutputProjection,
    layoutId?:string,
  ) => {
    const current = latest.current;
    const ticket = ++portraitOperation.current;
    let attempted=0,failureStage:'prepare'|'render'='prepare';
    try{
    if(!await waitForCanvas()||ticket!==portraitOperation.current||current.session!==latest.current.session)return;
    const portraitKey=current.session.package.id+":"+(layoutId??current.session.snapshot().layoutId);
    const roomGeneration = await transport.current!.refreshGeneration();
    if(ticket!==portraitOperation.current||!alive.current||current.roomId!==latest.current.roomId||current.session!==latest.current.session)return;
    generation.current = roomGeneration;
    const engine = await ipc.liveEngineStatus();
    const width = engine.video_height ?? 720,
      height = Math.round((width * 16) / 9);
    const send = (value: Record<string, unknown>) => {
      if (ticket !== portraitOperation.current || !alive.current || current.roomId!==latest.current.roomId || current.session!==latest.current.session) throw Error("Portrait selection changed");
      return invoke<NativeStatus>("live_set_v2", {request: {generation: roomGeneration, ...value, outputId: "portrait"}});
    };
    const id=layoutId??current.session.snapshot().layoutId;
    const base=specsRef.current.find(s=>s.layout===id);if(!base)throw Error('Portrait layout is not in preparation inventory');
    const spec:SceneSpec={...base,projection,target:{id:'portrait',orientation:'portrait',width,height,scaling:'contain'}};
    await bank.current!.take(spec,async(entry,candidate)=>{
      attempted=candidate;
      const plan=runtimePlan(entry.plan!,projection);failureStage='render';
      await send({op:'activate',key:entry.key,revision:candidate,plan});
      const charts=chartSeries(projection),chartUpdate=!!charts&&!!portraitShownCharts.current&&charts!==portraitShownCharts.current;
      await send({op:'take',revision:candidate,durationMs:authoredCrossfadeMs(projection.timeline?.transition,portraitShownLayout.current!==portraitKey,!!current.session.snapshot().paused,!!portraitShownLayout.current&&!chartUpdate),mode:'dissolve'});
    for (let i = 0; i < 200; i++) {
      const state = await send({ op: "status" });
      if (
        state.renderedRevision === candidate &&
        !state.transitioning
      ) { if(ticket!==portraitOperation.current||!alive.current||current.roomId!==latest.current.roomId||current.session!==latest.current.session)return;portraitShownCharts.current=chartSeries(projection);portraitShownLayout.current=portraitKey;if(projection.moduleCommit)window.dispatchEvent(new CustomEvent('producer:module-presented',{detail:{roomId:current.roomId,output:'portrait',generation:roomGeneration,nativeRevision:candidate,renderSerial:state.renderSerial,moduleCommit:projection.moduleCommit}})); return; }
      if (i === 199) throw Error("Portrait did not confirm its rendered frame");
      await sleep(20);
    }
    });
    }catch(error){if(ticket===portraitOperation.current)reportFailure(current,'portrait',projection.moduleCommit,failureStage,attempted);throw error;}
  };
  return {
    renderer: "native",
    configurePortrait,
    requiredOrientations:portraitLayout===null?['landscape']:['landscape','portrait'],
    layoutReadiness,controlReadiness,
    retryPreparation:()=>{bank.current?.retry();setRetryVersion(v=>v+1);},
    prepareDraft:(doc,bindings,framing,phase)=>setDraftCandidate({doc,bindings,framing,phase}),
    clearDraftPreparation:()=>setDraftCandidate(undefined),
    applyPortrait,
    stopPortrait: async () => {
      ++portraitOperation.current;
      await request({ op: "return", outputId: "portrait" });
      bank.current?.invalidateOutput('portrait');
    },
    selectToShow,
    setSelectToShow: (value) => {
      localStorage.setItem("producer.sets.selection", value ? "show" : "edit");
      setSelectToShow(value);
    },
    active,
    currentPresented: active && presentedSession === session,
    busy,
    pendingChange,
    error,
    bindings,
    framing,
    sources,
    apply,
    applyConfirmed,
    returnToRoom,
    setAssignments: (nextBindings, nextFraming) => {
      latest.current.bindings = nextBindings;
      latest.current.framing = nextFraming;
      setBindings(nextBindings);
      setFraming(nextFraming);
    },
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
