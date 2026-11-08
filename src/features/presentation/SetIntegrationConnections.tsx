import {SocialPostPicker} from './SocialPostPicker';
import {useState} from 'react';
import {DataIntegrations} from '../../components/DataIntegrations';
import {integrationSetup} from './integrationRequirements';
import type {PresentationPackage} from './schema';
import type {ModuleBindings} from './moduleConnections';
import type {SavedConnection} from '../../lib/dataIntegrations';
import type {DataAdapterManifest} from '../../../shared/set-runtime/dataAdapters';
export function SetIntegrationConnections({doc,endpoint,connections,adapters,bindings,onBind,error,onRetry,disabled=false}:{
 doc:PresentationPackage;endpoint?:string;connections:SavedConnection[];adapters:DataAdapterManifest[];bindings:ModuleBindings;
 onBind:(role:string,binding:ModuleBindings[string])=>void;error:string;onRetry?:()=>void;disabled?:boolean;
}){
 const [adding,setAdding]=useState<'weather'|'agent'|null>(null);
 const setup=integrationSetup(doc,connections,bindings,adapters);if(!setup.length)return null;
 return <details className="set-section" open><summary>Data connections</summary>
  <p className="set-section-note">This Set can be imported without its data connections. Connect your own provider to enable live data; accounts and keys stay outside the Set.</p>
  {setup.map(({requirement:r,candidates,status,selected})=><div key={r.role} className="set-integration-requirement">
   <label>{r.label}{r.optional?' · optional':''}<select aria-label={`${r.label} connection`} value={selected?.connection.id??''} disabled={disabled||!endpoint} onChange={e=>{const c=candidates.find(c=>c.connection.id===e.target.value);onBind(r.role,{id:c?.connection.id??'',revision:c?.revision??1});}}>
    <option value="">Choose your connection</option>{candidates.map(c=><option key={c.connection.id} value={c.connection.id}>{c.connection.name} · {c.connection.provider}</option>)}
   </select></label>
   <p role="status">{!endpoint?'Connect a workspace to configure live data.':status==='connected'?'Connected':status==='configured'?'Configured · connection has not been tested yet.':status==='connection-error'?`Connection test failed: ${selected?.error||'Check your provider settings.'}`:status==='adapter-unavailable'?`A compatible adapter for ${r.capability} is unavailable in this workspace. You can keep using the Set’s design and authored defaults.`:status==='connection-changed'?'The previous connection changed or is unavailable. Choose a current connection.':'Choose a saved connection or add your own.'}</p>
   {endpoint&&selected?.connection.kind==='social'&&<SocialPostPicker key={endpoint+selected.connection.id+selected.revision} endpoint={endpoint} connection={selected} binding={bindings[r.role]} onChange={binding=>onBind(r.role,binding)} disabled={disabled}/>}
   {endpoint&&r.capability==='data.social@1'&&!candidates.length&&<p className="set-section-note">Connect Threads in Settings → Integrations for this workspace, then refresh connections.</p>}
   {endpoint&&['data.weather@1','data.agent@1'].includes(r.capability)&&<button type="button" disabled={disabled} onClick={()=>setAdding(r.capability==='data.weather@1'?'weather':'agent')}>Add {r.capability==='data.weather@1'?'weather':'agent'} connection</button>}
  </div>)}
  {adding&&<div aria-label="Set connection setup"><button type="button" onClick={()=>setAdding(null)}>Close connection setup</button><DataIntegrations key={endpoint+adding} endpointId={endpoint??null} initialKind={adding}/></div>}
  {error&&<div role="alert"><p>{error}</p><button type="button" onClick={onRetry}>Retry connections</button></div>}
 </details>;
}
