import {useState,type ReactNode} from 'react';
import {evaluate,type Control,type Scalar} from './contract';
import type {Command,Result,SetRuntime,Citation} from './runtime';
export type ParticipantSnapshot=ReturnType<SetRuntime['public']>;
export function CitedResponse({text,citations}:{text:string;citations:Citation[]}){
 const nodes:ReactNode[]=[];let cursor=0;
 const links=citations.filter(c=>c.start!==undefined&&c.end!==undefined&&c.start>=0&&c.end>c.start&&c.end<=text.length).sort((a,b)=>a.start!-b.start!||a.end!-b.end!);
 for(const [i,c]of links.entries()){
  if(c.start!<cursor)continue;
  let url:URL;try{url=new URL(c.url);}catch{continue;}if(url.protocol!=='https:')continue;
  nodes.push(text.slice(cursor,c.start));nodes.push(<a key={i} href={url.href} target="_blank" rel="noreferrer">{text.slice(c.start,c.end)}</a>);cursor=c.end!;
 }
 nodes.push(text.slice(cursor));
 return <div className="module-cited-response"><div style={{whiteSpace:'pre-wrap'}}>{nodes}</div>{citations.length>0&&<ul aria-label="Sources">{citations.map((c,i)=>/^https:\/\//.test(c.url)?<li key={i}><a href={c.url} target="_blank" rel="noreferrer">{c.title||c.url}</a></li>:null)}</ul>}</div>;
}
/** The actual participant surface. Rehearsal changes only its transport/domain. */
export function ParticipantPanel({snapshot,onCommand,connected=true,simulation=false,displayName='Audience'}:{snapshot:ParticipantSnapshot;onCommand:(command:Command)=>Promise<Result>;connected?:boolean;simulation?:boolean;displayName?:string}){
 const [busy,setBusy]=useState<Record<string,boolean>>({}),[errors,setErrors]=useState<Record<string,string>>({}),[answers,setAnswers]=useState<Record<string,string>>({}),[text,setText]=useState<Record<string,string>>({});
 const key=(m:ParticipantSnapshot['modules'][number])=>[snapshot.setEpoch,m.id,m.epoch,m.round].join(':');
 const send=async(m:ParticipantSnapshot['modules'][number],op:string,input:Record<string,Scalar>={})=>{
  if(!connected||busy[m.id])return false;setBusy(v=>({...v,[m.id]:true}));setErrors(v=>({...v,[m.id]:''}));
  try{const result=await onCommand({id:crypto.randomUUID(),setEpoch:snapshot.setEpoch,module:m.id,epoch:m.epoch,op,input:{...input,round:m.round}});if(result.status==='rejected')throw Error(result.error);return true;}catch(e){setErrors(v=>({...v,[m.id]:e instanceof Error?e.message:'Input failed'}));return false;}finally{setBusy(v=>({...v,[m.id]:false}));}
 };
 const available=(m:ParticipantSnapshot['modules'][number])=>connected&&!busy[m.id]&&m.execution==='running'&&m.admission==='open';
 const control=(m:ParticipantSnapshot['modules'][number],c:Control)=>{
  try{if(c.when!==undefined&&evaluate(c.when,m.values,{},{} )!==true)return null;const enabled=available(m)&&(c.enabled===undefined||evaluate(c.enabled,m.values,{},{} )===true);
   if(c.type==='readout')return <div key={c.id}><span>{c.label}</span> <strong>{c.field?String(m.values[c.field]??''):''}</strong></div>;
   if(c.type==='button'&&c.action)return <button key={c.id} disabled={!enabled} onClick={()=>void send(m,c.action!)}>{c.label}</button>;
   return null;
  }catch{return null;}
 };
 return <section className="module-participant-panel" aria-label={simulation?'Simulated audience panel':'Audience interactions'}>
  <div className="module-panel-heading"><strong>{simulation?'Audience simulation':'Participate'}</strong><span role="status">{connected?simulation?'Private rehearsal':'Connected':'Disconnected'}</span></div>
  {!snapshot.modules.length&&<p>No interactions are open right now.</p>}
  {snapshot.modules.map(m=>{const vote=m.vote,submission=m.text,answer=m.agent,k=key(m);return <article className="module-participant-card" key={m.id} aria-label={m.label}>
   <h3>{m.label}</h3>
   {vote&&<><p>{vote.question}</p>{vote.results?<div className="module-poll-results">{vote.options.map(o=>{const count=vote.results!.counts[o.id]??0,pct=vote.results!.total?Math.max(0,Math.min(100,100*count/vote.results!.total)):0;return <div key={o.id}><span>{o.label}</span><progress max={100} value={pct}/><strong>{Math.round(pct)}%</strong></div>;})}<small>{vote.results.total} responses</small></div>:<div className="module-choice-buttons">{vote.options.map(o=><button key={o.id} aria-pressed={answers[k]===o.id} disabled={!available(m)||!!answers[k]&&!vote.allowChange} onClick={()=>void send(m,'vote',{choice:o.id}).then(ok=>{if(ok)setAnswers(v=>({...v,[k]:o.id}));})}>{o.label}</button>)}</div>}{answers[k]&&<p role="status">Your response was counted.</p>}{m.admission!=='open'&&!vote.results&&<small>Voting is closed.</small>}</>}
   {submission?.acceptsSubmissions&&<><p>{submission.prompt}</p><form onSubmit={e=>{e.preventDefault();void send(m,'submit',{text:text[k]??'',name:displayName}).then(ok=>{if(ok){setAnswers(v=>({...v,[k]:'submitted'}));setText(v=>({...v,[k]:''}));}});}}><label>Your submission<textarea maxLength={submission.maxLength} required value={text[k]??''} disabled={!available(m)||!!answers[k]} onChange={e=>setText(v=>({...v,[k]:e.target.value}))}/></label><button disabled={!available(m)||!!answers[k]||!text[k]?.trim()}>Submit</button></form>{answers[k]&&<p role="status">Submitted for review.</p>}{submission.featured&&<blockquote><p>{submission.featured.text}</p><footer>{submission.featured.name}</footer></blockquote>}</>}
   {answer?.response&&<><p>{answer.question}</p><CitedResponse text={answer.response} citations={answer.citations}/></>}
   {m.controls.map(g=><div className="module-control-group" key={g.id}><h4>{g.label}</h4>{g.controls.map(c=>control(m,c))}</div>)}
   {errors[m.id]&&<p role="alert">{errors[m.id]}</p>}
  </article>;})}
 </section>;
}
