import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {build} from 'esbuild';
const bundle=await build({stdin:{contents:"export {parsePackage} from './src/features/presentation/schema';export {outputProjection} from './src/features/presentation/projection';export {RehearsalSession} from './src/features/presentation/rehearsal';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {parsePackage,outputProjection,RehearsalSession}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const doc=parsePackage(JSON.parse(readFileSync('docs/shows/voice-gallery.json','utf8')));
assert.equal(doc.set.layouts.length,30);assert.equal(doc.set.controls.length,34);
for(const [index,layout] of doc.set.layouts.entries()){
 const session=new RehearsalSession(doc);session.send({type:'control',action:{type:'layout.select',layoutId:layout.id}});session.send({type:'field',key:'glow',value:.8});
 const projection=outputProjection(doc,session.snapshot()),shader=projection.root.children.find(n=>n.shader),camera=projection.root.children.find(n=>n.type==='slot');
 assert.equal(shader.shader.variant,Math.floor(index/2));assert.equal(shader.shader.glow,.8);assert.equal(shader.shader.bindings,undefined);
 assert.equal(camera.slotId,'host');assert.equal(camera.appearance.shape,'circle');
 assert.equal(camera.styles.left+camera.styles.width/2,layout.width/2);assert.equal(shader.styles.width-camera.styles.width,220);
}
for(const variant of [-1,15,1.2]){const bad=structuredClone(doc);bad.set.layouts[0].root.children[0].shader.variant=variant;assert.throws(()=>parsePackage(bad));}
console.log('PASS: all30 layouts retain host cameras, bounded variant, geometry and bound controls.');
if(process.argv.includes('--schema-only'))process.exit(0);
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage();await page.setContent('<canvas id="visual"></canvas>');
 await page.addScriptTag({content:'const PRODUCER_SHADER_KERNEL='+JSON.stringify(readFileSync('src/features/presentation/shader-kernel.glsl','utf8'))+';'+readFileSync('src/features/presentation/shader-preview.js','utf8')});
 const results=await page.evaluate(()=>{
  const results=[];
  for(let variant=0;variant<15;variant++){
   const canvas=document.createElement('canvas');document.body.append(canvas);
   const preview=producerShaderPreview(canvas,{effect:'voiceRing',variant,colors:['#244a77','#65f6dc','#b0baff'],speed:1.6,intensity:1.5,scale:1,opacity:1,radius:130,quality:'medium',clock:'show',glow:.65},480,480),gl=canvas.getContext('webgl');preview.draw(1.25);
   const sample=level=>{const program=gl.getParameter(gl.CURRENT_PROGRAM);gl.uniform1f(gl.getUniformLocation(program,'audioLevel'),level);gl.drawArrays(gl.TRIANGLES,0,6);const data=new Uint8Array(480*480*4);gl.readPixels(0,0,480,480,gl.RGBA,gl.UNSIGNED_BYTE,data);let hash=0,energy=0,center=0,premultiplied=true;for(let y=0;y<480;y++)for(let x=0;x<480;x++){const i=(y*480+x)*4,a=data[i+3];hash=Math.imul(hash,31)+a|0;energy+=a;if(Math.hypot(x-240,y-240)<120)center+=a;if(Math.max(data[i],data[i+1],data[i+2])>a+1)premultiplied=false;}return{hash,energy,center,premultiplied};};
   results.push({variant,silent:sample(0),active:sample(.8)});preview.destroy();canvas.remove();
  }
  return results;
 });
 for(const {variant,silent,active}of results){assert.notEqual(active.hash,silent.hash,`variant${variant} responds to audio`);assert.equal(active.center,0,`variant${variant} preserves transparent camera center`);assert(active.premultiplied,`variant${variant} premultiplied`);assert(active.energy>0);}
 assert.equal(new Set(results.map(r=>r.active.hash)).size,15,'all15 algorithms produce distinct shapes with the same palette');
 if(process.argv.includes('--contact-sheet')){
  await page.setViewportSize({width:1300,height:1040});
  await page.evaluate(layouts=>{
   document.body.innerHTML='';document.body.style.cssText='margin:0;padding:20px;display:grid;grid-template-columns:repeat(5,1fr);gap:12px;background:#080b12;color:white;font-family:Arial';
   for(const layout of layouts){const config=layout.root.children.find(n=>n.shader).shader,name=layout.label.split(' · ')[1],card=document.createElement('section');card.style.cssText='height:320px;position:relative;border:1px solid #ffffff22;border-radius:12px;overflow:hidden;background:'+layout.root.styles.background;
    const title=document.createElement('div');title.textContent=name;title.style.cssText='text-align:center;padding:18px 0;font-size:16px;color:'+config.colors[2];card.append(title);
    const canvas=document.createElement('canvas');canvas.style.cssText='position:absolute;width:240px;height:240px;left:0;top:54px';card.append(canvas);document.body.append(card);const preview=producerShaderPreview(canvas,{...config,radius:130},480,480);preview.draw(1.25);
    const camera=document.createElement('div');camera.style.cssText='position:absolute;left:55px;top:109px;width:130px;height:130px;border-radius:50%;overflow:hidden;background:linear-gradient(140deg,#243342,#14212a);border:1px solid '+config.colors[1];camera.innerHTML='<div style="position:absolute;border-radius:50%;width:45px;height:53px;background:#8295a4;left:42px;top:22px"></div><div style="position:absolute;border-radius:50% 50% 0 0;width:106px;height:73px;background:#8295a4;left:12px;top:78px"></div>';card.append(camera);
    const note=document.createElement('div');note.textContent='HOST CAMERA · SIMULATED PREVIEW';note.style.cssText='position:absolute;bottom:14px;width:100%;text-align:center;font-size:9px;letter-spacing:1px;color:'+config.colors[1];card.append(note);
   }
  },doc.set.layouts.filter((_,i)=>i%2===0));
  mkdirSync('target',{recursive:true});await page.screenshot({path:'target/voice-gallery-contact-sheet.png',fullPage:true});
 }
 console.log('PASS: all15 GPU variants respond, remain premultiplied, preserve camera center, and produce distinct shapes.');
}finally{await browser.close();}
