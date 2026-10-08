import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';
const result=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';export {outputProjection} from './src/features/presentation/projection';export {sampleTrack} from './src/features/presentation/animation';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {RehearsalSession,outputProjection,sampleTrack}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const doc=JSON.parse(fs.readFileSync('docs/shows/ai-signal.show.json'));
const original=Date.now;let now=10000;Date.now=()=>now;
try{
 const s=new RehearsalSession(doc);s.send({type:'control',action:{type:'show.start'}});
 const select=mode=>assert.equal(s.send({type:'control',action:{type:'layout.select',layoutId:`ai-${mode}-portrait`}}),true);
 const projection=()=>outputProjection(s.package,s.snapshot());
 const track=(p,id,property)=>p.timeline.tracks.find(t=>t.target.endsWith('/'+id)&&t.property===property);
 select('intro');const outward=projection();assert.equal(sampleTrack(track(outward,'host-camera','width'),0),856);assert.equal(sampleTrack(track(outward,'host-camera','width'),1100),480);
 now+=400;const midway=sampleTrack(track(outward,'host-camera','width'),400);select('react');const reversed=projection();assert.equal(sampleTrack(track(reversed,'host-camera','width'),0),midway);assert.equal(sampleTrack(track(reversed,'host-camera','width'),1100),856);
 for(const time of [0,200,550,1100]){const camera=sampleTrack(track(reversed,'host-camera','width'),time),rim=sampleTrack(track(reversed,'camera-rim','width'),time),halo=sampleTrack(track(reversed,'camera-halo','width'),time);assert.ok(Math.abs(rim-camera-6)<1e-8);assert.ok(Math.abs(halo-camera-32)<1e-8);}

 // Check every edge throughout forward and reversed motion, not only endpoints.
 for(const projection of [outward,reversed]){
  const nodes=new Map();const visit=n=>{nodes.set(n.id.split('/').pop(),n);n.children.forEach(visit)};visit(projection.root);
  const value=(id,property,time)=>{const t=track(projection,id,property);return t?sampleTrack(t,time):nodes.get(id).styles[({x:'left',y:'top'})[property]??property]};
  for(let time=0;time<=1100;time+=25)for(const [inside,frame]of [['host-camera','camera-rim'],['reaction-content','media-rim']]){
   for(const [property,offset]of [['x',-3],['y',-3],['width',6],['height',6]])assert.ok(Math.abs(value(frame,property,time)-value(inside,property,time)-offset)<1e-7,`${inside} ${property} detached at ${time}`);
  }
 }
 now+=250;s.send({type:'pause',paused:true});const held=s.snapshot().animationClock.segmentMs;now+=5000;assert.equal(s.snapshot().animationClock.segmentMs,held);s.send({type:'pause',paused:false});assert.equal(s.snapshot().animationClock.segmentMs,held);
 const alternate=outputProjection(s.package,{...s.snapshot(),layoutId:'ai-take-portrait'});assert.equal(alternate.timeline.tracks.some(t=>t.property==='width'),false,'other layout previews must not inherit active motion');
 assert.ok(projection().timeline.tracks.length<=32);assert.equal(s.snapshot().show.phase,'reaction');assert.equal(s.exportPreparedPackage().set.layouts.some(l=>l.animation.tracks.some(t=>t.target.includes('/'))),false);
 s.send({type:'reset'});assert.equal(s.snapshot().layoutMotion,undefined);assert.equal(s.snapshot().layoutId,'ai-react-portrait');
 console.log('PASS layout movement, interrupted reversal, synchronized camera rim/halo, pause/resume, track budget, one segment and clean exports.');
}finally{Date.now=original;}
