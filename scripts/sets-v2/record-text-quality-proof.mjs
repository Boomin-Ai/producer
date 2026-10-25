import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [out,app]=process.argv.slice(2);
const report=JSON.parse(fs.readFileSync(path.join(out,'text-quality.json'),'utf8'));
if(report.variants.length!==6)throw Error('Expected two interleaved trials per density');
for(const d of [1,1.5,2]){
 const rows=report.variants.filter(v=>v.density===d);
 if(rows.length!==2||rows.some(v=>v.outputWidth!==1920||v.outputHeight!==1080||v.browserWidth!==1760*d||v.browserHeight!==800*d+1||v.renderAndReadbackSamplesMs.length!==25||v.renderAndReadbackSamplesMs.some(t=>!Number.isFinite(t)||t<=0)))throw Error('Incomplete native text experiment');
 for(const detail of ['', '-detail']){
  const b=fs.readFileSync(path.join(out,`text-1080p-${d}x${detail}.png`));
  if(b.readUInt32BE(16)!==(detail?840:1920)||b.readUInt32BE(20)!==(detail?650:1080))throw Error('Unexpected output dimensions');
 }
}
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources=['src-tauri/src/live/sets_v2/contract.rs','src-tauri/src/live/sets_v2/group.c','src-tauri/src/live/sets_v2/scene.c','src-tauri/src/live/sets_v2/mod.rs','scripts/sets-v2/native-probe.m','scripts/sets-v2/rust-probe/src/lib.rs','scripts/sets-v2/make-text-quality-plans.mjs','scripts/sets-v2/run-native-probe.sh','scripts/sets-v2/record-text-quality-proof.mjs'];
const metadata={status:'passed',recordedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,sources:Object.fromEntries(sources.map(f=>[f,sha(f)])),runtimeSha256:sha(path.join(app,'Contents/Frameworks/libobs.framework/libobs')),artifacts:Object.fromEntries(fs.readdirSync(out).filter(f=>/\.(json|png)$/.test(f)&&f!=='text-quality-run.json').map(f=>[f,sha(path.join(out,f))])),limitations:['Text-only prototype injected as an authorized native source; not a production quality setting','Render+allocation+RGBA readback timing is not frame time or GPU-only timing','Requested RGBA byte counts exclude CEF/driver buffers and total process memory','Static Arial fixture on Apple Silicon/Metal; no encoder or audience playback comparison']};
fs.writeFileSync(path.join(out,'text-quality-run.json'),JSON.stringify(metadata,null,2)+'\n');
console.log('Recorded source-hashed 1080p typography experiment');
