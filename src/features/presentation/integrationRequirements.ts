import type {PresentationPackage} from './schema';
import type {DataAdapterManifest} from '../../../shared/set-runtime/dataAdapters';
import type {ModuleBindings} from './moduleConnections';
import type {SavedConnection} from '../../lib/dataIntegrations';
export type IntegrationRequirement=NonNullable<PresentationPackage['integrations']>['requirements'][number];
/** Portable contracts only. Neither credentials nor saved workspace connection IDs
 * belong in the distributable package. Existing module-only Sets need no migration. */
export function integrationRequirements(doc:PresentationPackage):IntegrationRequirement[]{
 const roles=new Map((doc.integrations?.requirements??[]).map(r=>[r.role,structuredClone(r)]));
 for(const instance of doc.runtime.instances){
  const behavior=doc.runtime.definitions[instance.definition]?.behavior;
  if(!behavior||!('integrationRole'in behavior)||roles.has(behavior.integrationRole))continue;
  const weather=behavior.type==='weather',social=behavior.type==='social';
  roles.set(behavior.integrationRole,{role:behavior.integrationRole,label:weather?'Live weather':social?'Threads account':'Agent responses',capability:`data.${behavior.type}@1`,input:weather?'weather.location-query@1':social?'social.selection@1':'agent.question@1',output:weather?'weather.observation@1':social?'social.dashboard@1':'agent.answer@1',delivery:'snapshot',optional:false,transport:weather||social?'poll':'request',refresh:weather||social});
 }
 return [...roles.values()];
}
export function compatibleAdapters(requirement:IntegrationRequirement,adapters:readonly DataAdapterManifest[]){
 return adapters.filter(a=>a.capability===requirement.capability&&(!requirement.transport||a.transport===requirement.transport)&&(!requirement.adapter||a.id===requirement.adapter.id&&a.version===requirement.adapter.version)&&a.operations.some(op=>(!requirement.adapter||op.id===requirement.adapter.operation)&&op.input===requirement.input&&op.output===requirement.output&&op.delivery===requirement.delivery&&(requirement.refresh===undefined||op.refresh===requirement.refresh)));
}
export function compatibleConnections(requirement:IntegrationRequirement,connections:readonly SavedConnection[],adapters:readonly DataAdapterManifest[]){
 const providers=new Set(compatibleAdapters(requirement,adapters).map(a=>a.id));
 return connections.filter(c=>providers.has(c.connection.provider)&&(!['data.weather@1','data.agent@1','data.social@1'].includes(requirement.capability)||`data.${c.connection.kind}@1`===requirement.capability)&&(c.connection.kind!=='agent'||c.hasSecret));
}
export function integrationSetup(doc:PresentationPackage,connections:readonly SavedConnection[],bindings:ModuleBindings,adapters:readonly DataAdapterManifest[]){
 return integrationRequirements(doc).map(requirement=>{
  const candidates=compatibleConnections(requirement,connections,adapters),binding=bindings[requirement.role],selected=candidates.find(c=>c.connection.id===binding?.id&&c.revision===binding.revision);
  const status=selected?(selected.status==='ready'?'connected':selected.status==='error'?'connection-error':'configured'):!compatibleAdapters(requirement,adapters).length?'adapter-unavailable':binding?.id?'connection-changed':'needs-connection';
  return {requirement,candidates,status,selected};
 });
}
