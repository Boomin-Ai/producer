import {useEffect,useRef,useState} from 'react';
import {dataIntegrations,type Connection,type SavedConnection} from '../lib/dataIntegrations';
import './dataIntegrations.css';
const weather=():Connection=>({id:'weather-'+crypto.randomUUID().slice(0,8),name:'Weather',kind:'weather',provider:'open-meteo',location:'Atlanta',latitude:33.749,longitude:-84.388,units:'celsius',pollSeconds:300});
const agent=():Connection=>({id:'agent-'+crypto.randomUUID().slice(0,8),name:'Research agent',kind:'agent',provider:'anthropic',model:'',webSearch:true,maxOutputTokens:2048});
export function DataIntegrations({endpointId}:{endpointId:string|null}){
 const [connections,setConnections]=useState<SavedConnection[]>([]),[draft,setDraft]=useState<Connection|null>(null),[revision,setRevision]=useState<number>(),[secret,setSecret]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 const current=useRef(endpointId);current.current=endpointId;
 const refresh=async(id=endpointId)=>{if(!id)return;const response=await dataIntegrations.list(id);if(current.current===id){setConnections(response.connections);setLoaded(true);}};
 useEffect(()=>{let cancelled=false;setConnections([]);setDraft(null);setSecret('');setError('');setLoaded(false);setBusy(false);setRevision(undefined);if(endpointId)void refresh(endpointId).catch(e=>{if(!cancelled)setError(String(e));});return()=>{cancelled=true;};},[endpointId]);
 const run=async(work:(id:string)=>Promise<void>)=>{if(!endpointId||busy)return;const id=endpointId;setBusy(true);setError('');try{await work(id);}catch(e){if(current.current===id)setError(String(e));}finally{if(current.current===id)setBusy(false);}};
 const edit=(saved:SavedConnection)=>{setDraft(structuredClone(saved.connection));setRevision(saved.revision);setSecret('');setError('');};
 const change=(patch:Partial<Connection>)=>setDraft(previous=>previous?{...previous,...patch} as Connection:previous);
 const save=()=>void run(async id=>{if(!draft)return;await dataIntegrations.save(id,draft,secret||undefined,revision);if(current.current!==id)return;setSecret('');setDraft(null);await refresh(id);});
 return <section className="data-integrations" aria-label="Data integrations">
  <div className="cr-label set-gap">DATA & AGENTS</div>
  <div className="set-list">
   <div className="cr-sheet-row"><span className="cr-sheet-row-name">Data integrations</span><span className="cr-sheet-row-sub">Saved connections for sets and shows</span></div>
   {!endpointId&&<p className="cr-hint">Select a workspace to configure weather and agent connections.</p>}
   {endpointId&&loaded&&!connections.length&&<p className="cr-hint">Connect weather data or an agent, then select it in a set’s module settings.</p>}
   {connections.map(saved=><div className="cr-sheet-row data-connection" key={saved.connection.id}>
    <span className="cr-sheet-row-name">{saved.connection.name}</span><span className="cr-sheet-row-sub">{saved.connection.kind==='weather'?`${saved.connection.location} · Open-Meteo`:`${saved.connection.model} · ${saved.connection.provider==='anthropic'?'Claude':'OpenAI'}${saved.connection.webSearch?' · Web research':''}`}</span>
    <span className="data-connection-status" role="status">{saved.status==='ready'?'Connected':saved.status==='error'?'Needs attention':'Not tested'}</span>
    <div className="data-connection-actions"><button disabled={busy} onClick={()=>edit(saved)}>Edit</button><button disabled={busy} onClick={()=>void run(async id=>{await dataIntegrations.test(id,saved);await refresh(id);})}>Test connection</button><button disabled={busy} onClick={()=>void run(async id=>{await dataIntegrations.remove(id,saved);await refresh(id);})}>Remove</button></div>
    {saved.error&&<span className="cr-hint" role="alert">{saved.error}</span>}
   </div>)}
   {endpointId&&loaded&&!draft&&<div className="data-connection-actions"><button disabled={busy} onClick={()=>{setDraft(weather());setRevision(undefined);setSecret('');}}>Add weather connection</button><button disabled={busy} onClick={()=>{setDraft(agent());setRevision(undefined);setSecret('');}}>Add LLM connection</button></div>}
   {draft&&<form className="data-connection-editor" aria-label="Configure data connection" onSubmit={e=>{e.preventDefault();save();}}>
    <label>Name<input required maxLength={80} value={draft.name} onChange={e=>change({name:e.target.value})}/></label>
    {draft.kind==='agent'?<label>LLM provider<select aria-label="LLM provider" disabled={revision!==undefined} value={draft.provider} onChange={e=>change({provider:e.target.value as 'openai'|'anthropic'})}><option value="anthropic">Anthropic / Claude</option><option value="openai">OpenAI</option></select></label>:<label>Provider<input disabled value="Open-Meteo"/></label>}
    {draft.kind==='weather'?<>
     <label>Location label<input required maxLength={120} value={draft.location} onChange={e=>change({location:e.target.value})}/></label>
     <label>Latitude<input required type="number" step="any" min={-90} max={90} value={draft.latitude} onChange={e=>change({latitude:Number(e.target.value)})}/></label>
     <label>Longitude<input required type="number" step="any" min={-180} max={180} value={draft.longitude} onChange={e=>change({longitude:Number(e.target.value)})}/></label>
     <label>Temperature unit<select value={draft.units} onChange={e=>change({units:e.target.value as 'celsius'|'fahrenheit'})}><option value="celsius">Celsius</option><option value="fahrenheit">Fahrenheit</option></select></label>
     <label>Refresh every (seconds)<input required type="number" min={60} max={3600} value={draft.pollSeconds} onChange={e=>change({pollSeconds:Number(e.target.value)})}/></label>
     <p className="cr-hint">Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>. This connection uses its public API. Configure a provider suitable for your usage.</p>
    </>:<>
     <label>Model ID<input required maxLength={120} autoComplete="off" placeholder="Enter a model available to your API project" value={draft.model} onChange={e=>change({model:e.target.value})}/></label>
     {draft.provider==='anthropic'&&<label>Anthropic workspace ID (optional)<input maxLength={120} value={draft.workspaceId??''} placeholder="Only needed for a key not scoped to one workspace" onChange={e=>{if(e.target.value)change({workspaceId:e.target.value});else setDraft(previous=>{if(!previous||previous.kind!=='agent')return previous;const {workspaceId:_,...rest}=previous;return rest;});}}/></label>}
     <label>API key<input type="password" autoComplete="new-password" required={revision===undefined} maxLength={512} value={secret} placeholder={revision===undefined?'Enter API key':'Leave blank to retain saved key'} onChange={e=>setSecret(e.target.value)}/></label>
     <label className="data-connection-checkbox"><input type="checkbox" checked={draft.webSearch} onChange={e=>change({webSearch:e.target.checked})}/>Allow web research for fact checks</label>
     <label>Maximum output tokens<input required type="number" min={256} max={4096} value={draft.maxOutputTokens} onChange={e=>change({maxOutputTokens:Number(e.target.value)})}/></label>
     <p className="cr-hint">The workspace server stores the key encrypted. Imported sets reference this connection; they do not contain its key. Requests use your provider account.</p>
    </>}
    <div className="data-connection-actions"><button type="submit" disabled={busy}>{busy?'Saving…':'Save connection'}</button><button type="button" disabled={busy} onClick={()=>{setDraft(null);setSecret('');}}>Cancel</button></div>
   </form>}
   {error&&<p className="cr-hint" role="alert">{error}</p>}
  </div>
 </section>;
}
