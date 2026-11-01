import {useEffect,useState} from 'react';
import type {PresentationPackage} from '../schema';
import {packageRevision} from './compiler';
import {auditVisuals} from './visualBrowser';
import {repairCameraRing,type RingRepair,type VisualReport} from './visual';

export function VisualReview({doc,onRepair}:{doc:PresentationPackage;onRepair:(doc:PresentationPackage)=>void}){
 const [report,setReport]=useState<VisualReport>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{const controller=new AbortController();setReport(undefined);setError('');setBusy(false);void auditVisuals(doc,controller.signal).then(r=>{if(!controller.signal.aborted)setReport(r);}).catch(e=>{if(!controller.signal.aborted)setError(String(e.message??e));});return()=>controller.abort();},[doc]);
 async function repair(target:RingRepair){setBusy(true);setError('');try{const fixed=await repairCameraRing(doc,{...target,baseRevision:await packageRevision(doc)});onRepair(fixed);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 const repairs=[...new Map(report?.issues.filter(i=>i.repair).map(i=>[i.layout+'/'+i.node,i.repair!])).values()];
 return <section aria-label="Visual review"><h3>Visual review</h3>
  {!report&&!error&&<p role="status">Checking text and spacing in every layout…</p>}
  {error&&<p role="alert">{error}</p>}
  {report&&<><p>{report.issues.length?`${report.issues.length} findings to review.`:'Configured text fits; no supported geometry issues found.'} Camera and microphone checks still require native output.</p>
   {!!report.issues.length&&<ul>{report.issues.map((issue,i)=><li key={i}><strong>{issue.layout} · {issue.node}</strong>: {issue.message}</li>)}</ul>}
   {repairs.map(r=><button key={r.layout+'/'+r.ring} disabled={busy} onClick={()=>void repair(r)}>Fit {r.ring} around {r.camera} · {r.layout}</button>)}
  </>}
 </section>;
}
