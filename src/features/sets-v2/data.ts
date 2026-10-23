/** Trusted-adapter boundary, independent of transport/provider and visual design.
 * An adapter is responsible for authentication; these objects are not HTTP requests. */
export type DataValue =
  null | boolean | number | string | DataValue[] | { [key: string]: DataValue };
export type ValueSchema = (
  | { type: "string"; maxLength: number }
  | { type: "number"; min: number; max: number }
  | { type: "boolean" }
  | { type: "array"; maxItems: number; items: ValueSchema }
  | { type: "object"; fields: Record<string, ValueSchema> }
) & { visibility?: "public" | "operator"; nullable?: boolean };
export interface ChannelSpec {
  id: string;
  producer: string;
  schema: ValueSchema;
  maxAgeMs: number;
}
export interface AdapterAuthority {
  roomId: string;
  producer: string;
}
export interface DataEnvelope {
  roomId: string;
  channel: string;
  generation: number;
  revision: number;
  observedAt: number;
  value: unknown;
}
export interface ChannelView {
  value: DataValue;
  generation: number;
  revision: number;
  observedAt: number;
  receivedAt: number;
  stale: boolean;
}
export type PublicData = Readonly<Record<string, ChannelView>>;
export const safeKey = (key: string) =>
  /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) &&
  !["constructor", "prototype", "__proto__"].includes(key);
export function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw Error("Expected a plain data object");
  return value as Record<string, unknown>;
}
export function finite(n: unknown, min: number, max: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max)
    throw Error(`Expected number in [${min}, ${max}]`);
  return n;
}
export function validateSchema(s: ValueSchema, depth = 0): void {
  if (depth > 8) throw Error("Data schema is too deep");
  object(s);
  const fields = {
    string: ["maxLength"],
    number: ["min", "max"],
    boolean: [],
    array: ["maxItems", "items"],
    object: ["fields"],
  }[s.type];
  if (
    !fields ||
    Object.keys(s).some(
      (k) => !["type", "visibility", "nullable", ...fields].includes(k),
    )
  )
    throw Error("Invalid data schema");
  if (
    (s.visibility !== undefined &&
      !["public", "operator"].includes(s.visibility)) ||
    (s.nullable !== undefined && typeof s.nullable !== "boolean")
  )
    throw Error("Invalid field visibility");
  if (s.type === "string") {
    finite(s.maxLength, 0, 4096);
    if (!Number.isInteger(s.maxLength)) throw Error("Invalid text limit");
  }
  if (s.type === "number") {
    finite(s.min, -1e12, 1e12);
    finite(s.max, s.min, 1e12);
  }
  if (s.type === "array") {
    finite(s.maxItems, 0, 512);
    if (!Number.isInteger(s.maxItems)) throw Error("Invalid array limit");
    validateSchema(s.items, depth + 1);
  }
  if (s.type === "object") {
    object(s.fields);
    if (Object.keys(s.fields).length > 64) throw Error("Too many data fields");
    for (const [k, v] of Object.entries(s.fields)) {
      if (!safeKey(k)) throw Error("Unsafe field key");
      validateSchema(v, depth + 1);
    }
  }
}
export function validateValue(
  s: ValueSchema,
  v: unknown,
  depth = 0,
  budget = { remaining: 4096 },
): DataValue {
  if (depth > 8 || --budget.remaining < 0)
    throw Error("Data exceeds structural budget");
  if (v === null && s.nullable) return null;
  switch (s.type) {
    case "string":
      if (typeof v !== "string" || v.length > s.maxLength)
        throw Error("Invalid text field");
      return v;
    case "number":
      return finite(v, s.min, s.max);
    case "boolean":
      if (typeof v !== "boolean") throw Error("Invalid boolean field");
      return v;
    case "array":
      if (!Array.isArray(v) || v.length > s.maxItems)
        throw Error("Invalid array");
      return v.map((x) => validateValue(s.items, x, depth + 1, budget));
    case "object": {
      const input = object(v);
      if (
        Object.keys(input).length !== Object.keys(s.fields).length ||
        Object.keys(input).some(
          (k) => !Object.prototype.hasOwnProperty.call(s.fields, k),
        )
      )
        throw Error("Data fields do not match schema");
      const out: Record<string, DataValue> = {};
      for (const [k, field] of Object.entries(s.fields))
        out[k] = validateValue(field, input[k], depth + 1, budget);
      return out;
    }
  }
}
function publicValue(s: ValueSchema, v: DataValue): DataValue | undefined {
  if (s.visibility === "operator") return undefined;
  if (v === null) return null;
  if (s.type === "object") {
    const out: Record<string, DataValue> = {};
    for (const [k, child] of Object.entries(s.fields)) {
      const value = publicValue(child, (v as Record<string, DataValue>)[k]);
      if (value !== undefined) out[k] = value;
    }
    return out;
  }
  if (s.type === "array")
    return (v as DataValue[])
      .map((x) => publicValue(s.items, x))
      .filter((x): x is DataValue => x !== undefined);
  return v;
}
/** Validated snapshots: future webhook/API polling adapters feed this seam.
 * Generation is controlled by the host runtime, never accepted as a reset instruction. */
