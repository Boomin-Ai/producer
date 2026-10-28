import {SetRuntime,type Snapshot as ModuleSnapshot,type Command as ModuleCommand,type Result as ModuleResult} from '../../../shared/set-runtime/runtime';
import {runtimeFields} from '../../../shared/set-runtime/projection';
let moduleEpoch=Date.now();
import {enterMedia,mediaPosition,layoutMedia,playable,type MediaTransport,type PlaybackConfig} from './playback';
import {outputProjection} from './projection';
import {layoutTransition} from './layoutTransition';
import {clockPosition,type AnimationTrack,type AnimationClock} from './animation';
import { parsePackage, validateValue, type Binding, type PresentationPackage, type RehearsalAction, type Scalar } from './schema';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

export interface RehearsalState {
  moduleCommit:{setEpoch:number;revision:number};
  modules:Record<string,Record<string,Scalar>>;
  moduleConnection:'private'|'simulation'|'connecting'|'live'|'error';
  moduleError:string;
  media?:Record<string,MediaTransport>;
  animationClock?:AnimationClock;
  layoutMotion?:AnimationTrack[];
  layoutMotionId?:string;
  layoutMotions?:Record<string,AnimationTrack[]>;
  mode: 'rehearsal' | 'live'; sandboxId: string; revision: number; elapsedMs: number;
  workspaceMode: 'prepare' | 'rehearsal' | 'live';
  running: boolean; paused: boolean; layoutId: string;
  values: Record<string, Scalar>; feeds: Record<string, Scalar>;
  show: { phase: string; collecting: boolean; revealed: boolean; winner: string; result: '' | 'winner' | 'draw'; ballot: number;
    heat: number; remainingMs: number; total: number };
  ballotChoiceIds: string[]; ballotHistory: Array<{ ballot: number; counts: Record<string, number>; total: number }>;
  counts: Record<string, number>; trace: Array<{ at: number; message: string }>;
}
export type SimulationEvent =
  | { type: 'control'; action: RehearsalAction }
  | { type: 'field'; key: string; value: Scalar }
  | { type: 'feed'; key: string; value: Scalar }
  | { type: 'tick'; milliseconds: number }
  | { type: 'segment.select'; phaseId:string }
  | { type: 'seek'; milliseconds:number }
  | { type: 'pause'; paused: boolean }
  | { type: 'vote'; playerId: string; choiceId: string }
  | { type: 'reaction'; playerId: string }
  | { type: 'reset' } | { type: 'stop' };

export function evaluate(binding: Binding, state: RehearsalState, props: Record<string, Scalar> = {}, budget = 64, tokens: Record<string, Scalar> = {}): Scalar {
  if (budget <= 0) throw new Error('Binding budget exceeded.');
  if (typeof binding !== 'object') return binding;
  if ('get' in binding) {
    if(binding.get==='show.layoutId')return state.layoutId;
    const [scope, key,field] = binding.get.split('.');
    if(scope==='modules'){const values=state.modules?.[key];if(!values||!Object.prototype.hasOwnProperty.call(values,field))throw new Error('Missing module output '+binding.get);return values[field];}
    const data = scope === 'tokens' ? tokens : scope === 'props' ? props : scope === 'values' ? state.values : scope === 'feeds' ? state.feeds : state.show;
    const v = (data as Record<string, Scalar>)[key];
    if (!Object.prototype.hasOwnProperty.call(data, key)) throw new Error(`Missing binding ${binding.get}.`);
    return v;
  }
  const next = (b: Binding) => evaluate(b, state, props, budget - 1, tokens);
  if (binding.op === 'eq') return next(binding.args[0]) === next(binding.args[1]);
  if (binding.op === 'if') {
    const condition = next(binding.args[0]);
    if (typeof condition !== 'boolean') throw new Error('Condition must be boolean.');
    return next(binding.args[condition ? 1 : 2]);
  }
  const text = binding.args.map(next).join('');
  if (text.length > 1024) throw new Error('Text binding exceeds limit.');
  return text;
}

