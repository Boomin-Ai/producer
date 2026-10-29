import { createAdapterRegistry, type DataAdapterManifest } from '../../../shared/set-runtime/dataAdapters';

// Describes providers already implemented in providers.ts. This catalog does not
// enable generic HTTP, incoming webhooks or model-generated executable adapters.
const manifests: DataAdapterManifest[] = [
  { schema: 'producer.data-adapter/1', id: 'open-meteo', version: 1, capability: 'data.weather@1', transport: 'poll', operations: [
    { id: 'forecast', input: 'weather.location-query@1', output: 'weather.observation@1', delivery: 'snapshot', refresh: true },
  ] },
  ...['openai', 'anthropic'].map((id): DataAdapterManifest => ({
    schema: 'producer.data-adapter/1', id, version: 1, capability: 'data.agent@1', transport: 'request', operations: [
      { id: 'answer', input: 'agent.question@1', output: 'agent.answer@1', delivery: 'snapshot', refresh: false },
    ],
  })),
];
export const dataAdapterRegistry = createAdapterRegistry(manifests);
