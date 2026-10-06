import { parsePackage, validateValue, type Binding, type PresentationPackage, type RehearsalAction, type Scalar } from './schema';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

export interface RehearsalState {
  mode: 'rehearsal'; sandboxId: string; revision: number; elapsedMs: number;
  workspaceMode: 'prepare' | 'rehearsal';
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
  | { type: 'pause'; paused: boolean }
  | { type: 'vote'; playerId: string; choiceId: string }
  | { type: 'reaction'; playerId: string }
  | { type: 'reset' } | { type: 'stop' };

export function evaluate(binding: Binding, state: RehearsalState, props: Record<string, Scalar> = {}, budget = 64): Scalar {
  if (budget <= 0) throw new Error('Binding budget exceeded.');
  if (typeof binding !== 'object') return binding;
  if ('get' in binding) {
    const [scope, key] = binding.get.split('.');
    const data = scope === 'props' ? props : scope === 'values' ? state.values : scope === 'feeds' ? state.feeds : state.show;
    const v = (data as Record<string, Scalar>)[key];
    if (!Object.prototype.hasOwnProperty.call(data, key)) throw new Error(`Missing binding ${binding.get}.`);
    return v;
  }
  const next = (b: Binding) => evaluate(b, state, props, budget - 1);
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

/** Simulation has no transport/native/recording adapter. An imported command
 * cannot change that; unknown event/action types are refused at this boundary.
 */
export class RehearsalSession {
  readonly package: PresentationPackage;
  private state: RehearsalState;
  private voters = new Map<string, string>();
  private listeners = new Set<() => void>();
  private reactionTimes = new Map<string, number>();
  private heatEvents: number[] = [];
  private sandboxId: string;
  private workspaceMode: RehearsalState['workspaceMode'];
  private preparation?: Pick<RehearsalState, 'layoutId' | 'values' | 'feeds'>;
  constructor(doc: unknown, sandboxId = `rehearsal-${crypto.randomUUID()}`, workspaceMode: RehearsalState['workspaceMode'] = 'rehearsal') {
    this.workspaceMode = workspaceMode;
    this.package = freeze(parsePackage(doc)); this.sandboxId = sandboxId; this.state = freeze(this.initial());
  }
  private initial(): RehearsalState {
    return { mode: 'rehearsal', workspaceMode: this.workspaceMode, sandboxId: this.sandboxId, revision: 0, elapsedMs: 0, running: false, paused: false,
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
  exitRehearsal = (): boolean => {
    if (this.workspaceMode !== 'rehearsal') return false;
    this.workspaceMode = 'prepare'; this.freshBoundary(); this.preparation = undefined; return true;
  };
  private freshBoundary() {
    this.voters.clear(); this.reactionTimes.clear(); this.heatEvents = [];
    this.sandboxId = `rehearsal-${crypto.randomUUID()}`;
    this.state = freeze(this.initial()); this.emit();
  }
  snapshot = () => this.state;
  /** Export configured defaults, never practice edits, identities or results. */
  exportPreparedPackage = (): PresentationPackage => {
    const doc = structuredClone(this.package);
    const configured = this.workspaceMode === 'prepare' ? this.state : this.preparation;
    if (configured) {
      doc.set.initialLayout = configured.layoutId;
      for (const [key, value] of Object.entries(configured.values)) doc.set.values[key].default = value;
      for (const [key, value] of Object.entries(configured.feeds)) doc.set.feeds[key].default = value;
    }
    return parsePackage(doc);
  };
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  send(event: SimulationEvent): boolean {
    const next = structuredClone(this.state);
    const log = (message: string) => { next.trace = [...next.trace.slice(-29), { at: next.elapsedMs, message }]; };
    try {
      if (!event || typeof event !== 'object') throw new Error('Invalid rehearsal event.');
      if (this.workspaceMode === 'prepare' &&
        (['pause', 'tick', 'vote', 'reaction', 'stop'].includes(event.type) || event.type === 'control' && event.action.type.startsWith('show.')))
        throw new Error('Enter rehearsal before running the show or sending practice inputs.');
      switch (event.type) {
        case 'reset':
          this.voters.clear(); this.reactionTimes.clear(); this.heatEvents = [];
          this.state = freeze(this.initial()); this.emit(); return true;
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
              log('Show started in rehearsal.'); break;
            }
            case 'show.next': {
              if (!this.package.show || !next.running || next.paused) throw new Error('Cannot advance.');
              const phase = this.package.show.phases.find(p => p.id === next.show.phase)!;
              if (!phase.next) throw new Error('This is the final phase.');
              if (next.show.collecting || phase.collectMs && !next.show.revealed) throw new Error('Close and reveal the round first.');
              const target = this.package.show.phases.find(p => p.id === phase.next)!;
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
      next.revision++; this.state = freeze(next); this.emit(); return true;
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