function hasShader(doc:PresentationPackage,node:PresentationPackage['set']['layouts'][number]['root']):boolean {
  return node.type==='shader'||node.type==='scene3d'||node.type==='component'&&hasShader(doc,doc.set.components[node.component!].root)||(node.children??[]).some(child=>hasShader(doc,child));
}

/** Simulation has no transport/native/recording adapter. An imported command
 * cannot change that; unknown event/action types are refused at this boundary.
 */
export class RehearsalSession {
  package: PresentationPackage;
  private state: RehearsalState;
  moduleRuntime:SetRuntime;
  private stopModules?:()=>void;
  private liveModules?:ModuleSnapshot;
  private moduleTransport?:((command:ModuleCommand)=>Promise<ModuleResult>);
  private voters = new Map<string, string>();
  private listeners = new Set<() => void>();
  private reactionTimes = new Map<string, number>();
  private heatEvents: number[] = [];
  private sandboxId: string;
  private workspaceMode: RehearsalState['workspaceMode'];
  private preparation?: Pick<RehearsalState, 'layoutId' | 'values' | 'feeds'>;
  constructor(doc: unknown, sandboxId = `rehearsal-${crypto.randomUUID()}`, workspaceMode: RehearsalState['workspaceMode'] = 'rehearsal') {
    this.workspaceMode = workspaceMode;
    this.package = freeze(parsePackage(doc)); this.sandboxId = sandboxId;this.moduleRuntime=this.createModules();this.state = freeze(this.initial());this.observeModules();
  }
  private initial(): RehearsalState {
    const media:Record<string,MediaTransport>={};enterMedia(this.package,undefined,this.preparation?.layoutId??this.package.set.initialLayout,media);
    return { moduleCommit:{setEpoch:this.moduleRuntime.snapshot().setEpoch,revision:this.moduleRuntime.snapshot().revision},modules:runtimeFields(this.moduleRuntime.snapshot(),this.package.runtime),moduleConnection:this.workspaceMode==='live'?'connecting':this.workspaceMode==='rehearsal'?'simulation':'private',moduleError:'',media,...(this.package.set.layouts.some(l=>l.animation||hasShader(this.package,l.root))?{animationClock:{running:!this.package.show,positionMs:0,segmentMs:0,anchorMs:Date.now()}}:{}), mode: this.workspaceMode==='live'?'live':'rehearsal', workspaceMode: this.workspaceMode, sandboxId: this.sandboxId, revision: 0, elapsedMs: 0, running: false, paused: false,
      layoutId: this.package.set.initialLayout,
      values: Object.fromEntries(Object.entries(this.package.set.values).map(([k, v]) => [k, v.default])),
      feeds: Object.fromEntries(Object.entries(this.package.set.feeds).map(([k, v]) => [k, v.default])),
      show: { phase: this.package.show?.initialPhase ?? '', collecting: false, revealed: false, winner: '', result: '', ballot: 1, heat: 0, remainingMs: 0, total: 0 },
      ballotChoiceIds: (this.package.show?.choices ?? []).map(c => c.id), ballotHistory: [],
      counts: Object.fromEntries((this.package.show?.choices ?? []).map(c => [c.id, 0])), trace: [],
      ...structuredClone(this.preparation ?? {}) };
  }
  /** These are trusted workspace operations, never imported package actions.
   * Practice fields/results cannot become prepared configuration on exit. */
  enterRehearsal = (): boolean => {
    if (this.workspaceMode !== 'prepare') return false;
    this.preparation = structuredClone({ layoutId: this.state.layoutId, values: this.state.values, feeds: this.state.feeds });
    this.workspaceMode = 'rehearsal'; this.freshBoundary(); return true;
  };
  /** The room runner shares segment semantics, but owns a separate runtime boundary. */
  enterLive = (): boolean => {
    if(this.workspaceMode !== 'prepare')return false;
    this.preparation=structuredClone({layoutId:this.state.layoutId,values:this.state.values,feeds:this.state.feeds});
    this.workspaceMode='live';this.freshBoundary();return true;
  };
  exitRehearsal = (): boolean => {
    if (this.workspaceMode !== 'rehearsal') return false;
    this.workspaceMode = 'prepare'; this.freshBoundary(); this.preparation = undefined; return true;
  };
  private freshBoundary() {
    this.voters.clear(); this.reactionTimes.clear(); this.heatEvents = [];
    this.sandboxId = `rehearsal-${crypto.randomUUID()}`;
    this.stopModules?.();this.moduleRuntime.shutdown();this.liveModules=undefined;this.moduleTransport=undefined;this.moduleLifecycleTransport=undefined;this.moduleRuntime=this.createModules();this.state = freeze(this.initial());this.observeModules();this.syncModuleLifecycle();this.emit();
  }
  private lastControllerState='';
  private controllerState(snapshot:ModuleSnapshot){const id=this.package.set.viewController,m=id?snapshot.modules[id]:undefined;return m?JSON.stringify([m.epoch,m.view,m.values]):'';}
  private applyModuleView(snapshot:ModuleSnapshot){
    const id=this.package.set.viewController,view=id?snapshot.modules[id]?.view:undefined;const stamp=this.controllerState(snapshot);if(!view||stamp===this.lastControllerState)return;this.lastControllerState=stamp;
    const variants=this.package.set.views?.[view],current=this.package.set.layouts.find(l=>l.id===this.state.layoutId);if(!variants||!current)return;
    const orientation=current.width>current.height?'landscape':current.width<current.height?'portrait':'square',layout=variants[orientation];if(layout&&layout!==this.state.layoutId)this.send({type:'control',action:{type:'layout.select',layoutId:layout}});
  }
  private createModules(){return new SetRuntime(this.package.runtime,{epoch:++moduleEpoch,domain:this.workspaceMode==='live'?'live':'rehearsal',capabilities:['audience.vote@1','audience.text@1','data.weather@1','data.agent@1','room.chat@1']});}
  private observeModules(){this.lastControllerState=this.controllerState(this.moduleRuntime.snapshot());this.stopModules=this.moduleRuntime.subscribe(()=>{this.state=freeze({...this.state,moduleCommit:{setEpoch:this.moduleRuntime.snapshot().setEpoch,revision:this.moduleRuntime.snapshot().revision},modules:runtimeFields(this.moduleRuntime.snapshot(),this.package.runtime),revision:this.state.revision+1});this.applyModuleView(this.moduleRuntime.snapshot());this.emit();});}
  private moduleLifecycleTransport?: (state:{segment:string;running:boolean;paused:boolean})=>void;
  attachModuleLifecycle=(send:typeof this.moduleLifecycleTransport)=>{this.moduleLifecycleTransport=send;if(send)this.syncModuleLifecycle();};
  private syncModuleLifecycle(){
    if(this.workspaceMode==='live'){this.moduleLifecycleTransport?.({segment:this.state.show.phase,running:this.state.running,paused:this.state.paused});return;}
    if(this.workspaceMode!=='rehearsal')return;
    this.moduleRuntime.orchestrate({setEpoch:this.moduleRuntime.snapshot().setEpoch,segment:this.state.show.phase,running:this.state.running,paused:this.state.paused,showAttached:!!this.package.show},{role:'show',id:'show-runner',modules:this.package.runtime.instances.map(i=>i.id)},Date.now());
  }
  receiveModuleData=(command:ModuleCommand):ModuleResult=>{
    if(this.workspaceMode!=='rehearsal')return {status:'rejected',revision:this.moduleSnapshot().revision,error:'Rehearsal connection expired'};
    return this.moduleRuntime.dispatch(command,{role:'connector',id:'saved-connection',modules:[command.module]},Date.now());
  };
  moduleParticipantSnapshot=()=>this.moduleRuntime.public();
  moduleSnapshot=()=>this.liveModules??this.moduleRuntime.snapshot();
  attachModuleTransport=(send:((command:ModuleCommand)=>Promise<ModuleResult>)|undefined,error='')=>{
    this.moduleTransport=send;
    const moduleConnection=error?'error':send?'live':this.workspaceMode==='live'?'connecting':this.workspaceMode==='rehearsal'?'simulation':'private';
    if(this.state.moduleConnection===moduleConnection&&this.state.moduleError===error)return;
    this.state=freeze({...this.state,moduleConnection,moduleError:error});this.emit();
  };
  receiveModuleSnapshot=(snapshot:ModuleSnapshot)=>{
    if(this.workspaceMode!=='live')return;
    if(this.liveModules&&(snapshot.setEpoch<this.liveModules.setEpoch||snapshot.setEpoch===this.liveModules.setEpoch&&snapshot.revision<=this.liveModules.revision))return;
    this.liveModules=freeze(structuredClone(snapshot));this.state=freeze({...this.state,moduleCommit:{setEpoch:this.liveModules.setEpoch,revision:this.liveModules.revision},modules:runtimeFields(this.liveModules,this.package.runtime),revision:this.state.revision+1});this.applyModuleView(this.liveModules);this.emit();
  };
  sendModule=async(module:string,op:string,input:Record<string,Scalar>={},participant?:string):Promise<ModuleResult>=>{
    const snapshot=this.moduleSnapshot(),target=snapshot.modules[module];
    if(!target)return {status:'rejected',revision:snapshot.revision,error:'Unknown module'};
    const command:ModuleCommand={id:crypto.randomUUID(),setEpoch:snapshot.setEpoch,module,epoch:target.epoch,op,input};
    if(this.workspaceMode==='live'){
      if(participant)return {status:'rejected',revision:snapshot.revision,error:'Use the audience connection for live inputs'};
      if(!this.moduleTransport)return {status:'rejected',revision:snapshot.revision,error:this.state.moduleError||'Live module service is not connected'};
      return this.moduleTransport(command);
    }
    if(this.workspaceMode!=='rehearsal')return {status:'rejected',revision:snapshot.revision,error:'Enter rehearsal to simulate module controls'};
    return this.moduleRuntime.dispatch(command,{role:participant?'audience':'operator',id:participant??'operator',modules:[module]},Date.now());
  };
  snapshot = () => this.state;
  /** Export configured defaults, never practice edits, identities or results. */
  exportPreparedPackage = (): PresentationPackage => {
    const doc = structuredClone(this.package);
    const configured = this.workspaceMode === 'prepare' ? this.state : this.preparation;
    if (configured) {
      doc.set.initialLayout = configured.layoutId;
      if(doc.set.views){const view=Object.entries(doc.set.views).find(([,variants])=>Object.values(variants).includes(configured.layoutId));if(view)doc.set.initialView=view[0];else delete doc.set.initialView;}
      for (const [key, value] of Object.entries(configured.values)) doc.set.values[key].default = value;
      for (const [key, value] of Object.entries(configured.feeds)) doc.set.feeds[key].default = value;
    }
    return parsePackage(doc);
  };
  configureMedia = (id:string,config:PlaybackConfig) => {
    const doc=structuredClone(this.package);if(!doc.set.assets?.[id])throw new Error('Unknown asset.');
    doc.set.assets[id].playback=config;this.package=freeze(parsePackage(doc));
    this.state=freeze({...this.state,revision:this.state.revision+1});this.emit();
  };
  replaceMedia = (id:string,asset:import('./assets').MediaAsset) => {
    const doc=structuredClone(this.package);if(!doc.set.assets?.[id])throw new Error('Unknown asset.');
    doc.set.assets[id]={...asset,playback:doc.set.assets[id].playback};this.package=freeze(parsePackage(doc));
    const media={...this.state.media,[id]:{playing:false,positionMs:0,anchorMs:Date.now()}};
    this.state=freeze({...this.state,media,revision:this.state.revision+1});this.emit();
  };
  mediaCommand = (id:string,command:'play'|'pause'|'restart'|'stop') => {
    if(!layoutMedia(this.package,this.state.layoutId,true,this.state).has(id)||!playable(this.package.set.assets?.[id]?.mime??''))return false;
    const now=Date.now(),media=structuredClone(this.state.media??{}),t=media[id]??{playing:false,positionMs:0,anchorMs:now};
    media[id]={playing:command!=='pause'&&command!=='stop',positionMs:command==='restart'||command==='stop'?0:mediaPosition(t,now),anchorMs:now};
    this.state=freeze({...this.state,media,revision:this.state.revision+1});this.emit();return true;
  };
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  send(event: SimulationEvent): boolean {
    const next = structuredClone(this.state);
    const log = (message: string) => { next.trace = [...next.trace.slice(-29), { at: next.elapsedMs, message }]; };
    try {
      if (!event || typeof event !== 'object') throw new Error('Invalid rehearsal event.');
      if (this.workspaceMode === 'prepare' &&
        (['pause', 'tick', 'seek', 'vote', 'reaction', 'stop'].includes(event.type) || event.type === 'control' && event.action.type.startsWith('show.')))
        throw new Error('Enter rehearsal before running the show or sending practice inputs.');
      if(this.workspaceMode==='live'&&(['vote','reaction','feed'].includes(event.type)||event.type==='control'&&['show.vote','show.react'].includes(event.action.type)))
        throw new Error('Audience inputs require a connected data source. Practice inputs are available in editor rehearsal.');
      switch (event.type) {
        case 'segment.select': {
          const target=this.package.show?.phases.find(p=>p.id===event.phaseId);
          if(!target)throw new Error('Unknown segment.');
          if(target.id===next.show.phase&&target.layoutId===next.layoutId)return true;
          next.show.phase=target.id;next.layoutId=target.layoutId;
          next.paused=next.running&&this.workspaceMode!=='live';next.show.remainingMs=target.collectMs??0;
          next.show.collecting=next.running&&!!target.collectMs;
          if(target.collectMs){this.voters.clear();next.ballotChoiceIds=this.package.show!.choices.map(c=>c.id);next.ballotHistory=[];next.show.ballot=1;next.show.result='';next.show.total=0;next.show.revealed=false;next.show.winner='';Object.keys(next.counts).forEach(k=>next.counts[k]=0);}
          log(`Editing segment: ${target.label}.`);break;
        }
        case 'seek': if(!Number.isFinite(event.milliseconds)||event.milliseconds<0||event.milliseconds>60_000)throw new Error('Invalid segment animation time.');break;
        case 'reset':
          this.voters.clear(); this.reactionTimes.clear(); this.heatEvents = [];
          this.state = freeze(this.initial()); this.syncModuleLifecycle();this.emit(); return true;
        case 'stop': next.running = false; next.paused = false; next.show.collecting = false; log('Run stopped.'); break;
        case 'pause': if (!next.running || typeof event.paused !== 'boolean') throw new Error('Start the show before pausing.'); next.paused = event.paused; log(event.paused ? 'Paused.' : 'Resumed.'); break;
        case 'field': this.writeValue(next.values, this.package.set.values, event.key, event.value); break;
        case 'feed': this.writeValue(next.feeds, this.package.set.feeds, event.key, event.value); log(`Sample feed updated: ${event.key}.`); break;
        case 'tick': {
          if (!Number.isFinite(event.milliseconds) || event.milliseconds < 0 || event.milliseconds > 3_600_000) throw new Error('Invalid simulated time.');
          if (next.paused || !next.running) return false;
          next.elapsedMs += event.milliseconds;
          if (next.show.collecting) { next.show.remainingMs = Math.max(0, next.show.remainingMs - event.milliseconds); if (!next.show.remainingMs) { next.show.collecting = false; log('Answers closed. Results await reveal.'); } }
          this.heatEvents = this.heatEvents.filter(t => t > next.elapsedMs - 10_000);
          next.show.heat = Math.min(1, this.heatEvents.length / 5); break;
        }
        case 'vote': this.vote(next, event.playerId, event.choiceId); log(`${event.playerId} input accepted.`); break;
        case 'reaction': {
          if (!next.running || next.paused || !/^[a-zA-Z0-9_-]{1,40}$/.test(event.playerId)) throw new Error('Reaction unavailable.');
          const last = this.reactionTimes.get(event.playerId);
          if (last !== undefined && next.elapsedMs - last < 1000) throw new Error('Reaction cooldown.');
          if (this.reactionTimes.size >= 100 && last === undefined) throw new Error('Simulation participant limit.');
          this.reactionTimes.set(event.playerId, next.elapsedMs); this.heatEvents.push(next.elapsedMs);
          next.show.heat = Math.min(1, this.heatEvents.length / 5); break;
        }
        case 'control': {
          const a = event.action;
          switch (a.type) {
            case 'layout.select': if (!this.package.set.layouts.some(l => l.id === a.layoutId)) throw new Error('Unknown layout.'); next.layoutId = a.layoutId; log(`Layout: ${a.layoutId}.`); break;
            case 'value.set': this.writeValue(next.values, this.package.set.values, a.key, a.value); break;
            case 'show.start': {
              if (!this.package.show || next.running) throw new Error('Show cannot start.');
              this.voters.clear(); this.reactionTimes.clear(); this.heatEvents = [];
              const initial = this.initial();
              next.show = initial.show; next.counts = initial.counts; next.ballotChoiceIds = initial.ballotChoiceIds; next.ballotHistory = [];
              const phase = this.package.show.phases.find(p => p.id === this.package.show!.initialPhase)!;
              next.running = true; next.paused = false; next.elapsedMs = 0;
              next.layoutId = phase.layoutId;
              next.show.remainingMs = phase.collectMs ?? 0; next.show.collecting = !!phase.collectMs;
              log(this.workspaceMode==='live'?'Show started on room output.':'Show started in rehearsal.'); break;
            }
            case 'show.previous':
            case 'show.next': {
              if (!this.package.show || !next.running || next.paused) throw new Error('Cannot advance.');
              const phase = this.package.show.phases.find(p => p.id === next.show.phase)!;
              const previous = this.package.show.phases.find(p => p.next === phase.id);
              if (a.type==='show.next'&&!phase.next) throw new Error('This is the final phase.');
              if (a.type==='show.previous'&&!previous) throw new Error('This is the first phase.');
              if (next.show.collecting || phase.collectMs && !next.show.revealed) throw new Error('Close and reveal the round first.');
              const target = a.type==='show.previous'?previous!:this.package.show.phases.find(p => p.id === phase.next)!;
              next.show.phase = target.id; next.layoutId = target.layoutId;
              next.show.remainingMs = target.collectMs ?? 0; next.show.collecting = !!target.collectMs;
              if (target.collectMs) { this.voters.clear(); next.ballotChoiceIds = this.package.show.choices.map(c => c.id); next.ballotHistory = []; next.show.ballot = 1; next.show.result = ''; next.show.total = 0; next.show.revealed = false; next.show.winner = ''; Object.keys(next.counts).forEach(k => next.counts[k] = 0); }
              log(`Phase: ${target.label}.`); break;
            }
            case 'show.vote': this.vote(next, 'sample-player', a.choiceId); log('Sample player input accepted.'); break;
            case 'show.reopen':
            case 'show.tiebreak': {
              const phase = this.package.show?.phases.find(p => p.id === next.show.phase);
              if (!next.running || next.paused || !phase?.collectMs || next.show.collecting || next.show.revealed) throw new Error('Only a closed, unresolved voting segment can reopen.');
              if (a.type === 'show.tiebreak') {
                const leaders = voteLeaders(next);
                if (!next.show.total || leaders.length < 2) throw new Error('A tie-break requires a tied result.');
                if (next.ballotHistory.length >= 16) throw new Error('Tie-break limit reached. Reopen the ballot or reveal a draw.');
                next.ballotHistory.push({ ballot: next.show.ballot, counts: { ...next.counts }, total: next.show.total });
                next.ballotChoiceIds = leaders; next.show.ballot++; next.show.total = 0;
                Object.keys(next.counts).forEach(k => next.counts[k] = 0);
                this.voters.clear();
              }
              next.show.remainingMs = phase.collectMs; next.show.collecting = true;
              log(a.type === 'show.tiebreak' ? 'Tie-break ballot opened. Previous results preserved; participants may vote again.' : 'Voting reopened. Existing votes and voter receipts preserved.'); break;
            }
            case 'show.draw': {
              const phase = this.package.show?.phases.find(p => p.id === next.show.phase);
              if (!next.running || next.paused || !phase?.collectMs || next.show.collecting || next.show.revealed || !next.show.total || voteLeaders(next).length < 2) throw new Error('Only a closed tied vote can finish as a draw.');
              next.show.result = 'draw'; next.show.winner = ''; next.show.revealed = true;
              log('Draw revealed by operator. No winner awarded.'); break;
            }
            case 'show.reveal': {
              if (!next.running || next.paused || next.show.collecting || next.show.revealed || !this.voters.size) throw new Error('Close voting and resolve a nonzero result before reveal.');
              const ordered = Object.entries(next.counts).sort((a, b) => b[1] - a[1]);
              if (ordered[0][1] === ordered[1][1]) throw new Error('Tied vote: reopen voting, start a tie-break, or reveal a draw.');
              next.show.winner = this.package.show!.choices.find(c => c.id === ordered[0][0])!.label;
              next.show.result = 'winner'; next.show.revealed = true; log('Winner revealed.'); break;
            }
            default: throw new Error('Unregistered rehearsal action.');
          }
          break;
        }
        default: throw new Error('Unregistered rehearsal event.');
      }
      next.media??={};
      const animationNow=Date.now(),oldClock=this.state.animationClock??{running:false,positionMs:this.state.elapsedMs,segmentMs:0,anchorMs:animationNow};
      const position=clockPosition(oldClock,animationNow);
      if(event.type==='control'&&event.action.type==='show.start'){position.positionMs=0;position.segmentMs=0;}
      else if(next.layoutId!==this.state.layoutId||next.show.phase!==this.state.show.phase)position.segmentMs=0;
      else if(event.type==='tick'){position.positionMs+=event.milliseconds;position.segmentMs+=event.milliseconds;}
      else if(event.type==='seek'){position.positionMs+=event.milliseconds-position.segmentMs;position.segmentMs=event.milliseconds;for(const [id,t]of Object.entries(next.media))next.media[id]={...t,positionMs:event.milliseconds,anchorMs:animationNow};}
      // Control edges update the anchor. Ordinary content edits retain it, so
      // editing a title never restarts an animation.
      if(this.state.animationClock&&(['pause','stop','tick','seek','segment.select'].includes(event.type)||event.type==='control'&&(['show.start','show.next','show.previous','layout.select'].includes(event.action.type))))next.animationClock={...position,positionMs:Math.max(0,position.positionMs),running:(!this.package.show||next.running)&&!next.paused,anchorMs:animationNow};
      if(next.layoutId!==this.state.layoutId){
        delete next.layoutMotion;delete next.layoutMotionId;delete next.layoutMotions;
        const transition=this.package.set.layouts.find(l=>l.id===next.layoutId)?.animation?.transition;
        if(transition?.type==='morph'&&transition.durationMs>0&&(!this.package.show||next.running)&&!next.paused){
          next.layoutMotionId=next.layoutId;next.layoutMotion=layoutTransition(outputProjection(this.package,this.state),outputProjection(this.package,next),transition.durationMs,animationNow);
          next.layoutMotions={[next.layoutId]:next.layoutMotion};
          const variants=(layout:string)=>Object.values(this.package.set.views??{}).find(v=>Object.values(v).includes(layout));
          const fromVariants=variants(this.state.layoutId),toVariants=variants(next.layoutId);
          for(const orientation of ['landscape','portrait','square'] as const){
            const fromId=fromVariants?.[orientation],toId=toVariants?.[orientation];
            if(!fromId||!toId||toId===next.layoutId)continue;
            const from={...this.state,layoutId:fromId,layoutMotionId:fromId,layoutMotion:this.state.layoutMotions?.[fromId]};
            const to={...next,layoutId:toId,layoutMotion:undefined,layoutMotionId:undefined,layoutMotions:undefined};
            next.layoutMotions[toId]=layoutTransition(outputProjection(this.package,from),outputProjection(this.package,to),transition.durationMs,animationNow);
          }
        }
      }
      if(event.type==='stop'){delete next.layoutMotion;delete next.layoutMotionId;delete next.layoutMotions;}
      if(event.type==='control'&&event.action.type==='show.start')enterMedia(this.package,undefined,next.layoutId,next.media);
      else enterMedia(this.package,this.state.layoutId,next.layoutId,next.media,Date.now(),this.state,next);
      if(event.type==='pause'||event.type==='stop'||event.type==='segment.select'&&next.running){
        const now=Date.now();for(const [id,t]of Object.entries(next.media)){
          if(event.type==='pause'&&!event.paused){if(t.resumeAfterPause)next.media[id]={playing:true,positionMs:t.positionMs,anchorMs:now};}
          else next.media[id]={playing:false,positionMs:mediaPosition(t,now),anchorMs:now,resumeAfterPause:(event.type==='pause'||event.type==='segment.select')&&t.playing};
        }
      }
      next.revision++; this.state = freeze(next);this.syncModuleLifecycle();this.emit(); return true;
    } catch (e) {
      const rejected = structuredClone(this.state);
      rejected.trace = [...rejected.trace.slice(-29), { at: rejected.elapsedMs, message: `Rejected: ${e instanceof Error ? e.message : 'Invalid input.'}` }];
      this.state = freeze(rejected); this.emit(); return false;
    }
  }
  private writeValue(target: Record<string, Scalar>, defs: PresentationPackage['set']['values'], key: string, value: Scalar) {
    if (!Object.prototype.hasOwnProperty.call(defs, key)) throw new Error('Unknown field.');
    target[key] = validateValue(defs[key], value, key);
  }
  private vote(next: RehearsalState, player: string, choice: string) {
    if (!next.running || next.paused || !next.show.collecting || next.show.remainingMs <= 0) throw new Error('Voting is closed.');
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(player) || !Object.prototype.hasOwnProperty.call(next.counts, choice)) throw new Error('Unknown player/choice.');
    if (!next.ballotChoiceIds.includes(choice)) throw new Error('Choice is not eligible for this ballot.');
    if (this.voters.has(player)) throw new Error('This player already answered.');
    if (this.voters.size >= 100) throw new Error('Simulation participant limit.');
    this.voters.set(player, choice); next.counts[choice]++; next.show.total++;
  }
  private emit() { this.listeners.forEach(fn => fn()); }
}

/** Leaders of this ballot only; zero votes are not a tied result. */
export function voteLeaders(state: RehearsalState): string[] {
  if (!state.show.total) return [];
  const high = Math.max(...state.ballotChoiceIds.map(id => state.counts[id]));
  return state.ballotChoiceIds.filter(id => state.counts[id] === high);
}
