import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import plan from '../tools/producer-mcp/fixtures/classic.mjs';
process.on('uncaughtException',error=>{console.error(error.message.slice(0,1800));process.exit(1);});
const bundle=await build({stdin:{resolveDir:process.cwd(),contents:`export * from './src/features/presentation/schema';export * from './src/features/presentation/rehearsal';export * from './src/features/presentation/projection';export * from './src/features/presentation/layoutViews';`},bundle:true,platform:'node',format:'esm',write:false});
const {parsePackage,RehearsalSession,outputProjection,evaluate,layoutViews}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const doc=parsePackage(JSON.parse(readFileSync('docs/shows/classic.json','utf8')));
assert.deepEqual(parsePackage({...plan.package,set:{...plan.package.set,assets:{}}}),doc,'gallery package is the MCP-compiled authoring source');
assert.equal(doc.show,undefined);assert.equal(doc.runtime.instances.length,0);assert.equal(doc.set.slots.length,7);assert(doc.set.controls.length<=40);
assert.equal(layoutViews(doc.set).length,8);assert.equal(doc.set.layouts.length,16);
assert.equal(doc.set.operatorComponents[0].type,'music');
assert.equal(doc.set.controlArrangement.cameraBackground,false);
assert.equal(doc.set.controlArrangement.sections[1].label,'Layout controls');
assert.equal(doc.set.controlArrangement.sections[1].id,'view');
for(const type of ['shopify','javascript']){const bad=structuredClone(doc);bad.set.operatorComponents[0].type=type;assert.throws(()=>parsePackage(bad));}
{const bad=structuredClone(doc);bad.set.operatorComponents[0].when={get:'values.showTitle'};assert.throws(()=>parsePackage(bad),/boolean/);}
for(const view of layoutViews(doc.set)){
 assert.deepEqual(Object.keys(view.variants).sort(),['landscape','portrait']);
 for(const [format,id] of Object.entries(view.variants)){
  const l=doc.set.layouts.find(l=>l.id===id);assert.equal(l.width,format==='landscape'?1920:1080);assert.equal(l.height,format==='landscape'?1080:1920);
 }
}
const session=new RehearsalSession(doc,undefined,'prepare');
const field=(key,value)=>assert(session.send({type:'field',key,value}));
const select=id=>assert(session.send({type:'control',action:{type:'layout.select',layoutId:id}}));
const find=(node,id)=>node.id.endsWith('/'+id)?node:node.children.flatMap(n=>find(n,id)??[])[0];
let projections=0;
for(const theme of ['dark','light'])for(const l of doc.set.layouts){
 field('theme',theme);select(l.id);
 for(const cue of ['none','name','note','cta'])for(const chat of [false,true])for(const guests of [1,2,3]){
  field('cue',cue);field('chatVisible',chat);field('guestCount',guests);
  const p=outputProjection(doc,session.snapshot());assert.equal(p.width,l.width);assert.equal(p.height,l.height);
  assert.equal(find(p.root,'cue-panel')!==undefined,cue!=='none');
  for(const id of ['name','note','cta','clear-cue'])assert.equal(doc.set.controls.find(c=>c.id===id).when,undefined,'cue buttons never replace each other');
  assert.equal(evaluate(doc.set.controls.find(c=>c.id==='clear-cue').enabled,session.snapshot()),cue!=='none');
  const backdrop=find(p.root,'cue-backdrop');assert.equal(!!backdrop,cue!=='none');
  if(backdrop){assert.equal(backdrop.styles.width,l.width);assert.equal(backdrop.styles.height,l.height);const card=find(p.root,'cue-panel');assert.equal(card.styles.left*2+card.styles.width,l.width);assert.equal(card.styles.top*2+card.styles.height,l.height);}
  const chrome=find(p.root,'classic-frame-'+(l.width>l.height?'landscape':'portrait'));
  assert.equal(chrome.scene3d.world.dj.role,'frame');assert.equal(chrome.scene3d.world.objects.length,4);
  assert.equal(chrome.scene3d.music.color,theme==='light'?'#147b61':'#9cdbc7');
  assert.equal(evaluate(doc.set.operatorComponents[0].when,session.snapshot()),/^(opening|break)-/.test(l.id));
  for(const control of doc.set.controls)if(control.when!==undefined)assert.equal(typeof evaluate(control.when,session.snapshot()),'boolean');
  if(l.id.startsWith('roundtable-')){
   assert.equal(find(p.root,'guest2')!==undefined,guests>=2);assert.equal(find(p.root,'guest3')!==undefined,guests===3);
  }
  projections++;
 }
}
for(const format of ['landscape','portrait']){
 select('demo-'+format);field('cue','none');field('demoLive',true);field('screenZoom',2);
 let p=outputProjection(doc,session.snapshot());assert.equal(find(p.root,'content-framing').styles.transform,'scale(2)');assert(find(p.root,'content'));
 field('hostVisible',false);p=outputProjection(doc,session.snapshot());assert(!find(p.root,'host'));assert.equal(find(p.root,'content-clip').styles[format==='landscape'?'width':'height'],format==='landscape'?1792:1430);
 field('demoLive',false);p=outputProjection(doc,session.snapshot());assert(find(p.root,'example-full'));assert(!find(p.root,'content'));
 select('solo-'+format);field('chatVisible',false);const full=find(outputProjection(doc,session.snapshot()).root,'host');field('chatVisible',true);const shared=find(outputProjection(doc,session.snapshot()).root,'host');assert(full.styles[format==='landscape'?'width':'height']>shared.styles[format==='landscape'?'width':'height']);
}
field('showTitle','My saved Classic');field('theme','light');const exported=session.exportPreparedPackage(),restored=new RehearsalSession(exported,undefined,'prepare');assert.equal(restored.snapshot().values.showTitle,'My saved Classic');assert.equal(restored.snapshot().values.theme,'light');
// Standalone layout context must not accidentally grant access to Show state.
for(const key of ['phase','remainingMs','winner','notAField']){
 const bad=structuredClone(doc);bad.set.controls[0].when={op:'eq',args:[{get:'show.'+key},'x']};assert.throws(()=>parsePackage(bad),/Unknown binding/);
}
console.log(`PASS Classic: 8 paired views, ${projections} theme/cue/chat/guest projections, source reflow, zoom, saved values and strict Show boundary.`);
