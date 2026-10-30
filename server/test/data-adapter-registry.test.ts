import { describe, it, expect } from 'vitest';
import { createAdapterRegistry, parseAdapterManifest, AdapterContractError, type DataAdapterManifest } from '../../shared/set-runtime/dataAdapters';
import { dataAdapterRegistry } from '../src/dataIntegrations/registry';
const poll: DataAdapterManifest = {
  schema: 'producer.data-adapter/1', id: 'test.metrics', version: 1,
  capability: 'data.metrics@1', transport: 'poll', operations: [
    { id: 'growth', input: 'metrics.account@1', output: 'metrics.growth@1', delivery: 'snapshot', refresh: true },
  ],
};
const required = { input: 'metrics.account@1', output: 'metrics.growth@1', delivery: 'snapshot' as const };
function code(action: () => unknown, expected: string) {
  try { action(); throw Error('Expected failure'); }
  catch (error) { expect(error).toBeInstanceOf(AdapterContractError); expect((error as AdapterContractError).code).toBe(expected); }
}
describe('versioned adapter discovery and binding compatibility', () => {
  it('permits polling and webhook adapters to supply the same snapshot contract', () => {
    const webhook: DataAdapterManifest = { ...poll, id: 'test.webhook', transport: 'webhook', operations: [{ ...poll.operations[0], refresh: false }] };
    const registry = createAdapterRegistry([poll, webhook]);
    for (const id of [poll.id, webhook.id]) expect(registry.resolve(id, 1, 'growth', required).output).toBe(required.output);
    expect(registry.capabilities()).toEqual(['data.metrics@1']);
  });
  it('rejects missing adapters, unknown versions/operations and incompatible contracts', () => {
    const registry = createAdapterRegistry([poll]);
    code(() => registry.resolve('missing', 1, 'growth', required), 'adapter_unavailable');
    code(() => registry.resolve(poll.id, 2, 'growth', required), 'adapter_unavailable');
    code(() => registry.resolve(poll.id, 1, 'missing', required), 'operation_unavailable');
    for (const mismatch of [{ output: 'metrics.growth@2' }, { input: 'metrics.other@1' }, { delivery: 'event' as const }])
      code(() => registry.resolve(poll.id, 1, 'growth', { ...required, ...mismatch }), 'binding_incompatible');
  });
  it('does not alias caller-owned manifests or discovery results', () => {
    const source = structuredClone(poll), registry = createAdapterRegistry([source]);
    source.operations[0].output = 'tampered.output@1';
    registry.catalog()[0].operations[0].output = 'tampered.output@2';
    registry.resolve(poll.id, 1, 'growth', required).output = 'tampered.output@3';
    expect(registry.resolve(poll.id, 1, 'growth', required).output).toBe(required.output);
  });
  it('bounds registries and rejects duplicate identities and operations', () => {
    code(() => createAdapterRegistry(Array(129).fill(poll)), 'registry_limit');
    code(() => createAdapterRegistry([poll, poll]), 'duplicate_adapter');
    code(() => parseAdapterManifest({ ...poll, operations: [...poll.operations, ...poll.operations] }), 'duplicate_operation');
    code(() => parseAdapterManifest({ ...poll, operations: Array(17).fill(poll.operations[0]) }), 'invalid_manifest');
  });
  it('rejects malformed metadata, secrets and unsupported refresh promises', () => {
    for (const change of [{ version: 0 }, { version: Infinity }, { id: 'https://example.com' }, { capability: 'data.unversioned' }, { apiKey: 'never-public' }, { transport: 'unknown' }, { operations: [] }])
      code(() => parseAdapterManifest({ ...poll, ...change }), 'invalid_manifest');
    code(() => parseAdapterManifest({ ...poll, schema: 'producer.data-adapter/2' }), 'unsupported_schema');
    for (const transport of ['webhook', 'stream']) code(() => parseAdapterManifest({ ...poll, transport }), 'invalid_manifest');
  });
  it('advertises only the existing providers and preserves existing capability identifiers', () => {
    expect(dataAdapterRegistry.capabilities()).toEqual(['data.weather@1', 'data.agent@1']);
    expect(dataAdapterRegistry.catalog().map(m => m.id)).toEqual(['open-meteo', 'openai', 'anthropic']);
    expect(dataAdapterRegistry.catalog().some(m => m.transport === 'webhook')).toBe(false);
    expect(dataAdapterRegistry.resolve('open-meteo', 1, 'forecast', { input: 'weather.location-query@1', output: 'weather.observation@1', delivery: 'snapshot' }).refresh).toBe(true);
  });
});
