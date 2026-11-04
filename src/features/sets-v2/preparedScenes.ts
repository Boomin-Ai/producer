import {outputProjection,type OutputProjection,type RenderNode} from '../presentation/projection';
import type {AnimationTrack} from '../presentation/animation';
import {mediaPosition} from '../presentation/playback';
import {layoutTransition} from '../presentation/layoutTransition';
import {layoutFieldKeys} from '../presentation/layoutFields';
import {evaluate,RehearsalSession} from '../presentation/rehearsal';
import {compileRoomScene,nativeNodeId} from './roomCompiler';
import type {RenderPlan,OutputTarget} from './scene';

export type SceneReadiness={state:'queued'|'loading'|'ready'|'error';error?:string};
export type NativeSceneStatus={preparedRevision:number;renderedRevision:number;ready:boolean;warmed:boolean;transitioning:boolean;queued:boolean;cachedKeys?:string[];cachedBytes?:number;renderSerial:number};
type Plan=RenderPlan&{motion?:AnimationTrack[];clock?:import('../presentation/animation').AnimationClock;retainedTargets?:string[];assets?:OutputProjection['assets']};
export type SceneSpec={projection:OutputProjection;phase:string;layout:string;bindings:Record<string,string>;target:OutputTarget;definition:string;instance:string;targets:string[];assetVersion:string;speculative?:boolean;controlId?:string};
/** The native protocol fences every action, including status, by generation.
 * Discover/refresh at lifecycle checks rather than before each readiness poll.
 * A native rejection refreshes without replaying the action; an old response
 * must never restore readiness after room reset. */
