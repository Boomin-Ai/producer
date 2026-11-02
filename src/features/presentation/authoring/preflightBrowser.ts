import {compileRoomScene} from '../../sets-v2/roomCompiler';
import {morphTargets} from '../../sets-v2/preparedScenes';
import {outputProjection} from '../projection';
import {RehearsalSession} from '../rehearsal';
import type {PresentationPackage} from '../schema';
import {estimateRenderPlan} from './preflight';
/** CPU/DOM lowering only. No source capture, asset decoding or native allocation. */
export async function auditNativeEstimates(doc:PresentationPackage,signal?:AbortSignal){
 const session=new RehearsalSession(doc,undefined,'prepare');
 const projections=doc.set.layouts.map(layout=>outputProjection(doc,{...session.snapshot(),layoutId:layout.id}));
 const results=[];
 for(const [index,layout]of doc.set.layouts.entries()){
  signal?.throwIfAborted();const projection=projections[index],portrait=layout.height>layout.width;
  const plan=await compileRoomScene(projection,{definitionId:doc.id,instanceId:'authoring-preflight',canvasId:layout.id,target:{id:portrait?'portrait':'program',orientation:portrait?'portrait':'landscape',width:portrait?1080:1920,height:portrait?1920:1080,scaling:'contain'},bindings:Object.fromEntries(doc.set.slots.map(s=>[s.id,'placeholder-'+s.id])),retainedTargets:morphTargets(projections,projection)});
  results.push({layout:layout.id,...estimateRenderPlan(plan)});
 }
 return results;
}
