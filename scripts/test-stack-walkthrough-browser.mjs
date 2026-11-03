import assert from 'node:assert/strict';
import{readFile,writeFile}from'node:fs/promises';
import{chromium}from'../tools/producer-mcp/node_modules/playwright-core/index.mjs';
const out='target/ai-engineering-cloudflare/',saved=JSON.parse(await readFile(out+'result.json','utf8')),doc=JSON.parse(await readFile(saved.path,'utf8'));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1100}}),checks=[];await page.goto('http://127.0.0.1:1436/scripts/scene3d/study-preview.html');
 await page.evaluate(async doc=>{
  const R=(await import('/node_modules/.vite/deps/react.js')).default,D=await import('/node_modules/.vite/deps/react-dom_client.js'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts'),{SetPreview}=await import('/src/features/presentation/SetPreview.tsx'),{SetControlsPanel}=await import('/src/features/presentation/SetControlsPanel.tsx');
  window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async cmd=>cmd==='set_library_list'?[]:1};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  window.session=new RehearsalSession(doc,undefined,'prepare');const root=(D.createRoot??D.default.createRoot)(document.getElementById('root'));
  window.paint=()=>root.render(R.createElement(SetPreview,{doc,state:window.session.snapshot()}));window.session.subscribe(window.paint);window.paint();
  const controls=document.createElement('aside');controls.style.cssText='position:fixed;right:0;top:0;width:460px;height:100vh;overflow:auto;background:#030B16';document.body.appendChild(controls);(D.createRoot??D.default.createRoot)(controls).render(R.createElement(SetControlsPanel,{session:window.session,onChange:()=>{}}));
 },doc);
 const labels=['Workers Static Assets','Workers','D1','R2','Workers AI','Access / WAF'];
 for(const orientation of ['landscape','portrait']){
  await page.evaluate(orientation=>{document.getElementById('root').style.width=orientation==='portrait'?'540px':'1080px';window.session.send({type:'control',action:{type:'layout.select',layoutId:'why-'+orientation}});window.paint();},orientation);
  for(const[i,label]of labels.entries()){
   await page.getByRole('button',{name:label,exact:true}).click();const frame=page.frameLocator('iframe'),description=frame.locator('[data-node$="/stack-description-'+i+'"]').last();await description.waitFor();await page.waitForTimeout(400);
   assert.equal(await frame.locator('[data-node*="/stack-description-"]').count(),1,'More than one explanation is shown');
   const geometry=await frame.locator('body').evaluate((body,i)=>{
    const description=body.querySelector('[data-node$="/stack-description-'+i+'"]'),cards=Array.from({length:6},(_,j)=>body.querySelector('[data-node="output/root/stack-'+j+'"]').getBoundingClientRect()),rect=description.getBoundingClientRect(),footer=body.querySelector('[data-node="output/root/footer-tool"]').getBoundingClientRect();return {fits:description.scrollHeight<=description.clientHeight+1,inside:rect.bottom<=cards[i].bottom+1,bottom:Math.max(...cards.map(r=>r.bottom)),footer:footer.top,cards:cards.map(r=>({top:r.top,bottom:r.bottom})),text:description.textContent};
   },i);
   assert(geometry.fits&&geometry.inside&&geometry.bottom<geometry.footer,JSON.stringify(geometry));if(orientation==='portrait')for(let j=1;j<6;j++)assert(geometry.cards[j].top>=geometry.cards[j-1].bottom,'Expanded rows overlap');
   await page.locator('#root').screenshot({path:out+'explain-'+orientation+'-'+i+'.png'});checks.push({orientation,label,...geometry});
  }
  await page.getByRole('button',{name:'Hide descriptions',exact:true}).click();await page.waitForTimeout(400);assert.equal(await page.frameLocator('iframe').locator('[data-node*="/stack-description-"]').count(),0);
 }
 await writeFile(out+'walkthrough-proof.json',JSON.stringify({ok:true,checks},null,2));console.log('PASS: six real product controls expand one fitting explanation in both orientations; hide collapses the rows');
}finally{await browser.close();}