export function sceneTransport<T extends {generation:number}>(send:(request:Record<string,unknown>)=>Promise<T>,readGeneration:()=>Promise<number>,changed:(generation:number)=>void){
 let generation:number|undefined,epoch=0,discovery:Promise<number>|undefined;
 const observeGeneration=(next:number)=>{if(generation!==next){generation=next;++epoch;changed(next);}return next;};
 const discover=()=>discovery??=(async()=>{const before=epoch,next=await readGeneration();return before===epoch?observeGeneration(next):generation!;})().finally(()=>{discovery=undefined;});
 return {observeGeneration,refreshGeneration:discover,send:async(request:Record<string,unknown>)=>{
  const expected=generation??await discover(),before=epoch;
  try{
   const status=await send({...request,generation:expected});
   if(before!==epoch||status.generation!==expected)throw Error('Room generation changed; prepare the set again');
   return status;
  }catch(error){
   if(/Room generation changed; prepare/.test(String(error)))await discover().catch(()=>{});
   throw error;
  }
 }};
}
/** Keep the current paired view available while a different Set is prepared. */
export function preparationInventory(inventory:SceneSpec[],candidates:SceneSpec[],currentLayouts:ReadonlySet<string>){
 const replacing=candidates.length>0&&inventory.length>0&&candidates[0].definition!==inventory[0].definition;
 return [...candidates,...(replacing?inventory.filter(s=>currentLayouts.has(s.layout)):inventory)];
}
type Entry={pins:number;key:string;identity:string;spec:SceneSpec;state:SceneReadiness;plan?:Plan;promise?:Promise<Entry>};
type Job={priority:number;run:(abort:()=>boolean)=>Promise<unknown>;resolve:(v:any)=>void;reject:(e:unknown)=>void;preemptible:boolean;entry?:Entry};
type PreparationTrace=(stage:string,fields:Record<string,number|boolean>)=>void;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function digest(text:string){let a=2166136261,b=5381;for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i);}return 'scene-'+(a>>>0).toString(16)+'-'+(b>>>0).toString(16);}
function visual(node:RenderNode):unknown{const {playback:_playback,motionClass:_motion,...rest}=node;if(rest.scene3d){const {cue:_cue,view:_view,cueSequence:_sequence,...definition}=rest.scene3d;rest.scene3d={...definition,cue:"neutral"};}return {...rest,children:node.children.map(visual)};}
export function sceneIdentity(spec:SceneSpec){return JSON.stringify({definition:spec.definition,root:visual(spec.projection.root),canvas:spec.layout,bindings:spec.bindings,target:spec.target,targets:spec.targets,assets:spec.assetVersion});}
export function runtimePlan(plan:Plan,projection:OutputProjection):Plan{
 const next=structuredClone({...plan,assets:{}});next.clock=projection.timeline?.clock;next.motion=projection.timeline?.tracks.map(t=>({...t,target:nativeNodeId(t.target)}))??[];
 const transports=new Map<string,RenderNode>();const collect=(n:RenderNode)=>{if(n.scene3d){next.scenes3d??={};next.scenes3d[n.scene3d.id+"-"+n.scene3d.pass]=structuredClone(n.scene3d);}transports.set(nativeNodeId(n.id),n);n.children.forEach(collect);};collect(projection.root);
 const patch=(n:RenderPlan['root'])=>{const authored=transports.get(n.id);if(authored?.playback){const now=Date.now();Object.assign(n,{playback:{...authored.playback,positionMs:mediaPosition(authored.playback,now),anchorMs:now}});}n.children.forEach(patch);};patch(next.root);
 return next;
}
/** Room-owned, priority queued native preparation. Ready scene ownership outlives panels. */
const debugSessions=new Set<PreparedScenes>();
export function preparationDebug(){return [...debugSessions].map(s=>s.debug());}
export class PreparedScenes {
 private sentAssets=new Map<string,Map<string,string>>();
 private retained=new Map<string,string>();private retentionEpoch=0;
 private warmingBlocked=new Set<string>();private family='';
 private inventory?:SceneSpec[];private active=new Map<string,SceneSpec>();
 private outputs=new Set<string>();
 private counters={plans:0,preloads:0,retains:0};
 private trace:string[]=[];
 debug(){return {counters:{...this.counters},working:this.working,abort:this.abort,queue:this.jobs.map(j=>j.priority),trace:this.trace,active:[...this.active.values()].map(s=>({layout:s.layout,target:s.target.id,key:digest(sceneIdentity(s))})),inventory:this.inventory?.map(s=>({layout:s.layout,target:s.target.id,key:digest(sceneIdentity(s))})),entries:[...this.entries.values()].map(e=>({layout:e.spec.layout,target:e.spec.target,key:e.key,pins:e.pins,state:e.state}))};}
 private log(message:string){this.trace=[...this.trace.slice(-79),message];}
 private entries=new Map<string,Entry>();private jobs:Job[]=[];private working=false;private abort=false;private running?:Job;private disposed=false;private revision=0;private foregroundTakes=0;private roomEpoch=0;
 private trimTimer?:ReturnType<typeof setTimeout>;
 constructor(private send:(request:Record<string,unknown>)=>Promise<NativeSceneStatus>,private changed:()=>void,private compile=compileRoomScene,private startTrace?:()=>PreparationTrace){
  const originalSend=this.send;this.send=async request=>{if(request.op==='preload')this.counters.preloads++;if(request.op==='retain')this.counters.retains++;const started=performance.now();try{return await originalSend(request);}finally{this.log(`${request.op}:${request.outputId??'program'} ${(performance.now()-started).toFixed(1)}ms`);}};
  debugSessions.add(this);
 }
 get(spec:SceneSpec){const identity=sceneIdentity(spec),key=digest(identity);let entry=this.entries.get(key);if(entry&&entry.identity!==identity)throw Error('Prepared scene identity collision');if(!entry){entry={pins:0,key,identity,spec,state:{state:'queued'}};this.entries.set(key,entry);}return entry;}
 readiness(spec:SceneSpec):SceneReadiness{return {...this.get(spec).state};}
 private preemptBackground(){
  if(this.running?.preemptible&&!this.running.entry?.pins)this.abort=true;
 }
 private enqueue<T>(priority:number,preemptible:boolean,run:(abort:()=>boolean)=>Promise<T>,entry?:Entry):Promise<T>{
  if(this.disposed)return Promise.reject(Error('Room preparation closed'));
  if(priority>=100)this.preemptBackground();
  return new Promise((resolve,reject)=>{this.jobs.push({priority,preemptible,run,resolve,reject,entry});void this.pump();});
 }
 private async pump(){if(this.working||this.disposed)return;this.working=true;try{while(this.jobs.length&&!this.disposed){this.jobs.sort((a,b)=>b.priority-a.priority);if(this.foregroundTakes&&this.jobs[0].priority<100)break;const job=this.jobs.shift()!;this.abort=false;this.running=job;try{job.resolve(await job.run(()=>this.abort||this.disposed));}catch(e){job.reject(e);}}}finally{this.running=undefined;this.working=false;}}
 async ensure(spec:SceneSpec,priority=0):Promise<Entry>{
  this.outputs.add(spec.target.id);
  const entry=this.get(spec);
  const trace=this.startTrace?.(),queuedAt=performance.now(),epoch=this.roomEpoch;
  const report=(stage:string,fields:Record<string,number|boolean>={})=>trace?.(stage,{foreground:priority>=100||entry.pins>0,portrait:spec.target.id==='portrait',...fields});
  const speculative=()=>priority<100&&!entry.pins;
  if(entry.state.state==='ready'){report('reuse');return entry;}
  if(speculative()&&this.warmingBlocked.has(spec.target.id))return entry;
  if(entry.promise){
   if(priority>=100){
    const queued=this.jobs.find(job=>job.entry===entry);
    if(queued){queued.priority=priority;queued.preemptible=false;}
    this.preemptBackground();
    void this.pump();
   }
   return entry.promise;
  }
  const pending=this.enqueue(priority,priority<100,async interrupted=>{
   const abort=()=>interrupted()||epoch!==this.roomEpoch;
   report('queue',{durationMs:performance.now()-queuedAt});
   this.log('loading '+entry.key+' priority '+priority);entry.state={state:'loading'};this.changed();let revision=0;
   try{
    if(abort()){entry.state={state:'queued'};return entry;}
    if(speculative()&&this.warmingBlocked.has(spec.target.id)){entry.state={state:'queued'};return entry;}
    if(!entry.plan){this.counters.plans++;const started=performance.now();entry.plan=await this.compile(spec.projection,{definitionId:spec.definition,instanceId:spec.instance,canvasId:spec.layout,target:spec.target,bindings:spec.bindings,retainedTargets:spec.targets}) as Plan;const durationMs=performance.now()-started;this.log(`compiled ${entry.key} ${durationMs.toFixed(1)}ms`);report('compile',{durationMs});}
    if(abort()){this.log('aborted compile '+entry.key);entry.state={state:'queued'};return entry;}
    let frameRetries=0,budgetRetries=0;
    for(;;){
     try{
    const status=await this.send({op:'status',outputId:spec.target.id});if(abort()){entry.state={state:'queued'};return entry;}this.revision=Math.max(this.revision,status.preparedRevision,status.renderedRevision);revision=++this.revision;
    const paused=runtimePlan(entry.plan,{...spec.projection,timeline:spec.projection.timeline?{...spec.projection.timeline,clock:{...spec.projection.timeline.clock,running:false}}:undefined});
    paused.assets=entry.plan.assets;
    const stop=(n:RenderPlan['root'])=>{const p=(n as any).playback;if(p)p.playing=false;n.children.forEach(stop);};stop(paused.root);
    let sent=this.sentAssets.get(spec.target.id);if(!sent){sent=new Map();this.sentAssets.set(spec.target.id,sent);}
    paused.assets=Object.fromEntries(Object.entries(paused.assets??{}).filter(([id,a])=>sent!.get(id)!==a.data));
    const preloadStarted=performance.now();await this.send({op:'preload',outputId:spec.target.id,key:entry.key,revision,plan:paused});report('preload',{durationMs:performance.now()-preloadStarted});
    for(const [id,a]of Object.entries(paused.assets??{}))sent.set(id,a.data);
    // Native cold WebGL preparation permits 60s for shader compilation and
    // the first imported paint. Keep the client deadline beyond that fence;
    // an iteration count otherwise cancels valid cold 3D loads at ~12s.
    const deadline=Date.now()+(Object.keys(entry.plan.scenes3d??{}).length?65000:15000);
    const readyStarted=performance.now();let polls=0;
    while(Date.now()<deadline){
     if(abort()){if(epoch===this.roomEpoch)await this.send({op:'cancel',outputId:spec.target.id,revision}).catch(()=>{});this.log('aborted native '+entry.key);entry.state={state:'queued'};return entry;}
     const state=await this.send({op:'status',outputId:spec.target.id});++polls;if(abort()){if(epoch===this.roomEpoch)await this.send({op:'cancel',outputId:spec.target.id,revision}).catch(()=>{});entry.state={state:'queued'};return entry;}if(state.cachedKeys?.includes(entry.key)){this.log('ready '+entry.key);entry.state={state:'ready'};report('ready',{durationMs:performance.now()-readyStarted,polls});return entry;}await sleep(20);
    }
    throw Error('Layout did not finish preparing');
     }catch(error){
      if(abort()){if(revision&&epoch===this.roomEpoch)await this.send({op:'cancel',outputId:spec.target.id,revision}).catch(()=>{});entry.state={state:'queued'};return entry;}
      const message=String(error);
      const firstFrameTimeout=message.includes('Set first-frame timeout')||message.includes('Media did not decode its first frame')||message.includes('Layout did not finish preparing');
      if(firstFrameTimeout&&frameRetries++===0){
       if(revision)await this.send({op:'cancel',outputId:spec.target.id,revision}).catch(()=>{});
       if(abort()){entry.state={state:'queued'};return entry;}
       // Retry the failed off-air candidate once, keeping its compiled plan,
       // authorized assets, generation checks and every first-pixel fence.
       // Nothing touches the currently rendered scene or marks this ready.
       this.log('retry first frame '+entry.key+': '+message);
       continue;
      }
      if(!message.includes('Loaded set texture budget reached'))throw error;
      if(revision)await this.send({op:'cancel',outputId:spec.target.id,revision}).catch(()=>{});
      if(abort()){entry.state={state:'queued'};return entry;}
      this.warmingBlocked.add(spec.target.id);
      if(speculative()){this.log('deferred full cache '+entry.key);entry.state={state:'queued'};return entry;}
      if(budgetRetries++>0)throw error;
      // Cache pressure is not a broken Set. Keep every in-flight paired take
      // pinned, release cold snapshots and retry the requested view once.
      // Native program ownership preserves the on-air frame independently.
      const pinned=[...this.entries.values()].filter(e=>e.pins>0&&e.spec.target.id===spec.target.id),keys=pinned.map(e=>e.key);
      const retained=[...(this.inventory??[]),...this.active.values(),...pinned.map(e=>e.spec)];
      const assetIds=[...new Set(retained.filter(s=>s.target.id===spec.target.id).flatMap(s=>Object.keys(s.projection.assets??{})))];
      await this.send({op:'retain',outputId:spec.target.id,keys,assetIds});if(abort()){entry.state={state:'queued'};return entry;}this.retained.delete(spec.target.id);
      for(const other of this.entries.values())if(other.spec.target.id===spec.target.id&&!keys.includes(other.key)&&other.state.state==='ready')other.state={state:'queued'};
      this.log('released cold snapshots for '+entry.key);
     }
    }

   }catch(e){if(epoch!==this.roomEpoch){entry.state={state:'queued'};return entry;}if(revision)await this.send({op:'cancel',outputId:spec.target.id,revision}).catch(()=>{});if(epoch!==this.roomEpoch){entry.state={state:'queued'};return entry;}entry.plan=undefined;entry.state={state:'error',error:String(e)};throw e;}
   finally{this.changed();}
  },entry);
  entry.promise=pending;
  const finished=()=>{if(entry.promise===pending)entry.promise=undefined;};void pending.then(finished,finished);
  return pending;
 }
 async take(spec:SceneSpec,run:(entry:Entry,revision:number)=>Promise<void>){
  return this.takeGroup([spec],entries=>run(entries[0].entry,entries[0].revision));
 }
 /** Pin and prepare every required output before either can be activated. */
 async takeGroup(specs:SceneSpec[],run:(entries:{entry:Entry;revision:number}[])=>Promise<void>){
  const epoch=this.roomEpoch,check=()=>{if(epoch!==this.roomEpoch||this.disposed)throw Error('Room generation changed; prepare the set again');};
  const pinned=specs.map(s=>this.get(s));pinned.forEach(e=>e.pins++);
  // Reserve the queue across await boundaries. Otherwise completing a retain
  // or the first orientation lets pump start unrelated speculative decoding
  // before this take can enqueue its next foreground step.
  ++this.foregroundTakes;
  for(const job of this.jobs)if(job.entry&&pinned.includes(job.entry)){job.priority=100;job.preemptible=false;}
  this.preemptBackground();
  try{
   // Cold preparation needs room first. A ready take allocates no scene: do
   // not put unrelated eviction/destruction in front of its presentation.
   // The finally trim reconciles inventory after the new frame is confirmed.
   if(!pinned.every(entry=>entry.state.state==='ready'||entry.promise))await this.trim(100,specs,new Set(specs.map(s=>s.target.id)));
   check();
   const expired=Symbol('Prepared scene expired');
   for(let recovery=0;recovery<2;recovery++){
   const entries:Entry[]=[];
   for(const spec of specs){check();let entry=await this.ensure(spec,100);check();while(entry.state.state==='queued'){entry=await this.ensure(spec,100);check();}entries.push(entry);}
   const result=await this.enqueue(100,false,async()=>{
    check();
    for(const [i,entry]of entries.entries()){
     const status=await this.send({op:'status',outputId:specs[i].target.id});
     check();
     if(!status.cachedKeys?.includes(entry.key)){entry.state={state:'queued'};this.changed();return expired;}
     this.revision=Math.max(this.revision,status.preparedRevision,status.renderedRevision);
    }
    const result=await run(entries.map(entry=>({entry,revision:++this.revision})));
    check();
    specs.forEach(spec=>this.active.set(spec.target.id,spec));return result;
   });
   if(result!==expired)return result;
   // A native cache can be invalidated independently of a ready UI row.
   // Re-prepare once and validate again; never publish a missing scene or
   // retry activation errors such as replaced captures or stale signatures.
   this.log('revalidate expired selection');
   }
   throw Error('Prepared scene expired; retry loading');
  }finally{
   pinned.forEach(e=>e.pins--);
   --this.foregroundTakes;void this.pump();
   clearTimeout(this.trimTimer);
   this.trimTimer=setTimeout(()=>void this.trim().catch(()=>{}),0);
  }
 }

