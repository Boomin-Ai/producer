import type { AdapterOperation } from './dataAdapters';
export interface DataContract<T> { id: string; maxBytes: number; parse(value: unknown): T }
export class DataValidationError extends Error {
  constructor(public stage: 'input' | 'output', public contract: string) {
    super(`Data ${stage} does not satisfy ${contract}`);
  }
}
/** Values come from JSON/trusted adapter implementations, never executable package
 * objects. Bound traversal before serialization; do not echo provider payloads. */
export function parseDataValue<T>(contract: DataContract<T>, value: unknown, stage: 'input' | 'output'): T {
  try {
    let nodes = 0, characters = 0;
    const seen = new WeakSet<object>();
    function visit(v: unknown, depth: number) {
      if (++nodes > 8192 || depth > 24) throw Error('Structure budget');
      if (typeof v === 'string') { characters += v.length; if (characters > contract.maxBytes) throw Error('Text budget'); }
      else if (typeof v === 'number') { if (!Number.isFinite(v)) throw Error('Non-finite'); }
      else if (v && typeof v === 'object') {
        if (seen.has(v)) throw Error('Repeated object');
        seen.add(v);
        if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw Error('Not JSON');
        for (const [key, item] of Object.entries(v)) { characters += key.length; visit(item, depth + 1); }
      } else if (v !== null && typeof v !== 'boolean') throw Error('Not JSON');
    }
    visit(value, 0);
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > contract.maxBytes) throw Error('Byte budget');
    return contract.parse(value);
  } catch { throw new DataValidationError(stage, contract.id); }
}

/** One-shot execution after caller authorization; transport deadlines, connection
 * revisions and cache scope remain the server's responsibility. Never retries. */
export async function executeDataOperation<I, O>(
  operation: AdapterOperation, input: DataContract<I>, output: DataContract<O>,
  value: unknown, perform: (input: I) => Promise<unknown>,
): Promise<O> {
  if (operation.input !== input.id || operation.output !== output.id || operation.delivery !== 'snapshot')
    throw Error('Executable data contracts do not match the registered snapshot operation');
  const parsed = parseDataValue(input, value, 'input');
  return parseDataValue(output, await perform(parsed), 'output');
}
