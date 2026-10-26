import {useState} from 'react';
import {moduleInstance,moduleTemplate,type ModuleKind} from '../../../shared/set-runtime/templates';
import type {PresentationPackage} from './schema';
import {parsePackage} from './schema';
/** Configure portable interaction definitions here; credentials remain in Integrations. */
export function ModuleConfiguration({doc,segment,onChange,disabled=false}:{doc:PresentationPackage;segment?:string;onChange:(doc:PresentationPackage)=>void;disabled?:boolean}){
 const [kind,setKind]=useState<ModuleKind>('vote'),[scope,setScope]=useState('set'),[error,setError]=useState('');
 const update=(mutate:(draft:PresentationPackage)=>void)=>{try{const draft=structuredClone(doc);mutate(draft);onChange(parsePackage(draft));setError('');}catch(e){setError(e instanceof Error?e.message:'Invalid module configuration');}};
 return <details className="set-section"><summary>Interaction modules <span>{doc.runtime.instances.length}</span></summary>
  <p className="set-section-note">Set modules stay available across layouts. Segment modules belong to their segment. Connect API accounts in Settings → Integrations.</p>
  {doc.runtime.instances.map(i=>{const d=doc.runtime.definitions[i.definition],b=d.behavior;return <details key={i.id}><summary>{d.label} · {i.owner==='set'?'Set':i.segment}</summary>
   <form key={JSON.stringify(d)} onSubmit={e=>{e.preventDefault();const fields=new FormData(e.currentTarget);update(next=>{const definition=next.runtime.definitions[i.definition];definition.label=String(fields.get('label'));const target=next.runtime.instances.find(item=>item.id===i.id)!;target.audiencePolicy=fields.get('automatic')==='on'?'whileRunning':'manual';const behavior=definition.behavior;if(behavior?.type==='vote'){behavior.question=String(fields.get('prompt'));const labels=String(fields.get('options')).split('\n').map(s=>s.trim()).filter(Boolean);behavior.options=labels.map((label,index)=>({id:behavior.options[index]?.id??'option'+(index+1),label}));}else if(behavior?.type==='submissions'){behavior.prompt=String(fields.get('prompt'));behavior.sources=fields.get('chat')==='on'?['submissions','chat']:['submissions'];definition.capabilities=definition.capabilities.filter(c=>c!=='room.chat@1');if(behavior.sources.includes('chat'))definition.capabilities.push('room.chat@1');}else if(behavior?.type==='agent'){behavior.prompt=String(fields.get('prompt'));behavior.mode=fields.get('mode')==='answer'?'answer':'factCheck';const question=String(fields.get('initialQuestion')??'').trim();if(question)behavior.initialQuestion=question;else delete behavior.initialQuestion;}});}}>
    <label>Label<input name="label" defaultValue={d.label} required maxLength={80} disabled={disabled}/></label>
    {b&&b.type!=='weather'&&<label>{b.type==='agent'?'Research instructions':'Audience prompt'}<textarea name="prompt" defaultValue={b.type==='vote'?b.question:b.prompt} required disabled={disabled}/></label>}
    {b?.type==='vote'&&<label>Options · one per line<textarea name="options" defaultValue={b.options.map(o=>o.label).join('\n')} required disabled={disabled}/></label>}
    {b?.type==='agent'&&<label>Opening question<textarea name="initialQuestion" defaultValue={b.initialQuestion??''} maxLength={1000} disabled={disabled}/></label>}
    {b?.type==='agent'&&<label>Response mode<select name="mode" defaultValue={b.mode} disabled={disabled}><option value="factCheck">Fact check with evidence</option><option value="answer">Answer</option></select></label>}
    {(b?.type==='vote'||b?.type==='submissions')&&<label><span>Show to the audience automatically while running</span><input name="automatic" type="checkbox" defaultChecked={i.audiencePolicy==='whileRunning'} disabled={disabled}/></label>}
    {b?.type==='submissions'&&<label><span>Collect room chat for moderation</span><input name="chat" type="checkbox" defaultChecked={b.sources?.includes('chat')} disabled={disabled}/></label>}
    <button type="submit" disabled={disabled}>Save module</button>
   </form>
   <button type="button" disabled={disabled} onClick={()=>update(next=>{next.runtime.instances=next.runtime.instances.filter(item=>item.id!==i.id);if(!next.runtime.instances.some(item=>item.definition===i.definition))delete next.runtime.definitions[i.definition];})}>Remove module</button>
  </details>;})}
  <label>Add interaction<select value={kind} onChange={e=>setKind(e.target.value as ModuleKind)} disabled={disabled}><option value="vote">Audience vote</option><option value="submissions">Audience text submissions</option><option value="agent">Agent response / fact check</option><option value="weather">Weather</option></select></label>
  <label>Scope<select value={scope} onChange={e=>setScope(e.target.value)} disabled={disabled}><option value="set">Entire set</option>{segment&&<option value="segment">Current segment</option>}</select></label>
  <button type="button" disabled={disabled} onClick={()=>update(next=>{let n=1;while(next.runtime.definitions[kind+n]||next.runtime.instances.some(i=>i.id===kind+n))n++;const id=kind+n;next.runtime.definitions[id]=moduleTemplate(kind);next.runtime.instances.push(moduleInstance(id,id,scope==='segment'?segment:undefined));})}>Add module</button>
  {error&&<p role="alert">{error}</p>}
 </details>;
}