 async preload(specs:SceneSpec[],cancel:()=>boolean){for(const spec of specs){if(cancel()||this.disposed)return;try{const entry=await this.ensure(spec);if(entry.state.state==='queued'&&!cancel()){await sleep(50);await this.ensure(spec);}}catch{/* Per-layout error is exposed; later layouts keep loading. */}}}
 setInventory(specs:SceneSpec[]){const family=[...new Set(specs.map(s=>this.get(s).key))].sort().join('|');if(family!==this.family){this.family=family;this.warmingBlocked.clear();}this.inventory=[...specs];}
 async retain(specs:SceneSpec[]){this.setInventory(specs);await this.trim();}
 /** Keep authored designs plus the latest presented snapshot per output. Text,
  * scores and segment changes can otherwise accumulate unbounded native scenes.
  * In-flight takes remain pinned; native program ownership protects live frames. */
 private async trim(priority=10,replacing:SceneSpec[]=[],onlyOutputs?:ReadonlySet<string>){
  if(!this.inventory||this.disposed)return;
  // Native program ownership keeps the presented frame alive independently of
  // the reusable cache. An updated version of that same layout may replace its
  // cache entry before preparation, while its source assets remain retained.
  const cachedActive=()=>[...this.active.values()].filter(s=>![...(this.inventory??[]),...replacing].some(next=>next.target.id===s.target.id&&next.definition===s.definition&&next.layout===s.layout&&sceneIdentity(next)!==sceneIdentity(s)));
  const specs=[...this.inventory,...cachedActive()],wanted=new Set(specs.map(spec=>this.get(spec).key));
  for(const [key,entry]of this.entries)if(!wanted.has(key)&&!entry.promise&&!entry.pins)this.entries.delete(key);
  for(const outputId of new Set([...this.outputs,...specs.map(s=>s.target.id)])){
   if(onlyOutputs&&!onlyOutputs.has(outputId))continue;
   await this.enqueue(priority,false,async()=>{
    // Recompute inside the queued task: another output can finish a take while
    // this trim waits, and its newly active scene must remain retained.
    const current=[...(this.inventory??[]),...cachedActive()];
    const keys=[...new Set([...current.filter(s=>s.target.id===outputId).map(s=>this.get(s).key),...[...this.entries.values()].filter(e=>e.pins>0&&e.spec.target.id===outputId).map(e=>e.key)])];
    const retained=[...current,...this.active.values(),...[...this.entries.values()].filter(e=>e.pins>0).map(e=>e.spec)];
    const assetIds=[...new Set(retained.filter(s=>s.target.id===outputId).flatMap(s=>Object.keys(s.projection.assets??{})))];
    const signature=JSON.stringify([keys.slice().sort(),assetIds.slice().sort()]),epoch=this.retentionEpoch;
    if(this.retained.get(outputId)!==signature){await this.send({op:'retain',outputId,keys,assetIds});if(epoch===this.retentionEpoch)this.retained.set(outputId,signature);}
    const sent=this.sentAssets.get(outputId);if(sent)for(const id of sent.keys())if(!assetIds.includes(id))sent.delete(id);
   }).catch(()=>{});
  }
 }
 reset(){this.roomEpoch++;this.warmingBlocked.clear();this.active.clear();this.sentAssets.clear();this.retained.clear();this.retentionEpoch++;this.abort=true;for(const e of this.entries.values())e.state={state:'queued'};this.changed();}
 invalidate(spec:SceneSpec){const entry=this.get(spec);entry.state={state:'queued'};entry.plan=undefined;this.changed();}
 invalidateOutput(outputId:string){this.warmingBlocked.delete(outputId);this.sentAssets.delete(outputId);this.retained.delete(outputId);this.retentionEpoch++;for(const e of this.entries.values())if(e.spec.target.id===outputId)e.state={state:'queued'};this.changed();}
 retry(){for(const e of this.entries.values())if(e.state.state==='error')e.state={state:'queued'};this.changed();}
 dispose(){debugSessions.delete(this);this.disposed=true;this.abort=true;clearTimeout(this.trimTimer);for(const job of this.jobs)job.reject(Error('Room preparation closed'));this.jobs=[];this.entries.clear();this.active.clear();this.inventory=undefined;}
}

