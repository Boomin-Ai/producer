/** Authoring targets are explicit snapshots, never inferred from a model's claims. */
export const AUTHORING_CATALOG = {
  schema: 'producer.authoring-capabilities/1', revision: 2,
  planSchema: 'producer.design-plan/2', editSchema: 'producer.set-edit/2',
  acceptedPlanSchemas: ['producer.design-plan/1','producer.design-plan/2'],
  acceptedEditSchemas: ['producer.set-edit/1','producer.set-edit/2'],
  profiles: {compact:'producer.design-plan/1',canonical:'producer.design-plan/2'},
  packageSchema: 'producer.presentation/2',
  features: ['core@1', 'mask@1', 'backdrop@1', 'chart@1', 'scene3d@1','audience.vote@1','audience.text@1','data.weather@1','data.agent@1','data.social@1','room.chat@1',
    ...['aurora','edgeGlow','lightSweep','plasma','silk','rings','grid','stars','petals','contours','prism','borderFlare','rain','snow','clouds','voiceBars','voiceRing','voiceSea','launchV1'].map(effect=>`shader.${effect}@1`)],
  planNodes: ['panel', 'text', 'camera', 'image', 'effect'],
  edits: ['move', 'text', 'replace-camera', 'duplicate-layout'],
  canonicalEdits: ['add','replace','remove'],
  canonicalNodes: ['box','text','slot','media','shader','scene3d','chart','component'],
  portableIntegrations: true,
  nativeAdmission: 'separate-native-preparation-required',
  runtimeCapabilities: ['audience.vote@1','audience.text@1','data.weather@1','data.agent@1','data.social@1','room.chat@1'],
  limits: { layouts: 32, elementsPerLayout: 64, edits: 64, designBytes: 1024*1024 },
} as const;
export type AuthoringTarget = { catalogRevision: number; features: string[] };
export function requireFeatures(target: AuthoringTarget, features: string[]) {
  if (target.catalogRevision !== AUTHORING_CATALOG.revision) throw Error('Authoring catalog changed. Refresh capabilities before generating.');
  const missing = features.filter(f => !target.features.includes(f));
  if (missing.length) throw Error(`Target cannot render: ${missing.join(', ')}. Update Producer or change the requested design.`);
}
