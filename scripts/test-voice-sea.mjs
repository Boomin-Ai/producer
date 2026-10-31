import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'../target/browser-check/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage();await page.setContent('<canvas></canvas>');await page.addScriptTag({content:'const PRODUCER_SHADER_KERNEL='+JSON.stringify(readFileSync('src/features/presentation/shader-kernel.glsl','utf8'))+';'+readFileSync('src/features/presentation/shader-preview.js','utf8')});
 const result=await page.evaluate(()=>{
  const c=document.querySelector('canvas'),p=producerShaderPreview(c,{effect:'voiceSea',colors:['#00d9ff','#ed17df','#ffae24'],speed:.55,intensity:1.5,scale:1,opacity:1,radius:0,quality:'medium',clock:'show',glow:.7},960,540),gl=c.getContext('webgl');
  const sample=(time,level)=>{p.draw(time);gl.uniform1f(gl.getUniformLocation(gl.getParameter(gl.CURRENT_PROGRAM),'audioLevel'),level);gl.drawArrays(gl.TRIANGLES,0,6);const data=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;};
  const quiet=sample(1,0),loud=sample(1,.9),moving=sample(2,.9);let holes=0,delta=0,motion=0;for(let i=0;i<quiet.length;i+=4){if(quiet[i+3]!==255||loud[i+3]!==255)holes++;for(let j=0;j<3;j++){delta+=Math.abs(quiet[i+j]-loud[i+j]);motion+=Math.abs(loud[i+j]-moving[i+j]);}}
  p.destroy();return{holes,meanVoiceDelta:delta/(quiet.length/4*3),meanMotionDelta:motion/(quiet.length/4*3),width:c.width,height:c.height};
 });
 assert.equal(result.holes,0);assert(result.meanVoiceDelta>3,'voice substantially changes the sea surface');assert(result.meanMotionDelta>1,'ripples travel over time');assert.equal(result.width,480,'background respects bounded half-resolution rendering');console.log('PASS: opaque full-frame sea, bounded GPU resolution, microphone response and rolling ripples',result);
}finally{await browser.close();}