/** Inventory includes alternate layouts and both design canvases, not only phase.next. */
export function layoutProjections(session:RehearsalSession){
 const doc=session.package,state=session.snapshot();
 return doc.set.layouts.map(layout=>{
  const phase=doc.show?.phases.find(p=>p.layoutId===layout.id||p.layoutId.replace(/-landscape$/,'-portrait')===layout.id)??doc.show?.phases.find(p=>p.id===state.show.phase);
  const entry=structuredClone(state);delete entry.layoutMotion;delete entry.layoutMotionId;delete entry.layoutMotions;
  entry.layoutId=layout.id;entry.show.phase=phase?.id??'';entry.show.collecting=!!phase?.collectMs;entry.show.remainingMs=phase?.collectMs??0;entry.show.total=0;entry.show.revealed=false;entry.show.winner='';entry.show.result='';entry.show.ballot=1;
  entry.counts=Object.fromEntries(Object.keys(entry.counts).map(k=>[k,0]));if(entry.animationClock)entry.animationClock={...entry.animationClock,positionMs:0,segmentMs:0,running:false};
  const projection=outputProjection(doc,entry);projection.assets=Object.fromEntries(Object.entries(doc.set.assets??{}).map(([id,{name,mime,data}])=>[id,{name,mime,data}]));
  // Resolve phase-dependent visuals using the entry state; avoid private votes/results.
  return {layout:layout.id,phase:phase?.id??'',projection,entry,variant:false};
 });
}
export function morphTargets(projections:OutputProjection[],to:OutputProjection){
 if(to.timeline?.transition?.type!=='morph')return [];
 const targets=new Set<string>();for(const from of projections){try{for(const track of layoutTransition(from,to,to.timeline.transition.durationMs,Date.now()))targets.add(track.target);}catch{/* Runtime still validates authored transition limits. */}}
 return [...targets].sort();
}

