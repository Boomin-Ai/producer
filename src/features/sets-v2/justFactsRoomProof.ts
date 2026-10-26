/** Opt-in native acceptance: existing source bindings, no provider calls or new sources. */
import {invoke} from '@tauri-apps/api/core';
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{for(let i=0;i<900;i++){const value=await read();if(value)return value as NonNullable<T>;await sleep(100);}throw Error('Timed out: '+label);}
const button=(label:string,root:ParentNode=document)=>Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.getClientRects().length>0&&!b.disabled&&(b.textContent?.trim()===label||b.getAttribute('aria-label')===label));
function input(el:HTMLSelectElement|HTMLTextAreaElement,value:string){const type=el instanceof HTMLSelectElement?HTMLSelectElement:HTMLTextAreaElement;Object.getOwnPropertyDescriptor(type.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));}
export async function justFactsRoomProof(){
 let stage='open';const progress=setInterval(()=>{void invoke('live_set_v2_report',{result:{kind:'just-facts-show-progress',stage,at:new Date().toISOString()}})},10000);
 try{
  stage='bottom controls';const dock=await until(()=>document.querySelector<HTMLElement>('.rm-sheet-head[data-kind="bottom"]'),'bottom controls');
  if(dock.getAttribute('aria-label')==='Show the bottom row')dock.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await until(()=>document.querySelector('.set-current-name')?.textContent?.includes('Just Facts'),'Just Facts room');
  stage='output readiness';await until(()=>button('Start show')||button('Stop run'),'active show controls');
  await until(()=>document.querySelector('.set-controls'),'layout inventory');
  stage='output readiness';button('Output settings')?.click();
  const lockedCamera=!!button('Stop virtual camera');
  // Preserve a virtual camera in use: orientation is intentionally locked.
  if(!lockedCamera)(await until(()=>button('Both'),'both outputs')).click();button('Close output settings')?.click();
  const nativeOutputs=lockedCamera?['program']:['program','portrait'];
  const generation=(await invoke<{generation:number}>('live_set_status')).generation;
  type Status={renderedRevision:number;renderSerial:number;scene3dContexts:number;cachedBytes:number;cachedKeys:string[]};
  const read=()=>Promise.all(nativeOutputs.map(outputId=>invoke<Status>('live_set_v2',{request:{op:'status',generation,...(outputId==='portrait'?{outputId}:{})}})));
  await until(async()=>{const s=await read();return s.every(v=>v.renderedRevision>0)?s:null;},'initial output pair');
  const presented=async(run:()=>void|Promise<void>,label:string)=>{const before=await read();await run();return until(async()=>{const after=await read();return after.every((s,i)=>s.renderedRevision>before[i].renderedRevision)?after:null;},label);};
  stage='start show';button('Stop run')?.click();(await until(()=>button('Start show'),'show start')).click();await until(()=>button('Stop run'),'running');
  const card=(prefix:string)=>Array.from(document.querySelectorAll<HTMLElement>('.module-operator-card')).find(c=>c.getClientRects().length>0&&c.querySelector('h3')?.textContent?.startsWith(prefix));
  stage='host controls';const scores=await until(()=>card('Host / round decisions'),'host controls');
  const click=async(label:string,root:ParentNode=document)=>(await until(()=>button(label,root),label)).click();
  await click('Reset',scores);await sleep(100);const restart=await until(()=>button('Start',scores)||button('Pause',scores),'reset host controls');if(restart.textContent?.trim()==='Start')restart.click();
  const readScore=()=>Array.from(scores.querySelectorAll('div')).find(d=>d.querySelector('span')?.textContent==='Guest A points')?.querySelector('strong')?.textContent;
  await until(()=>readScore()==='0','fresh test score');
  for(const [index,value]of [[0,'true'],[1,'false']] as const){const choice=await until(()=>{const el=scores.querySelectorAll('select')[index];return el&&!el.disabled?el:null;},'answer control');input(choice,value);await sleep(100);await until(()=>button('Award point to Guest A',scores),'answer committed');}
  await presented(()=>click('Award point to Guest A',scores),'host award');
  await until(()=>readScore()==='1','one point');await click('Award point to Guest A',scores);await sleep(100);await until(()=>button('Award point to Guest A',scores),'duplicate committed');if(readScore()!=='1')throw Error('Repeated award added a second point');
  const research=await until(()=>card('Question 01 / fact-check'),'research');await click('Reset',research);await sleep(100);const resumeResearch=await until(()=>button('Start',research)||button('Pause',research),'reset research');if(resumeResearch.textContent?.trim()==='Start')resumeResearch.click();await sleep(300);const question=research.querySelector('textarea')!.value;
  stage='evidence';await presented(()=>click('Fact-check view',research),'fact-check view');
  const details=Array.from(research.querySelectorAll('details')).find(d=>d.querySelector('summary')?.textContent==='Embed an existing response')!;details.open=true;
  input(details.querySelector('textarea')!,'Native acceptance sample. The host reviews evidence before choosing a verdict.');await sleep(150);await click('Use response',research);await until(()=>button('Show response',research),'private response');
  await presented(()=>click('Show response',research),'revealed response');
  stage='segments';const labels=[],cacheSamples=[];
  for(let i=0;i<10;i++){
   stage='question '+(i+2);await presented(async()=>(await until(()=>button('Next'),'next control')).click(),'next question '+(i+2));
   const cache=await read();cacheSamples.push(cache.map(s=>({bytes:s.cachedBytes,keys:s.cachedKeys.length})));if(cache.some(s=>s.cachedKeys.length>4))throw Error('Historical snapshots remain retained');
   const expected=i===9?'Tie-breaker / fact-check':'Question '+String(i+2).padStart(2,'0')+' / fact-check';await until(()=>card(expected),'segment module');labels.push(expected);
  }
  for(let i=0;i<10;i++)await presented(async()=>(await until(()=>button('Previous segment'),'previous control')).click(),'return question');
  const first=await until(()=>card('Question 01 / fact-check'),'original question');if(first.querySelector('textarea')?.value!==question)throw Error('Question state did not survive reentry');
  stage='restore';await presented(()=>click('Reset',first),'reset test research and restore authored question');
  const scoreCard=card('Host / round decisions')!;await presented(()=>click('Clear round award',scoreCard),'clear test award');await presented(()=>click('Reset',scoreCard),'clear test guest answers');button('Stop run')?.click();
  const pair=await read();await invoke('live_set_v2_report',{result:{kind:'just-facts-show-native',ok:true,at:new Date().toISOString(),segments:11,layouts:2,cacheSamples,nativeOutputs,virtualCameraPreserved:lockedCamera,labels,pair,duplicateAwardPrevented:true,questionPreserved:true,providerCalls:0,createdRoomSources:0}});
 }catch(error){await invoke('live_set_v2_report',{result:{kind:'just-facts-show-native',ok:false,stage,error:String(error),body:document.body.innerText.slice(-1800)}});}finally{clearInterval(progress);}
}
