import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createRoadToV1} from './create-road-to-v1.mjs';

process.on('uncaughtException',error=>{console.error(error.message);process.exit(1);});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bundle=await build({stdin:{contents:"export {parsePackage} from './src/features/presentation/schema';export {RehearsalSession} from './src/features/presentation/rehearsal';export {outputProjection} from './src/features/presentation/projection';",resolveDir:root},bundle:true,platform:'node',format:'esm',write:false});
const {parsePackage,RehearsalSession,outputProjection}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const json=fs.readFileSync(path.join(root,'docs/shows/road-to-v1.json'),'utf8'),doc=parsePackage(JSON.parse(json));
assert.equal(doc.id,'road-to-v1');assert.equal(doc.show,undefined);assert.equal(doc.set.layouts.length,6);
assert.deepEqual(doc.set.layouts.map(l=>l.id),['live-landscape','live-portrait','title-landscape','title-portrait','sea-landscape','sea-portrait']);
assert.equal(doc.set.slots.length,0);
assert(Buffer.byteLength(json)<40*1024*1024);
for(const [id,asset]of Object.entries(doc.set.assets)){
  assert(['image/png','image/jpeg'].includes(asset.mime));assert(asset.data.startsWith(`data:${asset.mime};base64,`));
  const bytes=Buffer.from(asset.data.split(',')[1],'base64');assert(bytes.length<=12*1024*1024);
  assert(bytes.equals(fs.readFileSync(path.join(root,`docs/shows/media/${asset.name}`))),'Background embeds the exact supplied clean plate');
}
assert(!json.includes('producer-media:'));assert(!/https?:\/\//.test(json));
const flatten=node=>[node,...node.children.flatMap(flatten)];
const session=new RehearsalSession(doc,undefined,'rehearsal');
for(const layout of doc.set.layouts){
  const portrait=layout.id.endsWith('portrait'),live=!layout.id.startsWith('title');
  assert.equal(layout.width,portrait?1080:1920);assert.equal(layout.height,portrait?1920:1080);
  session.send({type:'control',action:{type:'layout.select',layoutId:layout.id}});
  const projection=outputProjection(doc,session.snapshot()),nodes=flatten(projection.root),host=nodes.find(n=>n.slotId==='host'),shader=nodes.find(n=>n.shader?.effect==='launchV1'),plate=nodes.find(n=>n.assetId);
  assert.equal(host,undefined,'Camera removed from every layout');assert(!nodes.some(n=>n.type==='slot'));assert.equal(shader.shader.effect,'launchV1');assert.equal(plate.fit,layout.id.startsWith('sea')?'contain':'cover');assert(nodes.indexOf(plate)<nodes.indexOf(shader));
  const title=nodes.find(n=>n.assetId==='title');assert(title,'Title remains an independent editable layer');assert.equal(title.styles.left+title.styles.width/2,shader.styles.left+shader.styles.width/2,'V1 and Road To share a centerline');
  const captions=nodes.find(n=>n.id.endsWith('/live-captions'));assert(captions);assert.equal(captions.styles.textTransform,'uppercase');assert(captions.styles.fontFamily.includes('Impact'));if(portrait){assert(captions.styles.top>=shader.styles.top+shader.styles.height);}else{assert(captions.styles.left>shader.styles.left+shader.styles.width);assert(captions.styles.height>=500);assert(shader.styles.left+shader.styles.width/2<layout.width/2);}
  assert.equal(layout.animation.transition.contentDurationMs,0,'caption updates do not fade');assert(!nodes.some(n=>n.id.endsWith('/caption-accent')));const panel=nodes.find(n=>n.id.endsWith('/caption-panel-inner'));assert.equal(panel.styles.background,'#0b0b0c');assert(nodes.some(n=>n.assetId==='host'),'Static face portrait is embedded');
  assert.equal(shader.shader.intensity,live?1.25:0);
  session.send({type:'field',key:'sensitivity',value:1.7});session.send({type:'field',key:'motion',value:1.4});session.send({type:'field',key:'glow',value:.3});
  const changed=flatten(outputProjection(doc,session.snapshot()).root).find(n=>n.shader?.effect==='launchV1').shader;
  assert.equal(changed.intensity,live?1.7:0);assert.equal(changed.speed,live?1.4:0);assert.equal(changed.glow,.3);
  session.send({type:'field',key:'sensitivity',value:1.25});session.send({type:'field',key:'motion',value:.55});session.send({type:'field',key:'glow',value:.7});
}
assert.deepEqual(doc.set.controls.filter(c=>c.type==='button').map(c=>c.action.layoutId),doc.set.layouts.map(l=>l.id));
assert.deepEqual(await createRoadToV1({output:null}),doc,'Regeneration is reproducible');
await assert.rejects(createRoadToV1({landscape:path.join(root,'missing-road-cleanplate.png'),output:null}),/background is missing/);
console.log('PASS: Road To V1 six layouts, embedded assets, no camera, live/static controls and reproducible generation');