/** Speculate only bounded, side-effect-free view selections. Never dispatch an
 * action, fetch data, change scores, reveal private fields or expand products
 * of independent modules. Resolve against the latest public data snapshot. */
export function moduleViewProjections(session:RehearsalSession){
 const doc=session.package,state=session.snapshot(),base=layoutProjections(session),snapshot=session.moduleSnapshot();
 const current=doc.set.views&&Object.values(doc.set.views).find(variants=>Object.values(variants).includes(state.layoutId));
 const layouts=new Set(current?Object.values(current):[state.layoutId]);
 const variants:ReturnType<typeof layoutProjections>=[];
 for(const instance of doc.runtime?.instances??[]){
  if(instance.id===doc.set.viewController||instance.owner==='segment'&&instance.segment!==state.show.phase)continue;
  const definition=doc.runtime!.definitions[instance.definition],module=state.modules?.[instance.id];
  if(!module||snapshot.modules[instance.id]?.execution==='disposed')continue;
  const views=[...new Set(Object.values(definition.actions).filter(action=>action.steps.length===1&&action.steps[0].op==='view').map(action=>(action.steps[0] as {op:'view';view:string}).view))];
  for(const view of views){
   if(view===module.view)continue;
   for(const item of base.filter(item=>layouts.has(item.layout))){
    if(variants.filter(v=>v.layout===item.layout).length>=3)continue;
    const entry=structuredClone(item.entry);entry.modules={...entry.modules,[instance.id]:{...entry.modules![instance.id],view}};
    const projection=outputProjection(doc,entry);projection.assets=item.projection.assets;
    variants.push({...item,entry,projection,variant:true});
   }
  }
 }
 return variants;
}

