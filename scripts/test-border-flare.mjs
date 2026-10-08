import fs from 'node:fs';
import assert from 'node:assert/strict';
const {webkit}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const browser=await webkit.launch();
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1420/scripts/native-probe.html');
 const proof=await page.evaluate(({kernel,adapter})=>{
  const render=new Function('PRODUCER_SHADER_KERNEL',adapter+';return producerShaderPreview;')(kernel);
  const canvas=document.createElement('canvas');document.body.replaceChildren(canvas);
  const gpu=render(canvas,{effect:'borderFlare',colors:['#0b1dad','#3167ff','#e5f0ff'],speed:.65,intensity:1.65,scale:2,opacity:1,radius:35,quality:'medium'},512,288);
  const read=time=>{gpu.draw(time);const gl=canvas.getContext('webgl');const pixels=new Uint8Array(512*288*4);gl.readPixels(0,0,512,288,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let hash=0,bright=0,interior=0,lit=0;for(let y=0;y<288;y++)for(let x=0;x<512;x++){const i=(y*512+x)*4;hash=(Math.imul(hash,31)+pixels[i+3])|0;if(pixels[i+3]>20)lit++;if(pixels[i]>180&&pixels[i+1]>180)bright++;if(x>40&&x<472&&y>40&&y<248&&pixels[i+3]>0)interior++;}return {hash,bright,interior,lit}};
  const start=read(0),moving=read(3);gpu.destroy();return {start,moving};
 },{kernel:fs.readFileSync('src/features/presentation/shader-kernel.glsl','utf8'),adapter:fs.readFileSync('src/features/presentation/shader-preview.js','utf8')});
 assert.notEqual(proof.start.hash,proof.moving.hash,'Flare must move');assert.equal(proof.moving.interior,0,'Panel interior must stay transparent');assert.ok(proof.moving.bright>0,'Flare must have a bright white-blue core');assert.ok(proof.moving.lit<512*288*.04,'Light must stay concentrated on a thin perimeter');console.log('PASS moving hairline flare, bright core, transparent interior and concentrated edge light',proof);
}finally{await browser.close()}
