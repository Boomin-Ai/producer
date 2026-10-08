// Versioned room commands, independent of media transport and provider.
// Storage is bounded and writes are serialized, including across awaits.
export type SceneCommandStatus = "accepted" | "applied" | "failed" | "expired" | "superseded";
export interface SceneCommand {
  command_id: string; scene_id: string; sequence: number; epoch: number;
  from: string; accepted_at: number; expires_at: number; status: SceneCommandStatus;
  applied_at?: number; error?: string;
}
export interface RoomCommandState {
  sequence: number; epoch: number; publisher: string | null;
  scenes: { id: string; name: string }[]; active_scene_id: string | null;
  commands: SceneCommand[];
}
export interface CommandStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export class RoomCommandError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
const KEY = "room-control:v1";
export const SCENE_COMMAND_TTL_MS = 4000;
export class RoomCommands {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: CommandStorage) {}
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }
  private async load(): Promise<RoomCommandState> {
    return await this.storage.get<RoomCommandState>(KEY) ?? { sequence: 0, epoch: 0, publisher: null, scenes: [], active_scene_id: null, commands: [] };
  }
  snapshot(): Promise<RoomCommandState> { return this.serialized(() => this.load()); }
  publish(publisher: string, scenes: { id: string; name: string }[], active: string | null, mayTakeover: boolean): Promise<RoomCommandState> {
    return this.serialized(async () => {
      const state = await this.load();
      if (state.publisher !== publisher) {
        if (state.publisher && !mayTakeover) throw new RoomCommandError("publisher_busy");
        state.epoch++;
        state.publisher = publisher;
        for (const c of state.commands) if (c.status === "accepted") c.status = "superseded";
      }
      state.scenes = scenes.slice(0, 64).filter((s) => s && typeof s.id === "string" && s.id.length > 0 && s.id.length <= 80)
        .map((s) => ({ id: s.id, name: String(s.name ?? s.id).slice(0, 80) }));
      if (!state.commands.some((c) => c.status === "accepted")) {
        state.active_scene_id = state.scenes.some((s) => s.id === active) ? active : null;
      }
      await this.storage.put(KEY, state);
      return state;
    });
  }
  submit(input: { command_id: string; scene_id: string; from: string }, now: number): Promise<SceneCommand> {
    return this.serialized(async () => {
      const state = await this.load();
      if (typeof input.command_id !== "string" || !input.command_id || input.command_id.length > 80 || typeof input.scene_id !== "string" || typeof input.from !== "string") throw new RoomCommandError("invalid_command", 400);
      const previous = state.commands.find((c) => c.command_id === input.command_id);
      if (previous) {
        if (previous.from !== input.from || previous.scene_id !== input.scene_id) throw new RoomCommandError("command_id_conflict");
        return previous;
      }
      if (!state.publisher) throw new RoomCommandError("host_unavailable", 503);
      if (!state.scenes.some((s) => s.id === input.scene_id)) throw new RoomCommandError("unknown_scene", 422);
      if (!input.command_id || input.command_id.length > 80) throw new RoomCommandError("invalid_command", 400);
      for (const c of state.commands) if (c.status === "accepted") c.status = now >= c.expires_at ? "expired" : "superseded";
      const command: SceneCommand = { ...input, sequence: ++state.sequence, epoch: state.epoch,
        accepted_at: now, expires_at: now + SCENE_COMMAND_TTL_MS, status: "accepted" };
      state.commands = [...state.commands.slice(-63), command];
      await this.storage.put(KEY, state);
      return command;
    });
  }
  acknowledge(publisher: string, id: string, status: "applied" | "failed", now: number, error?: string): Promise<SceneCommand> {
    return this.serialized(async () => {
      const state = await this.load();
      if (publisher !== state.publisher) throw new RoomCommandError("stale_publisher");
      const c = state.commands.find((command) => command.command_id === id);
      if (!c) throw new RoomCommandError("unknown_command", 404);
      if (c.status !== "accepted") return c;
      if (c.epoch !== state.epoch || c.sequence !== state.sequence) c.status = "superseded";
      else if (now >= c.expires_at) c.status = "expired";
      else {
        c.status = status;
        if (status === "applied") { c.applied_at = now; state.active_scene_id = c.scene_id; }
        else c.error = (error ?? "Scene application failed").slice(0, 160);
      }
      await this.storage.put(KEY, state);
      return c;
    });
  }
  expire(now: number): Promise<SceneCommand[]> {
    return this.serialized(async () => {
      const state = await this.load();
      const expired = state.commands.filter((c) => c.status === "accepted" && now >= c.expires_at);
      for (const c of expired) c.status = "expired";
      if (expired.length) await this.storage.put(KEY, state);
      return expired;
    });
  }
}
