import {previewFrameSource} from '../frameSource';
import {RehearsalSession} from '../rehearsal';
import {outputProjection} from '../projection';
import type {PresentationPackage} from '../schema';
import {checkVisualGeometry,type VisualReport} from './visual';

/** Sequential, offscreen real-renderer checks; no cameras, audio or room writes.
 * Evaluates configured default content, not every future feed/animation state. */
export async function auditVisuals(doc:PresentationPackage,signal?:AbortSignal):Promise<VisualReport>{
 const report=checkVisualGeometry(doc),session=new RehearsalSession(doc,undefined,'prepare');
 for(const layout of doc.set.layouts){
  signal?.throwIfAborted();
  const metrics=await new Promise<Array<{node:string;width:number;height:number;contentWidth:number;contentHeight:number}>>((resolve,reject)=>{
   const iframe=document.createElement('iframe');iframe.setAttribute('sandbox','allow-scripts');iframe.setAttribute('aria-hidden','true');
   iframe.style.cssText=`position:fixed;left:-30000px;top:0;width:${layout.width}px;height:${layout.height}px;border:0;visibility:hidden;pointer-events:none;`;
   let port:MessagePort|undefined,finished=false;
   const finish=(error?:Error,value:typeof metrics=[])=>{if(finished)return;finished=true;clearTimeout(timeout);window.removeEventListener('message',connect);signal?.removeEventListener('abort',abort);port?.close();iframe.remove();error?reject(error):resolve(value);};
   const abort=()=>finish(new Error('Visual review canceled.'));
   const timeout=setTimeout(()=>finish(new Error(`Visual review timed out for ${layout.label}.`)),10000);
   const connect=(event:MessageEvent)=>{
    if(event.source!==iframe.contentWindow||event.data!=='presentation.ready'||port)return;
    const channel=new MessageChannel();port=channel.port1;
    port.onmessage=event=>{
     const data=event.data;
     if(data?.type==='connected'){
      try{
      const projection=outputProjection(doc,{...session.snapshot(),layoutId:layout.id});
      // Freeze transitions and prevent offscreen media playback. Missing native
      // media is reported by the renderer, never claimed to have been checked.
      projection.timeline=undefined;
      const stop=(n:typeof projection.root)=>{if(n.playback)n.playback={...n.playback,playing:false};n.autoplay=false;n.children.forEach(stop);};stop(projection.root);
      port?.postMessage({type:'output',surface:'foreground',audit:true,serial:1,projection});
      }catch(e){finish(e instanceof Error?e:new Error(String(e)));}
     }
     if(data?.type==='visual-audit'&&data.serial===1)finish(undefined,data.textMetrics);
     if(data?.type==='error')finish(new Error(`The renderer could not review ${layout.label}.`));
    };
    port.start();iframe.contentWindow?.postMessage('presentation.connect','*',[channel.port2]);
   };
   window.addEventListener('message',connect);signal?.addEventListener('abort',abort,{once:true});
   iframe.srcdoc=previewFrameSource();document.body.appendChild(iframe);
   if(signal?.aborted)abort();
  });
  for(const m of metrics)if(m.contentWidth>m.width+1||m.contentHeight>m.height+1){
   const direct=layout.root.children?.find(n=>m.node===`output/${layout.root.id}/${n.id}`);
   report.issues.push({code:'text_fit',layout:layout.id,node:direct?.id??m.node,path:m.node,severity:'error',measurements:{width:m.width,height:m.height,contentWidth:m.contentWidth,contentHeight:m.contentHeight},message:`Text needs ${m.contentWidth}×${m.contentHeight}px but its box is ${m.width}×${m.height}px. Increase its bounds, reduce type size or shorten the text.`});
  }
 }
 return {...report,textChecked:true};
}