/** Enumerate a bounded family of literal value controls without dispatching
 * actions or multiplying independent fields. Only the current paired view is
 * considered; managed 3D and unbounded choices retain normal preparation. */
export function valueControlProjections(session:RehearsalSession,base=layoutProjections(session)){
 const doc=session.package,state=session.snapshot();
 const view=doc.set.views&&Object.values(doc.set.views).find(v=>Object.values(v).includes(state.layoutId));
 const layouts=new Set(view?Object.values(view):[state.layoutId]);
 const variants:Array<ReturnType<typeof layoutProjections>[number]&{controlId:string}>=[];
 const controls=doc.set.controls.filter(c=>c.type==='button'&&c.action.type==='value.set'&&(c.when===undefined||!!evaluate(c.when,state,{},64,doc.set.tokens))&&(c.enabled===undefined||!!evaluate(c.enabled,state,{},64,doc.set.tokens)));
 const distinct=new Map(base.filter(i=>layouts.has(i.layout)).map(i=>[i.layout,new Set([JSON.stringify(visual(i.projection.root))])]));
 // Bound enumeration, not the renderer's existing memory or texture budget.
 const fields=new Map<string,Set<string>>();
 for(const control of controls){if(control.type!=='button'||control.action.type!=='value.set')continue;const a=control.action;let values=fields.get(a.key);if(!values)fields.set(a.key,values=new Set());values.add(JSON.stringify(a.value));}
 const activeKeys=new Set([...layouts].flatMap(id=>[...layoutFieldKeys(doc,id)]));
 // Warm one stable family. Mixing independent setup toggles into a larger
 // walkthrough family invalidates those toggles on every walkthrough click.
 const family=[...fields].filter(([key,values])=>activeKeys.has(key)&&values.size>1&&values.size<=8).sort((a,b)=>b[1].size-a[1].size)[0]?.[0];
 for(const control of controls){
  if(control.type!=='button'||control.action.type!=='value.set')continue;
  const action=control.action;if(action.key!==family)continue;
  for(const item of base.filter(i=>layouts.has(i.layout))){
   const entry=structuredClone(item.entry);entry.values={...entry.values,[action.key]:action.value};
   const projection=outputProjection(doc,entry);projection.assets=item.projection.assets;
   if(hasScene3d(projection.root))continue;
   const key=JSON.stringify(visual(projection.root)),seen=distinct.get(item.layout)!;
   if(!seen.has(key)&&seen.size>=9)continue;seen.add(key);
   variants.push({...item,entry,projection,variant:true,controlId:control.id});
  }
 }
 return variants;
}

