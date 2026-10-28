import {outputProjection,type OutputProjection,type RenderNode} from '../presentation/projection';
import type {AnimationTrack} from '../presentation/animation';
import {mediaPosition} from '../presentation/playback';
import {layoutTransition} from '../presentation/layoutTransition';
import {RehearsalSession} from '../presentation/rehearsal';
import {compileRoomScene,nativeNodeId} from './roomCompiler';
import type {RenderPlan,OutputTarget} from './scene';

export type SceneReadiness={state:'queued'|'loading'|'ready'|'error';error?:string};
export type NativeSceneStatus={preparedRevision:number;renderedRevision:number;ready:boolean;warmed:boolean;transitioning:boolean;queued:boolean;cachedKeys?:string[];cachedBytes?:number;renderSerial:number};
type Plan=RenderPlan&{motion?:AnimationTrack[];clock?:import('../presentation/animation').AnimationClock;retainedTargets?:string[];assets?:OutputProjection['assets']};
export type SceneSpec={projection:OutputProjection;phase:string;layout:string;bindings:Record<string,string>;target:OutputTarget;definition:string;instance:string;targets:string[];assetVersion:string;speculative?:boolean};
type Entry={pins:number;key:string;identity:string;spec:SceneSpec;state:SceneReadiness;plan?:Plan;promise?:Promise<Entry>};
type Job={priority:number;run:(abort:()=>boolean)=>Promise<unknown>;resolve:(v:any)=>void;reject:(e:unknown)=>void;preemptible:boolean};
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
 private inventory?:SceneSpec[];private active=new Map<string,SceneSpec>();
 private outputs=new Set<string>();
 private trace:string[]=[];
 debug(){return {working:this.working,abort:this.abort,queue:this.jobs.map(j=>j.priority),trace:this.trace,entries:[...this.entries.values()].map(e=>({layout:e.spec.layout,target:e.spec.target,key:e.key,state:e.state}))};}
 private log(message:string){this.trace=[...this.trace.slice(-15),message];}
 private entries=new Map<string,Entry>();private jobs:Job[]=[];private working=false;private abort=false;private background=false;private disposed=false;private revision=0;
 constructor(private send:(request:Record<string,unknown>)=>Promise<NativeSceneStatus>,private changed:()=>void,private compile=compileRoomScene){debugSessions.add(this);}
 get(spec:SceneSpec){const identity=sceneIdentity(spec),key=digest(identity);let entry=this.entries.get(key);if(entry&&entry.identity!==identity)throw Error('Prepared scene identity collision');if(!entry){entry={pins:0,key,identity,spec,state:{state:'queued'}};this.entries.set(key,entry);}return entry;}
 readiness(spec:SceneSpec):SceneReadiness{return {...this.get(spec).state};}
 private enqueue<T>(priority:number,preemptible:boolean,run:(abort:()=>boolean)=>Promise<T>):Promise<T>{
  if(this.disposed)return Promise.reject(Error('Room preparation closed'));
  if(priority>=100&&this.background)this.abort=true;
  return new Promise((resolve,reject)=>{this.jobs.push({priority,preemptible,run,resolve,reject});void this.pump();});
 }
 private async pump(){if(this.working||this.disposed)return;this.working=true;try{while(this.jobs.length&&!this.disposed){this.jobs.sort((a,b)=>b.priority-a.priority);const job=this.jobs.shift()!;this.abort=false;this.background=job.preemptible;try{job.resolve(await job.run(()=>this.abort||this.disposed));}catch(e){job.reject(e);}}}finally{this.background=false;this.working=false;}}
 async ensure(spec:SceneSpec,priority=0):Promise<Entry>{
  this.outputs.add(spec.target.id);
  const entry=this.get(spec);if(entry.state.state==='ready')return entry;if(entry.promise){if(priority>=100&&this.background)this.abort=true;return entry.promise;}
  entry.promise=this.enqueue(priority,priority<100,async abort=>{
   this.log('loading '+entry.key+' priority '+priority);entry.state={state:'loading'};this.changed();let revision=0;
   try{
    if(!entry.plan)entry.plan=await this.compile(spec.projection,{definitionId:spec.definition,instanceId:spec.instance,canvasId:spec.layout,target:spec.target,bindings:spec.bindings,retainedTargets:spec.targets}) as Plan;
    if(abort()){this.log('aborted compile '+entry.key);entry.state={state:'queued'};return entry;}
    const status=await this.send({op:'status',outputId:spec.target.id});this.revision=Math.max(this.revision,status.preparedRevision,status.renderedRevision);revision=++this.revision;
    const paused=runtimePlan(entry.plan,{...spec.projection,timeline:spec.projection.timeline?{...spec.projection.timeline,clock:{...spec.projection.timeline.clock,running:false}}:undefined});
    paused.assets=entry.plan.assets;
    const stop=(n:RenderPlan['root'])=>{const p=(n as any).playback;if(p)p.playing=false;n.children.forEach(stop);};stop(paused.root);
    let sent=this.sentAssets.get(spec.target.id);if(!sent){sent=new Map();this.sentAssets.set(spec.target.id,sent);}
    paused.assets=Object.fromEntries(Object.entries(paused.assets??{}).filter(([id,a])=>sent!.get(id)!==a.data));
    await this.send({op:'preload',outputId:spec.target.id,key:entry.key,revision,plan:paused});
    for(const [id,a]of Object.entries(paused.assets??{}))sent.set(id,a.data);
    // Native cold WebGL preparation permits 60s for shader compilation and
    // the first imported paint. Keep the client deadline beyond that fence;
    // an iteration count otherwise cancels valid cold 3D loads at ~12s.
    const deadline=Date.now()+(Object.keys(entry.plan.scenes3d??{}).length?65000:15000);
    while(Date.now()<deadline){
     if(abort()){await this.send({op:'cancel',outputId:spec.target.id,revision}).catch(()=>{});this.log('aborted native '+entry.key);entry.state={state:'queued'};return entry;}
     const state=await this.send({op:'status',outputId:spec.target.id});if(state.cachedKeys?.includes(entry.key)){this.log('ready '+entry.key);entry.state={state:'ready'};return entry;}await sleep(20);
    }
    throw Error('Layout did not finish preparing');
   }catch(e){if(revision)await this.send({op:'cancel',outputId:spec.target.id,revision}).catch(()=>{});entry.plan=undefined;entry.state={state:'error',error:String(e)};throw e;}
   finally{entry.promise=undefined;this.changed();}
  });return entry.promise;
 }
 async take(spec:SceneSpec,run:(entry:Entry,revision:number)=>Promise<void>){
  const pinned=this.get(spec);pinned.pins++;
  try{
   let entry=await this.ensure(spec,100);while(entry.state.state==='queued')entry=await this.ensure(spec,100);
   return await this.enqueue(100,false,async()=>{
    const status=await this.send({op:'status',outputId:spec.target.id});
    if(!status.cachedKeys?.includes(entry.key)){entry.state={state:'queued'};this.changed();throw Error('Prepared scene expired; retry loading');}
    this.revision=Math.max(this.revision,status.preparedRevision,status.renderedRevision)+1;const result=await run(entry,this.revision);this.active.set(spec.target.id,spec);return result;
   });
  }finally{pinned.pins--;await this.trim(100);}
 }
 async preload(specs:SceneSpec[],cancel:()=>boolean){for(const spec of specs){if(cancel()||this.disposed)return;try{const entry=await this.ensure(spec);if(entry.state.state==='queued'&&!cancel()){await sleep(50);await this.ensure(spec);}}catch{/* Per-layout error is exposed; later layouts keep loading. */}}}
 async retain(specs:SceneSpec[]){this.inventory=[...specs];await this.trim();}
 /** Keep authored designs plus the latest presented snapshot per output. Text,
  * scores and segment changes can otherwise accumulate unbounded native scenes.
  * In-flight takes remain pinned; native program ownership protects live frames. */
 private async trim(priority=10){
  if(!this.inventory||this.disposed)return;
  const specs=[...this.inventory,...this.active.values()],wanted=new Set(specs.map(spec=>this.get(spec).key));
  for(const [key,entry]of this.entries)if(!wanted.has(key)&&!entry.promise&&!entry.pins)this.entries.delete(key);
  for(const outputId of new Set([...this.outputs,...specs.map(s=>s.target.id)])){
   await this.enqueue(priority,false,async()=>{
    // Recompute inside the queued task: another output can finish a take while
    // this trim waits, and its newly active scene must remain retained.
    const current=[...(this.inventory??[]),...this.active.values()];
    const keys=[...new Set([...current.filter(s=>s.target.id===outputId).map(s=>this.get(s).key),...[...this.entries.values()].filter(e=>e.pins>0&&e.spec.target.id===outputId).map(e=>e.key)])];
    const retained=[...current,...[...this.entries.values()].filter(e=>e.pins>0).map(e=>e.spec)];
    const assetIds=[...new Set(retained.filter(s=>s.target.id===outputId).flatMap(s=>Object.keys(s.projection.assets??{})))];
    await this.send({op:'retain',outputId,keys,assetIds});
    const sent=this.sentAssets.get(outputId);if(sent)for(const id of sent.keys())if(!assetIds.includes(id))sent.delete(id);
   }).catch(()=>{});
  }
 }
 reset(){this.active.clear();this.sentAssets.clear();this.abort=true;for(const e of this.entries.values())e.state={state:'queued'};this.changed();}
 invalidate(spec:SceneSpec){const entry=this.get(spec);entry.state={state:'queued'};entry.plan=undefined;this.changed();}
 retry(){for(const e of this.entries.values())if(e.state.state==='error')e.state={state:'queued'};this.changed();}
 dispose(){debugSessions.delete(this);this.disposed=true;this.abort=true;for(const job of this.jobs)job.reject(Error('Room preparation closed'));this.jobs=[];this.entries.clear();this.active.clear();this.inventory=undefined;}
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

/** Reserve a scene slot for the presented snapshot while warming at most five
 * candidates per native output. Prefer current composition/view alternatives;
 * do not grow a cartesian product or raise the native texture budget. */
export function warmInventory(specs:SceneSpec[],layouts:ReadonlySet<string>){
 if(!specs.some(spec=>spec.speculative))return specs;
 const score=(spec:SceneSpec)=>layouts.has(spec.layout)?(spec.speculative?2:3):spec.speculative?0:1;
 const ordered=[...specs].sort((a,b)=>score(b)-score(a)),seen=new Set<string>(),counts=new Map<string,number>();
 return ordered.filter(spec=>{const key=sceneIdentity(spec);if(seen.has(key)||(counts.get(spec.target.id)??0)>=5)return false;seen.add(key);counts.set(spec.target.id,(counts.get(spec.target.id)??0)+1);return true;});
}
