import * as THREE from 'three';
import {validateScene,validateControl} from './contract.mjs';
const base = new URL('.', location.href);
const pass = new URL(location.href).searchParams.get('pass') || 'background';
const instance=crypto.randomUUID(),run=new URL(location.href).searchParams.get('run')||'';
let renderer, disposed=false, ready=false, lost=false, revision=-1, control, descriptor, poll, raf;
const samples=[], resources=[], animated=[], cueLights=[];
let renderedRevision=-1,rendered=0, nextDraw=0, lastReport=0, previousDraw=0, applying=false;
const report = (extra={}) => fetch(new URL('telemetry',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pass,instance,run,ready,lost,revision,rendered,samples:samples.slice(-180),width:innerWidth,height:innerHeight,...extra})}).catch(()=>{});
function mesh(node) {
 const classes={box:THREE.BoxGeometry,cylinder:THREE.CylinderGeometry,torus:THREE.TorusGeometry,cone:THREE.ConeGeometry,plane:THREE.PlaneGeometry};
 const geometry = new classes[node.kind](...node.args);
 const material = node.unlit?new THREE.MeshBasicMaterial({color:node.color,opacity:node.opacity??1,transparent:true,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending}):new THREE.MeshStandardMaterial({color:node.color,metalness:node.metalness,roughness:node.roughness,emissive:node.emissive||'#000000',emissiveIntensity:0.8});
 const object=new THREE.Mesh(geometry,material);object.position.fromArray(node.position);object.rotation.set(...node.rotation);
 resources.push(geometry,material); if(node.motion)animated.push({object,node});return object;
}
async function main(){
 descriptor=validateScene(await (await fetch(new URL('scene.json',base))).json());
 control=validateControl(await (await fetch(new URL('control',base))).json());revision=control.revision;
 renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,premultipliedAlpha:true,powerPreference:'high-performance',preserveDrawingBuffer:false});
 renderer.setPixelRatio(1);renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
 renderer.domElement.dataset.scene3dInstance=instance;document.body.appendChild(renderer.domElement);
 const gl=renderer.getContext(), extension=gl.getExtension('WEBGL_debug_renderer_info');
 const gpu=extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
 renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();lost=true;ready=false;cancelAnimationFrame(raf);report({error:'WebGL context lost'});});
 // Fail visibly instead of claiming restored resources are ready. Owning adapter must recreate the resource.
 renderer.domElement.addEventListener('webglcontextrestored',()=>report({error:'Context restored; resource recreation required'}));
 const scene=new THREE.Scene();let camera;
 if(pass==='background'){
  renderer.setClearColor(descriptor.clearColor,1);scene.fog=new THREE.Fog(descriptor.fog.color,descriptor.fog.near,descriptor.fog.far);
  camera=new THREE.PerspectiveCamera(descriptor.camera.fov,innerWidth/innerHeight,0.1,100);camera.position.fromArray(descriptor.camera.position);camera.lookAt(...descriptor.camera.target);
  scene.add(new THREE.HemisphereLight('#bddcff','#101323',2));
  for(const [x,color]of[[-7,'#479bff'],[7,'#ffbe60']]){const light=new THREE.PointLight(color,170,28,2);light.position.set(x,4,3);scene.add(light);cueLights.push(light);}
  for(const node of descriptor.objects)scene.add(mesh(node));
 }else{
  renderer.setClearColor(0,0);camera=new THREE.OrthographicCamera(0,innerWidth,innerHeight,0,0.1,100);camera.position.z=10;
  for(const [i,[x,y,w,h]]of descriptor.slots.entries()){
   const color=i===0?'#559cff':'#e8b95e';
   // Planar foreground trim, aligned exactly to native camera bounds, not a video plane.
   for(const [cx,cy,bw,bh]of[[x+w/2,y,w,0.003],[x+w/2,y+h,w,0.003],[x,y+h/2,0.002,h],[x+w,y+h/2,0.002,h]]){
    const geometry=new THREE.PlaneGeometry(bw*innerWidth,bh*innerHeight),material=new THREE.MeshBasicMaterial({color,transparent:true,opacity:0.94});
    const frame=new THREE.Mesh(geometry,material);frame.position.set(cx*innerWidth,(1-cy)*innerHeight,0);scene.add(frame);resources.push(geometry,material);
   }
  }
 }
 await renderer.compileAsync(scene,camera);
 const draw=now=>{
  if(disposed||lost)return;raf=requestAnimationFrame(draw);
  const step=1000/descriptor.fps;if(now+1<nextDraw)return;nextDraw+=step;if(nextDraw<now-step)nextDraw=now+step;
  const t=(control.paused?control.elapsed:Math.max(0,Date.now()-control.anchor))/1000;
  for(const {object,node}of animated){const m=node.motion;object.rotation.y=node.rotation[1]+(m.kind==='rotateY'?t*m.speed:0);object.rotation.z=node.rotation[2]+(m.kind==='swayZ'?Math.sin(t*m.speed+m.phase)*m.amplitude:0);}
  // Cues change lighting, never business state. Both passes consume the same committed clock.
  if(pass==='background'){cueLights.forEach((light,i)=>light.intensity=control.cue==='neutral'?170:((control.cue==='blue')===(i===0)?260:35));const target=control.cue==='blue'?0x113565:control.cue==='gold'?0x574019:descriptor.clearColor;renderer.setClearColor(target,1);}
  if((pass==='foreground'||control.paused)&&rendered>0&&renderedRevision===revision){if(now-lastReport>1000){lastReport=now;report({gpu,webgl2:gl instanceof WebGL2RenderingContext,three:THREE.REVISION,memory:renderer.info.memory,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles});}return;}
  renderer.render(scene,camera);rendered++;renderedRevision=revision;ready=true;
  if(previousDraw&&pass==='background'&&!control.paused)samples.push(now-previousDraw);previousDraw=now;if(samples.length>180)samples.shift();
  if(now-lastReport>1000){lastReport=now;report({gpu,webgl2:gl instanceof WebGL2RenderingContext,three:THREE.REVISION,memory:renderer.info.memory,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles});}
 };
 raf=requestAnimationFrame(draw);
 poll=setInterval(async()=>{if(applying||disposed)return;applying=true;try{const next=validateControl(await(await fetch(new URL('control',base),{cache:'no-store'})).json());if(next.revision>revision){control=next;revision=next.revision;}}catch(e){report({error:String(e)});}finally{applying=false;}},250);
 window.addEventListener('pagehide',dispose,{once:true});
}
function dispose(){disposed=true;ready=false;clearInterval(poll);cancelAnimationFrame(raf);for(const resource of resources)resource.dispose();renderer?.dispose();}
main().catch(e=>{report({error:String(e)});document.body.textContent='3D renderer unavailable';});