function hasScene3d(node:RenderNode):boolean{return !!node.scene3d||node.children.some(hasScene3d);}

/** Reserve a scene slot for the presented snapshot while warming at most five
 * candidates per native output. Prefer current composition/view alternatives;
 * do not grow a cartesian product or raise the native texture budget. */
export function warmInventory(specs:SceneSpec[],layouts:ReadonlySet<string>){
 const controlFamily=specs.some(spec=>spec.controlId&&layouts.has(spec.layout));
 if(!specs.some(spec=>spec.speculative))return specs;
 const score=(spec:SceneSpec)=>layouts.has(spec.layout)?(spec.speculative?2:3):spec.speculative?0:1;
 const next=(spec:SceneSpec)=>{const first=specs.findIndex(s=>s.target.id===spec.target.id&&layouts.has(s.layout));return (specs.indexOf(spec)-first+specs.length)%specs.length;};
 const ordered=[...specs].sort((a,b)=>score(b)-score(a)||(controlFamily&&!layouts.has(a.layout)&&!layouts.has(b.layout)?next(a)-next(b):0)),seen=new Set<string>(),counts=new Map<string,number>();
 return ordered.filter(spec=>{const key=sceneIdentity(spec);if(seen.has(key)||(counts.get(spec.target.id)??0)>=(controlFamily?8:5))return false;seen.add(key);counts.set(spec.target.id,(counts.get(spec.target.id)??0)+1);return true;});
}
