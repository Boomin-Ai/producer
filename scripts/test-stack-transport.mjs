import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';
const built=await build({stdin:{contents:"export {RehearsalSession,evaluate} from './src/features/presentation/rehearsal';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {RehearsalSession,evaluate}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const folder='/Users/klevelandbishop/Documents/boomin/docs/shows/';
const combo=new RehearsalSession(JSON.parse(fs.readFileSync(folder+'shader-combo.show.json')),undefined,'rehearsal');
const send=(s,type)=>s.send({type:'control',action:{type}});
assert.ok(send(combo,'show.start'));assert.equal(send(combo,'show.previous'),false);
assert.ok(send(combo,'show.next'));assert.ok(send(combo,'show.previous'));assert.equal(combo.snapshot().show.phase,'liquid');assert.equal(combo.snapshot().animationClock.segmentMs,0);
assert.ok(combo.send({type:'stop'}));assert.ok(send(combo,'show.start'));assert.equal(combo.snapshot().show.phase,'liquid');
const doc=JSON.parse(fs.readFileSync(folder+'ai-stack.show.json'));assert.equal(doc.show.phases.length,1);
const s=new RehearsalSession(doc,undefined,'rehearsal');assert.ok(send(s,'show.start'));
for(let i=0;i<4;i++){const controls=doc.set.controls.filter(c=>evaluate(c.when,s.snapshot()));assert.equal(controls.length,2);assert.ok(s.send({type:'control',action:controls.find(c=>c.label.startsWith('↓')).action}));assert.equal(s.snapshot().show.phase,'stack');}
assert.equal(s.snapshot().layoutId,'stack-4-landscape');
for(let i=0;i<4;i++){const c=doc.set.controls.find(c=>c.label.startsWith('↑')&&evaluate(c.when,s.snapshot()));assert.ok(s.send({type:'control',action:c.action}));}
assert.equal(s.snapshot().layoutId,'stack-0-landscape');
console.log('PASS previous boundaries, navigation clock reset, stop/restart, single-segment stack up/down');
