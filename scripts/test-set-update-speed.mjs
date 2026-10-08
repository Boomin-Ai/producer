import fs from 'node:fs';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {loadRuntime} from './presentation-proof/runtime.mjs';
const bundled=await build({stdin:{contents:"export {AssetTransport} from './src/features/presentation/assetTransport';export {nextSetProjection,setOutputProjection} from './src/features/presentation/useSetOutput';",resolveDir:process.cwd()},bundle:true,platform:'browser',format:'esm',write:false});
const {AssetTransport,nextSetProjection,setOutputProjection}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const {parsePackage,RehearsalSession,outputProjection}=await loadRuntime();
const doc=parsePackage(JSON.parse(fs.readFileSync('/Users/klevelandbishop/Documents/boomin/docs/shows/claude-code-media-walkthrough.json')));
const session=new RehearsalSession(doc,undefined,'prepare'),cache=new AssetTransport();
const project=(id,revision)=>({...outputProjection(doc,{...session.snapshot(),layoutId:id}),revision});
const heavy=project('review-landscape',1),coldBytes=JSON.stringify(heavy).length;
assert.ok(Object.keys(cache.compact(heavy).assets).length>0);cache.acknowledge(heavy);
const warmBytes=JSON.stringify(cache.compact({...heavy,revision:2})).length;assert.equal(Object.keys(cache.compact(heavy).assets).length,0);assert.ok(warmBytes<coldBytes/100);
assert.ok(JSON.stringify(cache.signature(heavy)).length<15000);
const renamed=structuredClone(heavy);renamed.assets.review.name='Renamed';assert.ok(cache.compact(renamed).assets.review);
cache.clear();assert.ok(cache.compact(heavy).assets.review);
const show=new RehearsalSession(doc);show.send({type:'control',action:{type:'show.start'}});
const graphics=p=>{const copy=structuredClone(p.root);const strip=n=>{delete n.playback;delete n.autoplay;n.children.forEach(strip);};strip(copy);return copy;};
for(let step=0;step<doc.show.phases.length-1;step++){
 const next=nextSetProjection(show);assert.ok(next);
 const paused=n=>{if(n.playback)assert.equal(n.playback.playing,false,'preloaded media must not start early');n.children.forEach(paused);};paused(next.root);
 show.send({type:'control',action:{type:'show.next'}});assert.deepEqual(graphics(next),graphics(setOutputProjection(show,0)),'predicted segment graphics must match real entry');
}
const dir='/private/tmp/producer-set-speed';fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(dir+'/speed-check','');
fs.writeFileSync(dir+'/projections.json',JSON.stringify([setOutputProjection(session,1,'brief-landscape'),setOutputProjection(session,6,'hero-landscape'),setOutputProjection(session,7,'review-landscape')]));
fs.writeFileSync(dir+'/portraits.json',JSON.stringify([setOutputProjection(session,1,'brief-portrait'),setOutputProjection(session,3,'hero-portrait')]));
fs.writeFileSync(dir+'/payload-sizes.json',JSON.stringify({coldBytes,warmBytes,reduction:Math.round(coldBytes/warmBytes)}));
console.log(JSON.stringify({pass:true,coldBytes,warmBytes,reduction:Math.round(coldBytes/warmBytes),nativeProbeDirectory:dir}));
