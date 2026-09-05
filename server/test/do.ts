// A DurableObjectState stand-in so the Durable Object classes run in tests:
// in-memory storage, a fake alarm, and fake hibernating WebSockets whose
// attachments and sent frames can be inspected. No workerd needed.
export class FakeSocket {
  sent: string[] = [];
  closed: number | null = null;
  private attachment: unknown = null;
  constructor(public readonly tag = "") {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closed = code ?? 1000;
  }
  serializeAttachment(v: unknown) {
    this.attachment = JSON.parse(JSON.stringify(v));
  }
  deserializeAttachment() {
    return this.attachment;
  }
  /** Parsed frames, newest last. */
  frames<T = Record<string, unknown>>(): T[] {
    return this.sent.map((s) => JSON.parse(s) as T);
  }
}

export class FakeState {
  private sockets: FakeSocket[] = [];
  alarmAt: number | null = null;
  readonly storage = {
    map: new Map<string, unknown>(),
    async get<T>(key: string): Promise<T | undefined> {
      return this.map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      this.map.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(key: string): Promise<boolean> {
      return this.map.delete(key);
    },
    async list<T>(opts?: { prefix?: string }): Promise<Map<string, T>> {
      const out = new Map<string, T>();
      for (const [k, v] of this.map) if (!opts?.prefix || k.startsWith(opts.prefix)) out.set(k, v as T);
      return out;
    },
    setAlarm: async (at: number | Date): Promise<void> => {
      this.alarmAt = typeof at === "number" ? at : at.getTime();
    },
    getAlarm: async (): Promise<number | null> => this.alarmAt,
    deleteAlarm: async (): Promise<void> => {
      this.alarmAt = null;
    },
  };
  acceptWebSocket(ws: WebSocket) {
    this.sockets.push(ws as unknown as FakeSocket);
  }
  getWebSockets(): WebSocket[] {
    return this.sockets as unknown as WebSocket[];
  }
  /** Simulate an accepted socket with an attachment already set. */
  attach(tag: string, attachment: unknown): FakeSocket {
    const s = new FakeSocket(tag);
    s.serializeAttachment(attachment);
    this.sockets.push(s);
    return s;
  }
  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  waitUntil() {}
}

export const asState = (s: FakeState) => s as unknown as DurableObjectState;
export const asSocket = (s: FakeSocket) => s as unknown as WebSocket;

/** A WebSocket upgrade request carrying the trusted headers the Worker sets. */
export function upgrade(headers: Record<string, string>): Request {
  return new Request("https://do/ws", { headers: { Upgrade: "websocket", ...headers } });
}

// `WebSocketPair` exists only in workerd; give the hub something to build.
if (!(globalThis as { WebSocketPair?: unknown }).WebSocketPair) {
  (globalThis as { WebSocketPair?: unknown }).WebSocketPair = class {
    0: FakeSocket;
    1: FakeSocket;
    constructor() {
      this[0] = new FakeSocket("client");
      this[1] = new FakeSocket("server");
    }
  };
}

/** A DurableObjectNamespace stand-in: one instance per name, built with a
 *  FakeState, reached through a stub whose fetch() calls the instance. */
export function fakeNamespace<T extends { fetch(r: Request): Promise<Response> }>(
  make: (state: FakeState, name: string) => T,
): DurableObjectNamespace & { instances: Map<string, { state: FakeState; object: T }> } {
  const instances = new Map<string, { state: FakeState; object: T }>();
  const ns = {
    instances,
    idFromName: (name: string) => ({ name, toString: () => name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const name = String(id);
      let inst = instances.get(name);
      if (!inst) {
        const state = new FakeState();
        inst = { state, object: make(state, name) };
        instances.set(name, inst);
      }
      const object = inst.object;
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => object.fetch(new Request(input as string, init)),
      } as unknown as DurableObjectStub;
    },
  };
  return ns as unknown as DurableObjectNamespace & { instances: typeof instances };
}
