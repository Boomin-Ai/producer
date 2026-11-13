import {useEffect,useId,useRef,useState} from 'react';
import type {PresentationPackage} from './schema';
import type {SetOutputControls} from './useSetOutput';
import {setRecovery,type SetRecovery} from './setRecovery';
import {SetSourceRecovery} from './SetSourceRecovery';

export function SetRecoveryNotice({doc,layout,output,names,blocked=false}:{doc:PresentationPackage;layout:string;output:SetOutputControls;names:Record<string,string>;blocked?:boolean}) {
  const current=setRecovery(doc,layout,output,names);
  const [attempt,setAttempt]=useState<SetRecovery>();
  const [working,setWorking]=useState(false),[choosing,setChoosing]=useState(false),[localError,setLocalError]=useState('');
  const flight=useRef(false),pickerId=useId();
  const warming=attempt?.layouts.some(id=>['queued','loading'].includes(output.layoutReadiness?.[id]?.state??''));
  // Do not resurrect a completed retry when a later, healthy edit queues these
  // layouts again. Readiness belongs to this attempt only until it settles.
  useEffect(()=>{if(attempt&&!working&&!warming)setAttempt(undefined);},[attempt,working,warming]);
  const issue=current??(working||warming?attempt:undefined);
  if(!issue)return null;
  const busy=working||!!warming||output.busy;
  const retry=async()=>{
    if(flight.current||blocked||output.busy)return;
    flight.current=true;setWorking(true);setAttempt(issue);setLocalError('');
    try{
      output.retryPreparation?.(issue.layouts);
      // A warm-only failure must not put a deliberately hidden Set on output.
      // Retrying a failed explicit Show/Update uses the existing fenced take.
      if(output.error)await output.apply();
    }catch(error){setLocalError(String(error));}
    finally{flight.current=false;setWorking(false);}
  };
  return <section className="set-recovery-notice" aria-label="Set recovery" data-severity={issue.severity} aria-busy={busy}>
    <div className="set-recovery-message">
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 5v6m0 3v1"/></svg>
      <div><strong>{issue.title}</strong><p role={issue.severity==='error'?'alert':'status'}>{issue.description}</p></div>
    </div>
    {issue.retained&&<span className="set-recovery-retained">Previous output retained</span>}
    <div className="set-recovery-actions">
      <button type="button" disabled={blocked||busy||!output.error&&!output.retryPreparation} onClick={()=>void retry()}>{busy?'Retrying…':'Retry'}</button>
      {issue.recoveries.length>0&&<button type="button" className="set-recovery-choose" disabled={blocked||busy} aria-expanded={choosing} aria-controls={pickerId} onClick={()=>setChoosing(open=>!open)}>{issue.chooseLabel}</button>}
    </div>
    {choosing&&<div id={pickerId}><SetSourceRecovery compact slots={doc.set.slots} output={output} names={names} blocked={blocked||busy} issues={issue.recoveries} retryLayouts={issue.layouts}/></div>}
    <details className="set-recovery-details"><summary>Details</summary><pre>{[...issue.details,...(localError?[localError]:[])].join('\n\n')}</pre></details>
  </section>;
}
