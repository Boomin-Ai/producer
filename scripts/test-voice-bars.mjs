import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {parsePackage} from './src/features/presentation/schema';export {outputProjection} from './src/features/presentation/projection';export {RehearsalSession} from './src/features/presentation/rehearsal';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {parsePackage,outputProjection,RehearsalSession}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const doc=parsePackage(JSON.parse(readFileSync('docs/shows/voice-studio.json','utf8')));
assert.equal(doc.show,undefined);assert.equal(doc.set.layouts.length,2);
for(const layout of doc.set.layouts){const session=new RehearsalSession(doc);session.send({type:'control',action:{type:'layout.select',layoutId:layout.id}});const projection=outputProjection(doc,session.snapshot());assert(projection.root.children.some(n=>n.shader?.effect==='voiceRing'));}
for(const mutate of [d=>d.set.layouts[0].root.children[0].shader.effect='microphoneScript',d=>d.set.layouts[0].root.children[0].shader.audioLevel=1,d=>d.set.layouts[0].root.children[0].shader.intensity=2.01,d=>d.set.layouts[0].root.children[0].shader.scale=5,d=>d.set.layouts[0].root.children[0].styles.width=3000,d=>d.set.layouts[0].root.styles.padding=1]){const invalid=structuredClone(doc);mutate(invalid);assert.throws(()=>parsePackage(invalid));}
const controlled=new RehearsalSession(doc);
for(const [key,value] of [['sensitivity',.25],['motion',0],['glow',1]])controlled.send({type:'field',key,value});
const resolved=outputProjection(doc,controlled.snapshot()).root.children.find(n=>n.shader)?.shader;
assert.equal(resolved.intensity,.25);assert.equal(resolved.speed,0);assert.equal(resolved.glow,1);assert.equal(resolved.bindings,undefined);
for(const binding of [{get:'values.title'},{get:'values.missing'},true]){const bad=structuredClone(doc);bad.set.layouts[0].root.children[0].shader.bindings.glow=binding;assert.throws(()=>parsePackage(bad));}
for(const glow of [-.01,1.01]){const bad=structuredClone(doc);bad.set.layouts[0].root.children[0].shader.glow=glow;assert.throws(()=>parsePackage(bad));}
console.log('PASS: voiceBars travels through package/projection; trusted preset, bounded controls and shader geometry remain enforced');
if(process.argv.includes('--schema-only'))process.exit(0);
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage();await page.setContent('<canvas id="voice"></canvas><canvas id="weather"></canvas><canvas id="ring"></canvas>');
 await page.addScriptTag({content:'const PRODUCER_SHADER_KERNEL='+JSON.stringify(readFileSync('src/features/presentation/shader-kernel.glsl','utf8'))+';'+readFileSync('src/features/presentation/shader-preview.js','utf8')});
 const result=await page.evaluate(()=>{
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia(){throw Error('Preview must not open microphones');}}});
  const canvas=document.querySelector('#voice'),config={effect:'voiceBars',colors:['#142b3d','#62e5d5','#c5b2ff'],speed:1,intensity:1,scale:1,opacity:1,radius:20,quality:'medium',clock:'show'};
  const preview=producerShaderPreview(canvas,config,720,180),gl=canvas.getContext('webgl');if(canvas.dataset.gpu!=='webgl')throw Error('WebGL unavailable');
  const pixels=(time,level,glow=0)=>{preview.draw(time);if(level!==undefined){const program=gl.getParameter(gl.CURRENT_PROGRAM);gl.uniform1f(gl.getUniformLocation(program,'audioLevel'),level);gl.uniform1f(gl.getUniformLocation(program,'glow'),glow);gl.drawArrays(gl.TRIANGLES,0,6);}const data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);let lit=0,hash=0,energy=0,premultiplied=true;for(let i=0;i<data.length;i+=4){energy+=data[i+3];if(data[i+3]>100)lit++;hash=Math.imul(hash,31)+data[i+3]|0;if(Math.max(data[i],data[i+1],data[i+2])>data[i+3]+1)premultiplied=false;}return {lit,hash,energy,premultiplied};};
  const silent=pixels(0,0),silentLater=pixels(2,0),loud=pixels(0,1),quiet=pixels(0,.1),simulated=pixels(.9),metadata={audio:canvas.dataset.audio,label:canvas.getAttribute('aria-label')};
  const weatherCanvas=document.querySelector('#weather'),weather=producerShaderPreview(weatherCanvas,{...config,effect:'rain'},720,180);weather.draw(.9);const weatherGl=weatherCanvas.getContext('webgl'),weatherAudio=weatherGl.getUniform(weatherGl.getParameter(weatherGl.CURRENT_PROGRAM),weatherGl.getUniformLocation(weatherGl.getParameter(weatherGl.CURRENT_PROGRAM),'audioLevel'));
  const ringCanvas=document.querySelector('#ring'),ring=producerShaderPreview(ringCanvas,{...config,effect:'voiceRing',radius:100,glow:.65},300,300),ringGl=ringCanvas.getContext('webgl');
  const ringPixels=(level)=>{ring.draw(0);const program=ringGl.getParameter(ringGl.CURRENT_PROGRAM);ringGl.uniform1f(ringGl.getUniformLocation(program,'audioLevel'),level);ringGl.drawArrays(ringGl.TRIANGLES,0,6);const data=new Uint8Array(300*300*4);ringGl.readPixels(0,0,300,300,ringGl.RGBA,ringGl.UNSIGNED_BYTE,data);let energy=0,interior=0,outer=0;const quadrants=[0,0,0,0];for(let y=0;y<300;y++)for(let x=0;x<300;x++){const a=data[(y*300+x)*4+3],r=Math.hypot(x-149.5,y-149.5);energy+=a;if(r<80)interior+=a;if(r>110){outer+=a;quadrants[(x>=150?1:0)+(y>=150?2:0)]+=a;}}return {energy,interior,outer,quadrants};};
  const ringSilent=ringPixels(0),ringLoud=ringPixels(1);
  const glowing=pixels(0,1,1),silentGlow=pixels(0,0,1);const result={silent,silentLater,loud,quiet,simulated,metadata,weatherAudio,glowing,silentGlow,ringSilent,ringLoud};preview.destroy();weather.destroy();return result;
 });
 assert.equal(result.ringLoud.interior,0,'camera interior stays transparent');assert.equal(result.ringSilent.outer,0,'idle border stays at camera edge');assert(result.ringLoud.energy>result.ringSilent.energy*2);assert(result.ringLoud.quadrants.every(v=>v>1000),'reactive border surrounds all sides');
 assert(result.glowing.energy>result.loud.energy,'glow adds analytic light around active bars');assert(result.glowing.premultiplied);assert.deepEqual(result.silentGlow,result.silent);assert.deepEqual(result.silent,result.silentLater,'silent native input must not animate fake speech');assert(result.loud.lit>result.quiet.lit*2);assert(result.quiet.lit>result.silent.lit);assert(result.loud.premultiplied);assert.notEqual(result.simulated.hash,result.silent.hash);assert.equal(result.metadata.audio,'simulated');assert.match(result.metadata.label,/simulated/);assert.equal(result.weatherAudio,0);
 console.log('PASS: shared GPU kernel is audio-responsive, silent baseline stable, premultiplied, bounded, preview explicitly simulated, weather unaffected; ring surrounds camera with transparent center');
}finally{await browser.close();}
