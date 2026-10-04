/** Source and participant actions are acknowledged by the one production
 * engine. Accepting a request never changes confirmed composition or clocks. */
export interface RoomSource {
  id: string; participant_id: string; owner_id: string; label: string;
  kind: "camera" | "screen" | "microphone";
  visible: boolean; muted: boolean; ready: boolean; scene_id: string | null; revision: number;
}
export type RoomActionKind = "source.visibility" | "source.mute" | "participant.stage";
export interface RoomAction {
  command_id: string; kind: RoomActionKind; target: string; on: boolean; from: string;
  epoch: number; sequence: number; accepted_at: number; expires_at: number;
  status: "accepted" | "applied" | "failed" | "expired" | "superseded";
  expected_revision?: number; participant_id?: string; scene_id?: string | null; error?: string;
}
export interface RoomActionState {
  epoch: number; publisher: string | null; sequence: number; sources: RoomSource[];
  participants: string[]; on_stage: string[]; commands: RoomAction[];
}
type Storage = { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
export class RoomActionError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
const KEY = "room-actions:v1";
export class RoomActions {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: Storage) {}
  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work); this.tail = result.catch(() => {}); return result;
  }
  private async load(): Promise<RoomActionState> {
    return await this.storage.get<RoomActionState>(KEY) ?? { epoch: 0, publisher: null, sequence: 0, sources: [], participants: [], on_stage: [], commands: [] };
  }
  snapshot(): Promise<RoomActionState> { return this.run(() => this.load()); }
  publish(publisher: string, epoch: number, sources: RoomSource[], participants: string[], onStage: string[]): Promise<RoomActionState> {
    return this.run(async () => {
      const state = await this.load();
      if (epoch < state.epoch || (state.publisher && epoch === state.epoch && state.publisher !== publisher)) throw new RoomActionError("stale_publisher");
      if (publisher !== state.publisher || epoch !== state.epoch) {
        for (const command of state.commands) if (command.status === "accepted") command.status = "superseded";
        state.publisher = publisher; state.epoch = epoch;
      }
      const ids = new Set<string>();
      state.sources = sources.slice(0, 128).flatMap(raw => {
        if (!raw || typeof raw.id !== "string" || raw.id.length > 120 || !raw.id || ids.has(raw.id)
          || typeof raw.participant_id !== "string" || !["camera", "screen", "microphone"].includes(raw.kind)) return [];
        ids.add(raw.id);
        const prior = state.sources.find(s => s.id === raw.id);
        const next = { id: raw.id, participant_id: raw.participant_id.slice(0, 80), owner_id: String(raw.owner_id ?? "").slice(0, 100),
          label: String(raw.label ?? raw.kind).slice(0, 100), kind: raw.kind, visible: raw.visible === true,
          muted: raw.muted !== false, ready: raw.ready === true, scene_id: typeof raw.scene_id === "string" ? raw.scene_id.slice(0, 80) : null,
          revision: prior?.revision ?? 0 };
        if (!prior || ["visible", "muted", "ready", "scene_id", "participant_id"].some(k => prior[k as keyof RoomSource] !== next[k as keyof RoomSource])) next.revision++;
        return [next];
      });
      state.participants = [...new Set(participants.filter(id => typeof id === "string" && id.length <= 80))].slice(0, 128);
      state.on_stage = onStage.filter(id => state.participants.includes(id));
      for (const command of state.commands) if (command.status === "accepted"
        && (command.kind === "participant.stage" ? !state.participants.includes(command.target) : !ids.has(command.target))) {
        command.status = "failed"; command.error = "source_unavailable";
      }
      await this.storage.put(KEY, state); return state;
    });
  }
  submit(input: Pick<RoomAction, "command_id" | "kind" | "target" | "on" | "from" | "expected_revision">, now: number): Promise<RoomAction> {
    return this.run(async () => {
      if (!input || typeof input.command_id !== "string" || !input.command_id || input.command_id.length > 80
        || typeof input.target !== "string" || input.target.length > 120 || typeof input.on !== "boolean"
        || !["source.visibility", "source.mute", "participant.stage"].includes(input.kind)) throw new RoomActionError("invalid_command", 400);
      const state = await this.load();
      const old = state.commands.find(c => c.command_id === input.command_id);
      if (old) {
        if (["kind", "target", "on", "from", "expected_revision"].some(k => old[k as keyof RoomAction] !== input[k as keyof typeof input])) throw new RoomActionError("command_id_conflict");
        return old;
      }
      if (!state.publisher) throw new RoomActionError("host_unavailable", 503);
      const source = state.sources.find(s => s.id === input.target);
      if (input.kind === "participant.stage") {
        if (!state.participants.includes(input.target)) throw new RoomActionError("participant_unavailable", 422);
      } else {
        if (!source) throw new RoomActionError("source_unavailable", 422);
        if (input.kind === "source.visibility" && source.kind === "microphone") throw new RoomActionError("audio_source_has_no_video", 422);
        if (input.expected_revision !== source.revision) throw new RoomActionError("stale_source");
      }
      for (const c of state.commands) if (c.status === "accepted" && c.kind === input.kind && c.target === input.target) c.status = now >= c.expires_at ? "expired" : "superseded";
      const command: RoomAction = { ...input, ...(source ? { participant_id: source.participant_id, scene_id: source.scene_id } : {}), epoch: state.epoch, sequence: ++state.sequence, accepted_at: now, expires_at: now + 6000, status: "accepted" };
      state.commands = [...state.commands.slice(-63), command];
      await this.storage.put(KEY, state); return command;
    });
  }
  acknowledge(publisher: string, epoch: number, id: string, status: "applied" | "failed", now: number, error?: string): Promise<RoomAction> {
    return this.run(async () => {
      const state = await this.load();
      if (publisher !== state.publisher || epoch !== state.epoch) throw new RoomActionError("stale_publisher");
      const command = state.commands.find(c => c.command_id === id);
      if (!command) throw new RoomActionError("unknown_command", 404);
      if (command.status !== "accepted") return command;
      if (now >= command.expires_at) command.status = "expired";
      else {
        const source = state.sources.find(s => s.id === command.target);
        const applied = command.kind === "participant.stage" ? state.on_stage.includes(command.target) === command.on
          : source && source.participant_id === command.participant_id
          && (command.kind !== "source.visibility" || source.scene_id === command.scene_id)
          && (command.kind === "source.visibility" ? source.visible : source.muted) === command.on;
        command.status = status === "applied" && applied ? "applied" : "failed";
        if (command.status === "failed") command.error = (error ?? "Host did not confirm the requested state").slice(0, 160);
      }
      await this.storage.put(KEY, state); return command;
    });
  }
  expire(now: number): Promise<RoomAction[]> {
    return this.run(async () => {
      const state = await this.load(); const expired = state.commands.filter(c => c.status === "accepted" && now >= c.expires_at);
      for (const c of expired) c.status = "expired";
      if (expired.length) await this.storage.put(KEY, state); return expired;
    });
  }
}
