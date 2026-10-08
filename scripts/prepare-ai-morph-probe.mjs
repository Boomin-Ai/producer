import fs from 'node:fs';
import {build} from 'esbuild';
const dir=process.argv[2];if(!dir)throw Error('Supply a temporary probe directory.');fs.mkdirSync(dir,{recursive:true});
const result=await build({stdin:{contents:"export {RehearsalSession} from './src/features/presentation/rehearsal';export {outputProjection} from './src/features/presentation/projection';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {RehearsalSession,outputProjection}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const original=Date.now;let now=10000;Date.now=()=>now;
try{
 const s=new RehearsalSession(JSON.parse(fs.readFileSync('docs/shows/ai-signal.show.json')));s.send({type:'control',action:{type:'show.start'}});const projections=[];
 const add=(segment=0)=>{const p=outputProjection(s.package,s.snapshot());p.timeline.clock={running:false,positionMs:segment,segmentMs:segment,anchorMs:10000};projections.push(p);};add();s.send({type:'control',action:{type:'layout.select',layoutId:'ai-intro-portrait'}});add();add(550);now+=550;s.send({type:'control',action:{type:'layout.select',layoutId:'ai-react-portrait'}});add();add(550);add(1100);
 fs.writeFileSync(dir+'/projections.json',JSON.stringify(projections));fs.writeFileSync(dir+'/morph-check','');console.log(dir);
}finally{Date.now=original;}
