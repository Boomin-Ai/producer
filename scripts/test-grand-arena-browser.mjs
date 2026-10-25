import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const out='/private/tmp/producer-grand-arena';fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(out,'plans'),{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1100}});await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts'),{outputProjection}=await import('/src/features/presentation/projection.ts'),{compileRoomScene}=await import('/src/features/sets-v2/roomCompiler.ts'),{layoutProjections,morphTargets}=await import('/src/features/sets-v2/preparedScenes.ts');
  const doc=await(await fetch('/docs/shows/head-to-head-grand-arena.json')).json();window.doc=doc;window.Session=RehearsalSession;window.projection=outputProjection;window.compile=compileRoomScene;window.session=new RehearsalSession(doc,undefined,'prepare');window.inventory=layoutProjections(window.session);window.targets=morphTargets;
 });
 for(const id of await page.evaluate(()=>window.doc.set.layouts.map(l=>l.id))){
  const result=await page.evaluate(async id=>{
   const item=window.inventory.find(p=>p.layout===id),p=item.projection,targets=window.targets(window.inventory.map(i=>i.projection),p);
   const plan=await window.compile(p,{definitionId:window.doc.id,instanceId:'showcase-proof',canvasId:id,target:{id:p.width>p.height?'program':'portrait',orientation:p.width>p.height?'landscape':'portrait',width:p.width,height:p.height,scaling:'contain'},bindings:{host:'synthetic-camera',guest:'synthetic-camera',evidence:'synthetic-camera'},retainedTargets:targets});
   const issues=[];let count=0;const walk=n=>{count++;if(n.bounds.width<=0||n.bounds.height<=0)issues.push(n.id);n.children.forEach(walk);};walk(plan.root);
   return {plan,count,issues,targets:targets.length};
  },id);
  assert.deepEqual(result.issues,[]);assert.ok(result.count<=128);fs.writeFileSync(path.join(out,'plans',id+'.json'),JSON.stringify(result.plan));console.log('PASS compile',id,'nodes',result.count,'motion targets',result.targets);
 }
 for(const phase of ['host-case','receipts'])for(const at of [0,325,650]){
  const plan=await page.evaluate(async ({at,phase})=>{
   const s=new window.Session(window.doc,undefined,'prepare');s.enterLive();s.send({type:'control',action:{type:'show.start'}});while(s.snapshot().show.phase!==phase)s.send({type:'control',action:{type:'show.next'}});
   const p=window.projection(s.package,s.snapshot());p.timeline.clock={running:false,positionMs:at,segmentMs:at,anchorMs:Date.now()};
   return window.compile(p,{definitionId:window.doc.id,instanceId:'motion-proof',canvasId:phase+'-landscape',target:{id:'program',orientation:'landscape',width:1920,height:1080,scaling:'contain'},bindings:{host:'synthetic-camera',guest:'synthetic-camera'},retainedTargets:window.targets(window.inventory.map(i=>i.projection),p)});
  },{at,phase});
  fs.writeFileSync(path.join(out,'plans',`motion-${phase}-${at}.json`),JSON.stringify(plan));
 }
 const transitions=await page.evaluate(()=>{
  const s=new window.Session(window.doc,undefined,'prepare');s.enterRehearsal();s.send({type:'control',action:{type:'show.start'}});const rows=[];
  for(let i=0;i<4;i++){s.send({type:'control',action:{type:'show.next'}});const p=window.projection(s.package,s.snapshot());rows.push({phase:s.snapshot().show.phase,tracks:p.timeline.tracks.length,rigs:p.timeline.tracks.filter(t=>t.target.endsWith('/host-rig')||t.target.endsWith('/guest-rig')).length});}
  s.send({type:'segment.select',phaseId:'crowd-call'});s.send({type:'pause',paused:false});s.send({type:'vote',playerId:'one',choiceId:'blue'});s.send({type:'tick',milliseconds:45000});s.send({type:'control',action:{type:'show.reveal'}});s.send({type:'control',action:{type:'show.next'}});
  const result=window.projection(s.package,s.snapshot());const texts=[];const visit=n=>{if(n.text)texts.push(n.text);n.children.forEach(visit);};visit(result.root);return {rows,texts,revealed:s.snapshot().show.revealed};
 });
 assert.equal(transitions.revealed,true);assert.ok(transitions.texts.includes('Kleveland'));assert.ok(transitions.texts.includes('1 CONFIRMED VOTES'));assert.ok(transitions.rows.every(r=>r.tracks<=32));assert.ok(transitions.rows.slice(0,3).every(r=>r.rigs>0));assert.ok(transitions.rows.find(r=>r.phase==='receipts').tracks<16);console.log('PASS native rig transitions',transitions.rows);
 // Real SetPreview iframe, with clearly labelled synthetic source thumbnails.
 await page.evaluate(async()=>{
  const callbacks=new Map();let serial=0;window.__TAURI_INTERNALS__={transformCallback:cb=>{callbacks.set(++serial,cb);return serial;},invoke:async(cmd,args)=>{if(cmd==='plugin:event|listen'){window.emit=payload=>callbacks.get(args.handler)({payload});return 1;}}};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
  const M=await import('/node_modules/.vite/deps/react.js'),R=M.default??M,D=await import('/node_modules/.vite/deps/react-dom_client.js'),{SetPreview}=await import('/src/features/presentation/SetPreview.tsx');
  const host=document.createElement('div');host.style.width='1440px';document.body.replaceChildren(host);window.root=(D.createRoot??D.default.createRoot)(host);
  window.preview=id=>{const l=window.doc.set.layouts.find(l=>l.id===id);host.style.width=l.width>l.height?'1440px':'540px';const state={...window.session.snapshot(),layoutId:id};window.root.render(R.createElement(SetPreview,{doc:window.doc,state,output:{bindings:{host:'host-test',guest:'guest-test',evidence:'evidence-test'},framing:{},sources:{items:[{id:'host-test',src_w:960,src_h:540},{id:'guest-test',src_w:960,src_h:540},{id:'evidence-test',src_w:960,src_h:540}]}}}));};window.preview('faceoff-landscape');
  window.sendFrames=()=>{const frames=[['host-test','#1d5175','HOST / SOURCE PREVIEW'],['guest-test','#775329','CHALLENGER / SOURCE PREVIEW'],['evidence-test','#304154','EVIDENCE / SOURCE PREVIEW']].map(([id,color,label])=>{const c=document.createElement('canvas');c.width=960;c.height=540;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,960,540);x.fillStyle='#e8edf1';x.font='bold 34px Arial';x.textAlign='center';x.fillText(label,480,280);return{id,jpeg:c.toDataURL('image/jpeg').split(',')[1]};});window.emit?.({type:'guest_thumbs',thumbs:frames});};
 });
 for(const id of ['faceoff-landscape','host-case-landscape','receipts-landscape','verdict-landscape','faceoff-portrait','host-case-portrait']){
  await page.evaluate(id=>window.preview(id),id);await page.frameLocator('iframe').locator('[data-slot="host"]').waitFor();await page.waitForTimeout(600);await page.evaluate(()=>window.sendFrames());await page.waitForTimeout(500);await page.locator('.set-preview').screenshot({path:path.join(out,id+'-preview.png')});
 }
 console.log('PASS: authored artwork and native-camera preview screenshots',out);
}finally{await browser.close();}
