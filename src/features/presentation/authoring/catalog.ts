/** Authoring targets are explicit snapshots, never inferred from a model's claims. */
export const AUTHORING_CATALOG = {
  schema: 'producer.authoring-capabilities/1', revision: 1,
  planSchema: 'producer.design-plan/1', editSchema: 'producer.set-edit/1',
  packageSchema: 'producer.presentation/2',
  features: ['core@1', 'mask@1', 'backdrop@1', 'chart@1', 'scene3d@1',
    'shader.voiceBars@1', 'shader.voiceRing@1', 'shader.voiceSea@1', 'shader.launchV1@1'],
  planNodes: ['panel', 'text', 'camera', 'image', 'effect'],
  edits: ['move', 'text', 'replace-camera', 'duplicate-layout'],
  limits: { layouts: 8, elementsPerLayout: 64, edits: 32 },
} as const;
export type AuthoringTarget = { catalogRevision: number; features: string[] };
export function requireFeatures(target: AuthoringTarget, features: string[]) {
  if (target.catalogRevision !== AUTHORING_CATALOG.revision) throw Error('Authoring catalog changed. Refresh capabilities before generating.');
  const missing = features.filter(f => !target.features.includes(f));
  if (missing.length) throw Error(`Target cannot render: ${missing.join(', ')}. Update Producer or change the requested design.`);
}
