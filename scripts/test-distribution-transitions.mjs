import fs from 'node:fs';
import assert from 'node:assert/strict';
import {loadRuntime} from './presentation-proof/runtime.mjs';
const {RehearsalSession,outputProjection}=await loadRuntime();
const doc=JSON.parse(fs.readFileSync('docs/shows/own-your-distribution.show.json'));
const layouts=doc.set.layouts.filter(l=>l.id.startsWith('diagram-'));
for(const from of layouts)for(const to of layouts){
 if(from===to)continue;
 const session=new RehearsalSession(doc);
 assert(session.send({type:'control',action:{type:'show.start'}}));
 assert(session.send({type:'control',action:{type:'show.next'}}));
 assert(session.send({type:'control',action:{type:'layout.select',layoutId:from.id}}));
 session.send({type:'tick',milliseconds:2500});
 assert(session.send({type:'control',action:{type:'layout.select',layoutId:to.id}}),`${from.id} → ${to.id}`);
 const out=outputProjection(session.package,session.snapshot());
 assert.equal(session.snapshot().layoutId,to.id);
 assert(out.timeline.tracks.length<=32,`${from.id} → ${to.id} exceeds native limit`);
}
console.log('PASS all 12 completed diagram transitions stay within the native track limit.');
