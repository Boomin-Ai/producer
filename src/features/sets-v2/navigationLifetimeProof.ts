/** Explicit dev-only acceptance: exercise real preview resizes during 3D takes. */
import {invoke} from '@tauri-apps/api/core';
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{
 for(let i=0;i<1200;i++){const value=await read();if(value)return value as NonNullable<T>;await sleep(100);}throw Error('Timed out: '+label);
}
const button=(label:string,root:ParentNode=document)=>Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.getClientRects().length&&!b.disabled&&(b.textContent?.trim()===label||b.getAttribute('aria-label')===label));
export async function navigationLifetimeProof(){
 const originalWidth=document.body.style.width;let step='opening',editor:HTMLDialogElement|undefined;
 const report=(result:Record<string,unknown>)=>invoke('live_set_v2_report',{result:{kind:'navigation-lifetime',step,...result}});
 try{
  const dock=await until(()=>document.querySelector<HTMLElement>('.rm-sheet-head[data-kind="bottom"]'),'controls dock');if(dock.getAttribute('aria-label')==='Show the bottom row')dock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await until(()=>document.querySelector('.set-current-name')?.textContent?.includes('Atmosphere'),'Atmosphere');
  (await until(()=>button('Set settings'),'editor')).click();editor=await until(()=>document.querySelector<HTMLDialogElement>('dialog[open]'),'editor');
  (await until(()=>button('Show on output',editor),'apply')).click();await until(()=>editor?.querySelector('.set-editor-apply-status.applied'),'output presented');button('Close editor')?.click();
  const studio=await until(()=>Array.from(document.querySelectorAll<HTMLElement>('.module-operator-card')).find(c=>c.querySelector('h3')?.textContent==='Camera composition'),'camera module');button('Start',studio)?.click();
  await until(()=>document.querySelector('.set-controls[data-layouts-ready="6"]'),'six warmed layouts');
  const generation=(await invoke<{generation:number}>('live_set_status')).generation;
  type Status={renderSerial:number;renderedRevision:number;transitioning:boolean;scene3dContexts:number;cachedBytes:number};
  const read=()=>invoke<Status>('live_set_v2',{request:{op:'status',generation}});
  const samples:Status[]=[];
  for(let i=0;i<24;i++){
   step='navigation '+(i+1);const before=await read();const pose=['Split','Presenter','Hero'][i%3];
   document.body.style.width=i%2?'100%':'calc(100% - 180px)';
   (await until(()=>button(pose,studio),pose)).click();
   const after=await until(async()=>{const s=await read();return !s.transitioning&&s.renderSerial>before.renderSerial&&s.renderedRevision>before.renderedRevision?s:null;},'take '+pose);samples.push(after);
   await sleep(150);await report({running:true,changes:i+1,status:after});
  }
  step='complete';await report({ok:true,changes:samples.length,maximum3dContexts:Math.max(...samples.map(s=>s.scene3dContexts)),maximumCachedBytes:Math.max(...samples.map(s=>s.cachedBytes)),samples});
 }catch(error){await report({ok:false,error:String(error)});}
 finally{document.body.style.width=originalWidth;if(editor?.open)button('Close editor')?.click();}
}
