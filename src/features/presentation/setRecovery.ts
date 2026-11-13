import type {PresentationPackage} from './schema';
import type {SetOutputControls} from './useSetOutput';
import {outputLayout} from './layoutViews';
import {failedCaptureIds,sourceRecoveries,unavailableSetSource,type SourceRecovery} from './sourceRecovery';

export function setRecovery(doc:PresentationPackage,layout:string,output:SetOutputControls,names:Record<string,string>={}) {
  // Removed/recreated source IDs already have a dedicated explicit rebinding UI.
  const missing=new Set(sourceRecoveries(doc.set.slots,output.bindings,output.sources).map(issue=>issue.sourceId));
  const handled=(message:string)=>{
    const ids=failedCaptureIds(message);
    return missing.has(unavailableSetSource(message)??'')||ids.length>0&&ids.every(id=>missing.has(id));
  };
  const failed=Object.entries(output.layoutReadiness??{}).filter(([,state])=>state.state==='error'&&!handled(state.error??''));
  const outputError=output.error&&!handled(output.error)?output.error:'';
  const details=[...new Set([outputError,...failed.map(([,state])=>state.error??'Layout could not be prepared.')].filter(Boolean).map(message=>message.replace(/^Error: /,'')))];
  if(!details.length)return;
  const ids=[...new Set(details.flatMap(failedCaptureIds))];
  const recoveries:SourceRecovery[]=ids.flatMap(sourceId=>{
    const slots=doc.set.slots.filter(slot=>output.bindings[slot.id]===sourceId);
    if(!slots.length)return [];
    const source=output.sources.items?.find(item=>item.id===sourceId);
    const candidates=(output.sources.items??[]).filter(item=>item.kind!=='mic'&&item.id!==sourceId);
    const compatible=candidates.filter(item=>item.kind===source?.kind&&item.has_frame);
    return [{sourceId,slots,candidates,suggested:compatible.length===1?compatible[0]:undefined}];
  });
  const capture=details.every(message=>failedCaptureIds(message).length>0)&&recoveries.length>0;
  const sources=recoveries.map(issue=>output.sources.items?.find(item=>item.id===issue.sourceId));
  const camera=capture&&sources.every(source=>source?.kind==='camera');
  const screen=capture&&sources.every(source=>source?.kind==='screen');
  const sourceNames=[...new Set(recoveries.map(issue=>names[issue.sourceId]??output.sources.items?.find(item=>item.id===issue.sourceId)?.label??issue.slots[0].label))];
  const retained=details.some(message=>/^Set first-frame timeout \(.+\); current output retained$/.test(message)||message==='Set rendering did not confirm. The current output is retained.');
  const layouts=[...new Set([...failed.map(([id])=>id),...(outputError?(output.requiredOrientations??['landscape']).map(orientation=>outputLayout(doc.set,layout,orientation)):[])])];
  return {
    title:camera?'Camera isn’t sending video':screen?'Screen share isn’t ready':capture?'Video source isn’t ready':outputError?'Set needs attention':'A layout couldn’t load',
    description:capture?`Waiting for a frame from ${sourceNames.join(' and ')}.`:'Retry preparation or review the details below.',
    chooseLabel:camera?'Choose camera':screen?'Choose screen':'Choose source',
    details,layouts,recoveries,retained,severity:outputError&&!output.active&&!retained?'error':'warning',
  };
}
export type SetRecovery=NonNullable<ReturnType<typeof setRecovery>>;
