/** Public discovery metadata only. Registration never authorizes execution or
 * installs provider code. Credentials and connection instances are not manifests. */
export type AdapterTransport = 'poll' | 'request' | 'webhook' | 'stream';
export type DataDelivery = 'snapshot' | 'event';
export interface AdapterOperation {
  id: string;
  input: string;
  output: string;
  delivery: DataDelivery;
  refresh: boolean;
}
export interface DataAdapterManifest {
  schema: 'producer.data-adapter/1';
  id: string;
  version: number;
  capability: string;
  transport: AdapterTransport;
  operations: AdapterOperation[];
}
export class AdapterContractError extends Error {
  constructor(public code: string, public path: string, message: string) {
    super(`${path}: ${message}`);
  }
}
const fail = (code: string, path: string, message: string): never => { throw new AdapterContractError(code, path, message); };
function object(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_manifest', path, 'Object required');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => !Object.prototype.hasOwnProperty.call(record, key)))
    return fail('invalid_manifest', path, 'Unknown or missing fields');
  return record;
}
function identifier(value: unknown, path: string, versioned = false): string {
  if (typeof value !== 'string' || value.length > 96 || !(versioned ? /^[a-z][a-z0-9.-]*@[1-9][0-9]*$/ : /^[a-z][a-z0-9.-]*$/).test(value))
    return fail('invalid_manifest', path, 'Invalid identifier');
  return value;
}
export function parseAdapterManifest(value: unknown): DataAdapterManifest {
  const o = object(value, ['schema', 'id', 'version', 'capability', 'transport', 'operations'], '$');
  if (o.schema !== 'producer.data-adapter/1') fail('unsupported_schema', '$.schema', 'Unsupported adapter schema');
  if (!Number.isSafeInteger(o.version) || (o.version as number) < 1) fail('invalid_manifest', '$.version', 'Positive integer required');
  if (!['poll', 'request', 'webhook', 'stream'].includes(o.transport as string)) fail('invalid_manifest', '$.transport', 'Unsupported transport');
  if (!Array.isArray(o.operations) || !o.operations.length || o.operations.length > 16) fail('invalid_manifest', '$.operations', 'Expected 1–16 operations');
  const ids = new Set<string>();
  const operations = (o.operations as unknown[]).map((raw, i): AdapterOperation => {
    const path = `$.operations[${i}]`, op = object(raw, ['id', 'input', 'output', 'delivery', 'refresh'], path);
    const id = identifier(op.id, `${path}.id`);
    if (ids.has(id)) fail('duplicate_operation', `${path}.id`, 'Operation already declared');
    ids.add(id);
    if (op.delivery !== 'snapshot' && op.delivery !== 'event') fail('invalid_manifest', `${path}.delivery`, 'Snapshot or event required');
    if (typeof op.refresh !== 'boolean' || (op.refresh && (o.transport === 'webhook' || o.transport === 'stream')))
      fail('invalid_manifest', `${path}.refresh`, 'Push transports cannot promise a refresh request');
    return { id, input: identifier(op.input, `${path}.input`, true), output: identifier(op.output, `${path}.output`, true), delivery: op.delivery as DataDelivery, refresh: op.refresh as boolean };
  });
  return { schema: 'producer.data-adapter/1', id: identifier(o.id, '$.id'), version: o.version as number,
    capability: identifier(o.capability, '$.capability', true), transport: o.transport as AdapterTransport, operations };
}

/** Owned registry snapshot: caller mutations cannot change compatibility checks.
 * Exact contract versions only; no implicit downgrade or cross-version coercion. */
export function createAdapterRegistry(manifests: readonly unknown[]) {
  if (manifests.length > 128) fail('registry_limit', '$', 'Adapter registry exceeds 128 entries');
  const entries = new Map<string, DataAdapterManifest>();
  for (const raw of manifests) {
    const manifest = parseAdapterManifest(raw), key = `${manifest.id}@${manifest.version}`;
    if (entries.has(key)) fail('duplicate_adapter', '$', 'Adapter version already registered');
    entries.set(key, manifest);
  }
  return {
    catalog: (): DataAdapterManifest[] => structuredClone([...entries.values()]),
    capabilities: (): string[] => [...new Set([...entries.values()].map(m => m.capability))],
    resolve(id: string, version: number, operation: string, required: { input: string; output: string; delivery: DataDelivery }): AdapterOperation {
      const adapter = entries.get(`${id}@${version}`);
      if (!adapter) return fail('adapter_unavailable', '$.adapter', 'Adapter version is not registered');
      const op = adapter.operations.find(item => item.id === operation);
      if (!op) return fail('operation_unavailable', '$.operation', 'Operation is not registered');
      if (op.input !== required.input || op.output !== required.output || op.delivery !== required.delivery)
        return fail('binding_incompatible', '$.binding', 'Input, output or delivery contract does not match');
      return { ...op };
    },
  };
}
