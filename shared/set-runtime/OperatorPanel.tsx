import {useState} from 'react';
import {evaluate,type Control,type RuntimeDefinition,type Scalar} from './contract';
import type {Snapshot,Result,Weather} from './runtime';
import {CitedResponse} from './ParticipantPanel';
import {answerPages,presentationText} from './projection';
export interface OperatorPanelProps {
 definition:RuntimeDefinition;snapshot:Snapshot;segment?:string;disabled?:boolean;
 send:(module:string,op:string,input?:Record<string,Scalar>)=>Promise<Result>;
 requestAgent?:(module:string,question:string)=>Promise<void>;
 simulateWeather?:(module:string,condition:Weather['condition'],isDay:boolean)=>Promise<Result>;
}
/** One renderer for package-authored operator controls; authority stays in the runtime. */
export function OperatorPanel({definition,snapshot,segment,disabled=false,send,requestAgent,simulateWeather}:OperatorPanelProps){
 const [busy,setBusy]=useState<Record<string,boolean>>({}),[errors,setErrors]=useState<Record<string,string>>({}),[drafts,setDrafts]=useState<Record<string,string>>({});
 const run=async(id:string,op:string,input:Record<string,Scalar>={})=>{if(disabled||busy[id])return;setBusy(v=>({...v,[id]:true}));setErrors(v=>({...v,[id]:''}));try{const result=await send(id,op,input);if(result.status==='rejected')throw Error(result.error);}catch(e){setErrors(v=>({...v,[id]:e instanceof Error?e.message:'Action failed'}));}finally{setBusy(v=>({...v,[id]:false}));}};
 return <section className="module-operator-panel" aria-label="Module controls">{definition.instances.filter(i=>i.owner==='set'||i.segment===segment).map(instance=>{
  const m=snapshot.modules[instance.id],d=definition.definitions[instance.definition];if(!m)return null;
  const id=m.id,k=`${snapshot.setEpoch}:${id}:${m.epoch}`,locked=disabled||busy[id]||m.execution==='disposed',behavior=d.behavior;
  const button=(label:string,op:string,off=false,input:Record<string,Scalar>={})=><button type="button" key={op} disabled={locked||off} onClick={()=>void run(id,op,input)}>{label}</button>;
  const render=(c:Control)=>{
   if(c.when!==undefined&&evaluate(c.when,m.values,{},{} )!==true)return null;
   const off=locked||m.execution!=='running'||c.enabled!==undefined&&evaluate(c.enabled,m.values,{},{} )!==true,field=c.field?d.state[c.field]:undefined,value=c.field?m.values[c.field]:'';
   if(c.type==='button')return <button key={c.id} type="button" disabled={off} onClick={()=>void run(id,c.action!)}>{c.label}</button>;
   if(c.type==='readout')return <div key={c.id}><span>{c.label}</span> <strong>{String(value??'')}</strong></div>;
   if(!field||!c.field)return null;
   const update=(value:Scalar)=>void run(id,'field',{field:c.field!,value});
   if(c.type==='toggle')return <label key={c.id}><span>{c.label}</span><input type="checkbox" checked={!!value} disabled={off} onChange={e=>update(e.target.checked)}/></label>;
   if(c.type==='choice')return <label key={c.id}>{c.label}<select value={String(value)} disabled={off} onChange={e=>update(e.target.value)}>{c.options?.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</select></label>;
   return <label key={c.id}>{c.label}<input type={c.type==='number'?'number':'text'} value={value as string|number} disabled={off} {...(field.type==='number'?{min:field.min,max:field.max}:field.type==='text'?{maxLength:field.maxLength}:{})} onChange={e=>update(c.type==='number'?e.target.valueAsNumber:e.target.value)}/></label>;
  };
  return <article key={id} className="module-operator-card"><div className="module-panel-heading"><h3>{d.label}</h3><span>{instance.owner==='set'?'Set':'Segment'} · {m.execution}{m.published?' · Audience visible':''}</span></div>
   <div className="module-operator-actions">{m.execution==='running'?button('Pause','pause'):button(m.execution==='paused'?'Resume':'Start',m.execution==='paused'?'resume':'start')}{button('Reset','reset')}</div>
   {d.controls.filter(g=>g.audience==='operator').map(g=><div key={g.id} className="module-control-group"><h4>{g.label}</h4>{g.controls.map(render)}</div>)}
   {(behavior?.type==='vote'||behavior?.type==='submissions')&&<><p>{behavior.type==='vote'?behavior.question:behavior.prompt}</p><div className="module-operator-actions">
    {m.published?button('Remove from audience','withdraw'):button('Show to audience','publish',m.execution!=='running')}
    {m.admission==='open'?button('Close intake','close'):button('Open intake','open',!m.published||m.revealed||m.execution!=='running')}
    {behavior.type==='vote'&&button('Reveal results','reveal',m.admission!=='closed'||m.execution!=='running'||m.revealed)}
    {button('New round','round.new',m.execution!=='running')}
   </div><p>{m.total} {behavior.type==='vote'?'votes':'responses'} · Intake {m.admission}</p></>}
   {behavior?.type==='submissions'&&<div className="module-submission-queue">{m.submissions.filter(s=>s.status!=='rejected').map(item=><article key={item.id}><p>{item.text}</p><small>{item.name} · {item.source==='chat'?'Room chat':'Submission'} · {item.status}</small><div className="module-operator-actions">{item.status==='pending'&&button('Approve','approve',false,{item:item.id})}{button('Reject','reject',false,{item:item.id})}{item.status==='approved'&&button(m.featured===item.id?'On canvas':'Show on canvas','feature',m.featured===item.id,{item:item.id})}</div></article>)}{m.featured&&button('Clear canvas','unfeature')}</div>}
   {behavior?.type==='agent'&&<><label>Ask a question<textarea maxLength={1000} value={drafts[k+'question']??m.agent.question} disabled={locked} onChange={e=>setDrafts(v=>({...v,[k+'question']:e.target.value}))}/></label>
    <button type="button" disabled={locked||m.execution!=='running'||m.agent.status==='pending'||!requestAgent||!(drafts[k+'question']??m.agent.question).trim()} onClick={()=>{setBusy(v=>({...v,[id]:true}));setErrors(v=>({...v,[id]:''}));void requestAgent!(id,drafts[k+'question']??m.agent.question).catch(e=>setErrors(v=>({...v,[id]:e instanceof Error?e.message:'Request failed'}))).finally(()=>setBusy(v=>({...v,[id]:false})));}}>{m.agent.status==='pending'?'Researching…':'Ask agent'}</button>
    {!requestAgent&&<p className="set-section-note">Bind a saved agent connection to enable research.</p>}
    <details><summary>Embed an existing response</summary><label>Response<textarea maxLength={behavior.maxLength} value={drafts[k+'response']??''} disabled={locked} onChange={e=>setDrafts(v=>({...v,[k+'response']:e.target.value}))}/></label>{button('Use response','agent.embed',!drafts[k+'response']?.trim(),{question:drafts[k+'question']??m.agent.question,response:drafts[k+'response']??''})}</details>
    {m.agent.error&&<p role="alert">{m.agent.error}</p>}
    {m.agent.status==='completed'&&<details open><summary>Response preview · {m.agent.origin}</summary><CitedResponse text={m.agent.response} citations={m.agent.citations}/></details>}
    <div className="module-operator-actions">{button('Show response','agent.show',m.agent.status!=='completed')}{button('Clear response','agent.clear',!m.agent.displayedResponse)}</div>
    {m.agent.displayedResponse&&<div className="module-operator-actions">{button('Previous page','agent.page',m.agent.page===0,{page:m.agent.page-1})}<span>Page {m.agent.page+1} / {answerPages(presentationText(m.agent.displayedResponse)).length}</span>{button('Next page','agent.page',m.agent.page+1>=answerPages(presentationText(m.agent.displayedResponse)).length,{page:m.agent.page+1})}</div>}
   </>}
   {behavior?.type==='weather'&&<>{simulateWeather&&<div className="module-control-group"><label>Simulated conditions<select disabled={locked} value={m.weather?.condition??'clear'} onChange={e=>void simulateWeather(id,e.target.value as Weather['condition'],m.weather?.isDay??true).then(r=>{if(r.status==='rejected')setErrors(v=>({...v,[id]:r.error}));})}>{['clear','cloudy','fog','rain','snow','storm'].map(c=><option key={c} value={c}>{c}</option>)}</select></label><label>Daylight<input type="checkbox" checked={m.weather?.isDay??true} disabled={locked} onChange={e=>void simulateWeather(id,m.weather?.condition??'clear',e.target.checked)}/></label></div>}<button disabled={locked||m.execution!=='running'||!requestAgent} onClick={()=>void requestAgent!(id,'').catch(e=>setErrors(v=>({...v,[id]:e instanceof Error?e.message:'Weather request failed'})))}>Refresh weather</button><p>{m.weather?`${m.weather.location} · ${m.weather.temperature}° · ${m.weather.condition}`:'Waiting for weather connection'} · {m.dataStatus}</p></>}
   {errors[id]&&<p role="alert">{errors[id]}</p>}
  </article>;
 })}</section>;
}
