import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {parsePackage} from './src/features/presentation/schema';export {outputProjection} from './src/features/presentation/projection';export {RehearsalSession} from './src/features/presentation/rehearsal';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {parsePackage,outputProjection,RehearsalSession}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const doc=parsePackage(JSON.parse(readFileSync('docs/shows/voice-studio.json','utf8')));
assert.equal(doc.show,undefined);assert.equal(doc.set.layouts.length,2);
for(const layout of doc.set.layouts){const session=new RehearsalSession(doc);session.send({type:'control',action:{type:'layout.select',layoutId:layout.id}});const projection=outputProjection(doc,session.snapshot());assert(projection.root.children.some(n=>n.shader?.effect==='voiceBars'));}
for(const mutate of [d=>d.set.layouts[0].root.children[0].shader.effect='microphoneScript',d=>d.set.layouts[0].root.children[0].shader.audioLevel=1,d=>d.set.layouts[0].root.children[0].shader.intensity=2.01,d=>d.set.layouts[0].root.children[0].shader.scale=5,d=>d.set.layouts[0].root.children[0].styles.width=3000,d=>d.set.layouts[0].root.styles.padding=1]){const invalid=structuredClone(doc);mutate(invalid);assert.throws(()=>parsePackage(invalid));}
console.log('PASS: voiceBars travels through package/projection; trusted preset, bounded controls and shader geometry remain enforced');
if(process.argv.includes('--schema-only'))process.exit(0);
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage();await page.setContent('<canvas id="voice"></canvas><canvas id="weather"></canvas>');
 await page.addScriptTag({content:'const PRODUCER_SHADER_KERNEL='+JSON.stringify(readFileSync('src/features/presentation/shader-kernel.glsl','utf8'))+';'+readFileSync('src/features/presentation/shader-preview.js','utf8')});
 const result=await page.evaluate(()=>{
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia(){throw Error('Preview must not open microphones');}}});
  const canvas=document.querySelector('#voice'),config={effect:'voiceBars',colors:['#142b3d','#62e5d5','#c5b2ff'],speed:1,intensity:1,scale:1,opacity:1,radius:20,quality:'medium',clock:'show'};
  const preview=producerShaderPreview(canvas,config,720,180),gl=canvas.getContext('webgl');if(canvas.dataset.gpu!=='webgl')throw Error('WebGL unavailable');
  const pixels=(time,level)=>{preview.draw(time);if(level!==undefined){const program=gl.getParameter(gl.CURRENT_PROGRAM);gl.uniform1f(gl.getUniformLocation(program,'audioLevel'),level);gl.drawArrays(gl.TRIANGLES,0,6);}const data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);let lit=0,hash=0,premultiplied=true;for(let i=0;i<data.length;i+=4){if(data[i+3]>100)lit++;hash=Math.imul(hash,31)+data[i+3]|0;if(Math.max(data[i],data[i+1],data[i+2])>data[i+3]+1)premultiplied=false;}return {lit,hash,premultiplied};};
  const silent=pixels(0,0),silentLater=pixels(2,0),loud=pixels(0,1),quiet=pixels(0,.1),simulated=pixels(.9),metadata={audio:canvas.dataset.audio,label:canvas.getAttribute('aria-label')};
  const weatherCanvas=document.querySelector('#weather'),weather=producerShaderPreview(weatherCanvas,{...config,effect:'rain'},720,180);weather.draw(.9);const weatherGl=weatherCanvas.getContext('webgl'),weatherAudio=weatherGl.getUniform(weatherGl.getParameter(weatherGl.CURRENT_PROGRAM),weatherGl.getUniformLocation(weatherGl.getParameter(weatherGl.CURRENT_PROGRAM),'audioLevel'));
  const result={silent,silentLater,loud,quiet,simulated,metadata,weatherAudio};preview.destroy();weather.destroy();return result;
 });
 assert.deepEqual(result.silent,result.silentLater,'silent native input must not animate fake speech');assert(result.loud.lit>result.quiet.lit*2);assert(result.quiet.lit>result.silent.lit);assert(result.loud.premultiplied);assert.notEqual(result.simulated.hash,result.silent.hash);assert.equal(result.metadata.audio,'simulated');assert.match(result.metadata.label,/simulated/);assert.equal(result.weatherAudio,0);
 console.log('PASS: shared GPU kernel is audio-responsive, silent baseline stable, premultiplied, bounded, preview explicitly simulated, weather unaffected');
}finally{await browser.close();}
