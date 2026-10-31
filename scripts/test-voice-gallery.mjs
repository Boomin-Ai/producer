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
 assert.equal(shader.shader.glow,.8);assert.equal(shader.shader.bindings,undefined);
 assert.equal(camera.slotId,'host');assert(['circle','rectangle'].includes(camera.appearance.shape));
 assert(projection.root.children.filter(n=>n.shader).length<=4);
}
for(const orientation of ['landscape','portrait']){
 const signatures=doc.set.layouts.filter(l=>l.id.endsWith(orientation)).map(l=>JSON.stringify(l.root.children.filter(n=>n.type==='shader'||n.type==='slot').map(n=>({type:n.type,geometry:n.styles,shape:n.appearance?.shape,cornerRadius:n.appearance?.cornerRadius,effect:n.shader?.effect}))));
 assert.equal(new Set(signatures).size,15,'all15 compositions differ without considering colors, text or variant');
}
const all=doc.set.layouts.flatMap(l=>l.root.children);assert(new Set(all.filter(n=>n.shader).map(n=>n.shader.scale)).size>5);assert.equal(new Set(all.filter(n=>n.shader).map(n=>n.shader.effect)).size,2);assert.equal(new Set(doc.set.layouts.map(l=>l.root.children.filter(n=>n.shader).length)).size,4);
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
  await page.setViewportSize({width:1120,height:1300});
  await page.evaluate(layouts=>{
   document.body.innerHTML='';document.body.style.cssText='margin:0;padding:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px;background:#080b12;color:white;font-family:Arial';
   for(const layout of layouts){const card=document.createElement('section');card.style.cssText='height:239px;overflow:hidden;border:1px solid #ffffff22;border-radius:8px';const label=document.createElement('div');label.textContent=layout.label;label.style.cssText='font-size:13px;padding:9px';card.append(label);const scene=document.createElement('div');scene.style.cssText='position:relative;width:1920px;height:1080px;transform:scale(.178);transform-origin:top left;background:'+layout.root.styles.background;card.append(scene);document.body.append(card);
    for(const node of layout.root.children){const g=node.styles,el=document.createElement('div');el.style.cssText=`position:absolute;left:${g.left}px;top:${g.top}px;width:${g.width}px;height:${g.height}px;`;scene.append(el);
     if(node.shader){const canvas=document.createElement('canvas'),preview=producerShaderPreview(canvas,node.shader,g.width,g.height);preview.draw(1.25);const image=document.createElement('img');image.src=canvas.toDataURL();image.style.cssText='width:100%;height:100%';el.append(image);preview.destroy();}
     else if(node.type==='slot'){el.style.borderRadius=node.appearance.shape==='circle'?'50%':node.appearance.cornerRadius+'px';el.style.overflow='hidden';el.style.background='linear-gradient(140deg,#243342,#14212a)';el.style.outline='2px solid '+node.appearance.outlineColor;el.innerHTML='<div style="position:absolute;border-radius:50%;width:34%;height:37%;background:#8295a4;left:33%;top:15%"></div><div style="position:absolute;border-radius:50% 50% 0 0;width:80%;height:55%;background:#8295a4;left:10%;top:57%"></div>';}
     else if(node.type==='text'){el.textContent=typeof node.text==='string'?node.text:'THE VOICE COLLECTION';Object.assign(el.style,{fontSize:g.fontSize+'px',fontWeight:g.fontWeight,color:g.color,textAlign:g.textAlign});}
    }
   }
  },doc.set.layouts.filter((_,i)=>i%2===0).map(layout=>{if(!process.argv.includes('--monochrome'))return layout;const copy=structuredClone(layout);copy.root.styles.background='#101318';for(const node of copy.root.children){if(node.shader)node.shader.colors=['#707070','#dddddd','#ffffff'];if(node.styles.color)node.styles.color='#eeeeee';if(node.appearance)node.appearance.outlineColor='#eeeeee';}return copy;}));
  mkdirSync('target',{recursive:true});await page.screenshot({path:process.argv.includes('--monochrome')?'target/voice-gallery-monochrome.png':'target/voice-gallery-contact-sheet.png',fullPage:true});
 }
 console.log('PASS: all15 GPU variants respond, remain premultiplied, preserve camera center, and produce distinct shapes.');
}finally{await browser.close();}