export class DataHub {
  private channels = new Map<
    string,
    { spec: ChannelSpec; generation: number; last?: Omit<ChannelView, "stale"> }
  >();
  constructor(
    readonly roomId: string,
    private now: () => number = Date.now,
  ) {
    if (!roomId) throw Error("Missing room scope");
  }
  register(spec: ChannelSpec): void {
    if (
      !safeKey(spec.id) ||
      !safeKey(spec.producer) ||
      this.channels.has(spec.id) ||
      this.channels.size >= 64
    )
      throw Error("Invalid or duplicate channel");
    finite(spec.maxAgeMs, 1, 86400000);
    validateSchema(spec.schema);
    this.channels.set(spec.id, { spec: structuredClone(spec), generation: 1 });
  }
  generation(channel: string): number {
    const c = this.channels.get(channel);
    if (!c) throw Error("Unknown channel");
    return c.generation;
  }
  rotate(channel: string): number {
    const c = this.channels.get(channel);
    if (!c) throw Error("Unknown channel");
    c.generation++;
    delete c.last;
    return c.generation;
  }
  publish(
    authority: AdapterAuthority,
    input: DataEnvelope,
  ): "accepted" | "stale" {
    const e = object(input);
    if (
      Object.keys(e).length !== 6 ||
      Object.keys(e).some(
        (k) =>
          ![
            "roomId",
            "channel",
            "generation",
            "revision",
            "observedAt",
            "value",
          ].includes(k),
      )
    )
      throw Error("Invalid envelope");
    const c = this.channels.get(input.channel);
    if (
      !c ||
      authority.roomId !== this.roomId ||
      input.roomId !== this.roomId ||
      authority.producer !== c.spec.producer
    )
      throw Error("Unauthorized data channel");
    const now = this.now();
    finite(input.generation, 1, Number.MAX_SAFE_INTEGER);
    finite(input.revision, 1, Number.MAX_SAFE_INTEGER);
    finite(input.observedAt, 0, now + 5000);
    if (
      !Number.isSafeInteger(input.generation) ||
      !Number.isSafeInteger(input.revision)
    )
      throw Error("Invalid sequence");
    if (
      input.generation !== c.generation ||
      (c.last && input.revision <= c.last.revision)
    )
      return "stale";
    const value = validateValue(c.spec.schema, input.value);
    if (JSON.stringify(value).length > 65536)
      throw Error("Data payload too large");
    c.last = {
      value,
      generation: c.generation,
      revision: input.revision,
      observedAt: input.observedAt,
      receivedAt: now,
    };
    return "accepted";
  }
  snapshot(): PublicData {
    const out: Record<string, ChannelView> = {};
    const now = this.now();
    for (const [id, c] of this.channels) {
      if (!c.last) continue;
      const value = publicValue(c.spec.schema, c.last.value);
      if (value === undefined) continue;
      out[id] = {
        ...c.last,
        value: structuredClone(value),
        stale: now - c.last.observedAt > c.spec.maxAgeMs,
      };
    }
    return out;
  }
}
