import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '../tools/producer-mcp/node_modules/playwright-core/index.mjs';
const out='target/ai-engineering-cloudflare/',result=JSON.parse(await readFile(out+'result.json','utf8')),doc=JSON.parse(await readFile(result.path,'utf8'));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1200,height:1000}});await page.goto('http://127.0.0.1:1436/scripts/scene3d/study-preview.html');
 await page.evaluate(async doc=>{const R=(await import('/node_modules/.vite/deps/react.js')).default,D=await import('/node_modules/.vite/deps/react-dom_client.js');const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts'),{SetPreview}=await import('/src/features/presentation/SetPreview.tsx');window.session=new RehearsalSession(doc,undefined,'prepare');window.root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));window.paint=()=>window.root.render(R.createElement(SetPreview,{doc,state:window.session.snapshot()}));window.paint();},doc);
 const checks=[];
 for(const orientation of ['landscape','portrait']){
  await page.evaluate(orientation=>{window.session.send({type:'control',action:{type:'layout.select',layoutId:'workflow-'+orientation}});document.getElementById('root').style.width=orientation==='portrait'?'540px':'1200px';window.paint();},orientation);
  const frame=page.frameLocator('iframe');await frame.locator('[data-node$="/packet-0"]').first().waitFor({state:'attached'});await page.waitForTimeout(900);
  const traces=await frame.locator('body').evaluate(async(body,orientation)=>{
   const nodes=[0,1].map(i=>body.querySelector('[data-node$="/packet-'+i+'"]')),traces=[[],[]],started=performance.now();
   while(performance.now()-started<6200){nodes.forEach((node,i)=>{const rect=node.getBoundingClientRect();traces[i].push({at:performance.now()-started,position:orientation==='portrait'?rect.top:rect.left,opacity:Number(getComputedStyle(node).opacity)});});await new Promise(r=>setTimeout(r,40));}return traces;
  },orientation);
  for(const [packet,samples]of traces.entries()){
   const visible=samples.filter(s=>s.opacity>.1);assert(visible.length>20,'Packet never became visibly active');assert(samples.filter(s=>s.opacity<.02).length>4,'Reset has no invisible interval');
   assert(Math.max(...visible.map(s=>s.position))-Math.min(...visible.map(s=>s.position))>20,'Packet did not travel along its connector');
   for(let i=1;i<samples.length;i++)if(samples[i-1].opacity>.1&&samples[i].opacity>.1)assert(samples[i].position>=samples[i-1].position-.5,'Visible packet jumped backward at loop boundary');
   checks.push({orientation,packet,samples});
  }
 }
 await writeFile(out+'motion-proof.json',JSON.stringify({ok:true,checks},null,2));console.log('PASS: both packets in both orientations travel forward and reset invisibly across repeated cycles');
}finally{await browser.close();}
