import * as THREE from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {parseWorld,parseControl} from './contract.mjs';

/** Trusted renderer only. The Set supplies bounded JSON, never JavaScript. */
export async function mountWorld(canvas, input, options) {
 const world=parseWorld(input),pass=options.pass,width=options.width,height=options.height;
 if(!['background','foreground'].includes(pass)||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>3840||height>3840||width*height>9_000_000)throw Error('Invalid 3D surface');
 let control=parseControl(options.control),disposed=false,lost=false,epoch=0,raf=0;
 let renderer,scene,camera,trimScene,trimCamera,meshes=[],resources=[],animated=[],lights=[],envTarget;
 let frames=0,renderedRevision=-1,nextDraw=0,lastDraw=0,lastReport=0,ready=false;
 let warmFrames=0,initialized=false,cueStart=0,cueFrom=[],cameraFrom,cameraTo;
 const samples=[];
 const time=()=>((control.paused?control.elapsed:Math.max(0,Date.now()-control.anchor))/1000);
 const status=()=>({ready,lost,revision:renderedRevision,frames,width,height,pass,...hardware,samples:samples.slice(-180),calls:renderer?.info.render.calls??0,triangles:renderer?.info.render.triangles??0});
 let hardware={};
 const notify=(extra={})=>options.onStatus?.({...status(),...extra});
 function release(){cancelAnimationFrame(raf);for(const l of lights)l.light.shadow?.dispose();for(const r of resources)r.dispose();resources=[];envTarget?.dispose();envTarget=undefined;renderer?.dispose();}
 function make(node){
  const constructors={box:THREE.BoxGeometry,roundedBox:RoundedBoxGeometry,cylinder:THREE.CylinderGeometry,torus:THREE.TorusGeometry,cone:THREE.ConeGeometry,plane:THREE.PlaneGeometry,sphere:THREE.SphereGeometry};
  const geometry=new constructors[node.kind](...node.args);
  const transparent=(node.opacity??1)<1;
  const material=node.unlit?new THREE.MeshBasicMaterial({color:node.color,opacity:node.opacity??1,transparent,depthWrite:!transparent,side:THREE.DoubleSide,blending:transparent?THREE.AdditiveBlending:THREE.NormalBlending}):new THREE.MeshStandardMaterial({color:node.color,metalness:node.metalness,roughness:node.roughness,emissive:node.emissive||'#000000',emissiveIntensity:node.emissiveIntensity??.8,opacity:node.opacity??1,transparent,depthWrite:!transparent});
  const mesh=new THREE.Mesh(geometry,material);mesh.position.fromArray(node.position);mesh.rotation.set(...node.rotation);mesh.castShadow=!!node.castShadow;mesh.receiveShadow=!!node.receiveShadow;
  resources.push(geometry,material);meshes.push({mesh,node});if(node.motion)animated.push({mesh,node});return mesh;
 }
 function destination(){return world.views?.[control.view??world.cues?.[control.cue]?.view]??world.camera;}
 function setDestination(){const c=destination();cameraTo={position:new THREE.Vector3(...c.position),target:new THREE.Vector3(...c.target),fov:c.fov};if(!initialized)cameraFrom={position:camera.position.clone(),target:camera.userData.target.clone(),fov:camera.fov};}
 async function build(){
  const version=++epoch;ready=false;warmFrames=0;notify();release();animated=[];meshes=[];lights=[];trimScene=undefined;renderedRevision=-1;lastDraw=0;nextDraw=0;
  renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,premultipliedAlpha:true,powerPreference:'high-performance',preserveDrawingBuffer:false});
  renderer.shadowMap.enabled=world.objects.some(n=>(n.pass??'background')===pass&&n.castShadow);renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(1);renderer.setSize(width,height,false);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=world.environment==='studio'?THREE.ACESFilmicToneMapping:THREE.NoToneMapping;renderer.toneMappingExposure=world.exposure??1;
  const gl=renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');const gpu=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
  hardware={gpu,software:/swiftshader|llvmpipe|software raster/i.test(gpu),webgl2:gl instanceof WebGL2RenderingContext,three:THREE.REVISION};
  scene=new THREE.Scene();
  if(world.environment==='studio'){
   const generator=new THREE.PMREMGenerator(renderer),environment=new RoomEnvironment();
   envTarget=generator.fromScene(environment,.04);scene.environment=envTarget.texture;scene.environmentIntensity=world.environmentIntensity??1;environment.dispose();generator.dispose();
  }
  scene.add(new THREE.HemisphereLight('#dce8ff','#11151f',world.environment==='studio'?.65:2));
  scene.fog=new THREE.Fog(world.fog.color,world.fog.near,world.fog.far);renderer.setClearColor(world.clearColor,pass==='background'?1:0);
  const c=destination();camera=new THREE.PerspectiveCamera(c.fov,width/height,.1,150);camera.position.fromArray(c.position);camera.userData.target=new THREE.Vector3(...c.target);camera.lookAt(camera.userData.target);
  const authored=world.lights??[{id:'key',position:[-7,4,3],color:'#d7e4ff',intensity:170},{id:'fill',position:[7,4,3],color:'#ffe1bc',intensity:170}];
  for(const l of authored){const light=new THREE.PointLight(l.color,l.intensity,45,2);light.position.fromArray(l.position);if(!lights.length&&renderer.shadowMap.enabled){light.castShadow=true;light.shadow.mapSize.set(512,512);light.shadow.camera.near=.5;light.shadow.camera.far=45;light.shadow.bias=-.0002;}scene.add(light);lights.push({light,base:l.intensity,id:l.id});}
  for(const n of world.objects)if((n.pass??'background')===pass)scene.add(make(n));setDestination();
  if(pass==='foreground'){
   trimScene=new THREE.Scene();trimScene.environment=scene.environment;trimScene.environmentIntensity=world.environmentIntensity??1;trimScene.add(new THREE.HemisphereLight('#dce8ff','#11151f',.65));
   trimCamera=new THREE.OrthographicCamera(0,width,height,0,.1,200);trimCamera.position.z=100;
   const bevel=world.environment==='studio';
   for(const [i,[x,y,w,h]]of world.slots.entries()){
    const frame=world.frameStyles?.[i]??{},tint=frame.color??'#bbc2c8',thickness=frame.thickness??4,depth=frame.depth??6;
    for(const [cx,cy,bw,bh]of[[x+w/2,y,w,thickness/height],[x+w/2,y+h,w,thickness/height],[x,y+h/2,thickness/width,h],[x+w,y+h/2,thickness/width,h]]){
     const geometry=bevel?new RoundedBoxGeometry(bw*width,bh*height,depth,3,Math.min(frame.radius??1.5,bw*width/2,bh*height/2,depth/2)):new THREE.PlaneGeometry(bw*width,bh*height);
     const material=bevel?new THREE.MeshStandardMaterial({color:tint,metalness:frame.metalness??.7,roughness:frame.roughness??.3,emissive:tint,emissiveIntensity:.08}):new THREE.MeshBasicMaterial({color:tint});
     const trim=new THREE.Mesh(geometry,material);trim.position.set(cx*width,(1-cy)*height,0);trimScene.add(trim);resources.push(geometry,material);
    }
   }
  }
  if(!initialized){cueFrom=lights.map(l=>l.light.intensity);cueStart=time();initialized=true;}
  await renderer.compileAsync(scene,camera);if(trimScene)await renderer.compileAsync(trimScene,trimCamera);renderer.autoClear=false;renderer.info.autoReset=false;
  if(disposed||version!==epoch)return;
  const draw=now=>{
   if(disposed||lost||version!==epoch)return;raf=requestAnimationFrame(draw);
   const step=1000/world.fps;if(now+1<nextDraw)return;nextDraw+=step;if(nextDraw<now-step)nextDraw=now+step;
   const t=time(),duration=(world.cues?.[control.cue]?.durationMs??world.cueDurationMs??0)/1000,progress=duration?Math.min(1,Math.max(0,(t-cueStart)/duration)):1,eased=progress*progress*(3-2*progress);
   for(const {mesh,node}of meshes)mesh.visible=world.cues?.[control.cue]?.visibility?.[node.id]??node.visible??true;
   const moving=animated.some(({mesh,node})=>mesh.visible&&(node.motion.kind!=='moveY'||(t-(node.motion.clock==='cue'?cueStart:0)-node.motion.phase)*Math.abs(node.motion.speed)<1));
   const changing=progress<1&&!control.paused;
   if(warmFrames>=3&&renderedRevision===control.revision&&!changing&&(control.rendering===false||control.paused||!moving)){
    lastDraw=0;if(now-lastReport>1000){lastReport=now;notify();}return;
   }
   for(const {mesh,node}of animated){const m=node.motion,at=m.clock==='cue'?Math.max(0,t-cueStart):t;if(m.kind==='moveY'){const p=Math.min(1,Math.max(0,(at-m.phase)*Math.abs(m.speed)));mesh.position.y=node.position[1]+Math.sign(m.speed)*m.amplitude*p*p*(3-2*p);}
    mesh.rotation.y=node.rotation[1]+(m.kind==='rotateY'?at*m.speed:0);mesh.rotation.z=node.rotation[2]+(m.kind==='swayZ'?Math.sin(at*m.speed+m.phase)*m.amplitude:0);}
   lights.forEach((l,i)=>{const target=world.cues?.[control.cue]?.lights?.[l.id]??l.base;l.light.intensity=THREE.MathUtils.lerp(cueFrom[i],target,eased);});
   if(cameraTo){camera.position.lerpVectors(cameraFrom.position,cameraTo.position,eased);camera.userData.target.lerpVectors(cameraFrom.target,cameraTo.target,eased);camera.lookAt(camera.userData.target);camera.fov=THREE.MathUtils.lerp(cameraFrom.fov,cameraTo.fov,eased);camera.updateProjectionMatrix();}
   renderer.info.reset();renderer.clear();if(trimScene){renderer.render(trimScene,trimCamera);renderer.clearDepth();}renderer.render(scene,camera);frames++;warmFrames++;ready=true;
   if(lastDraw&&!control.paused&&moving){samples.push(now-lastDraw);if(samples.length>180)samples.shift();}lastDraw=now;
   const changed=renderedRevision!==control.revision;renderedRevision=control.revision;
   if(changed||now-lastReport>1000){lastReport=now;notify();}
  };
  raf=requestAnimationFrame(draw);
 }
 function onLost(event){event.preventDefault();lost=true;ready=false;cancelAnimationFrame(raf);++epoch;notify({error:'GPU context lost; recovering'});}
 function onRestored(){if(disposed)return;lost=false;void build().catch(e=>notify({error:String(e)}));}
 canvas.addEventListener('webglcontextlost',onLost);canvas.addEventListener('webglcontextrestored',onRestored);
 const api={
  update(value){const next=parseControl(value);if(next.revision<=control.revision)return;
   const beforeTime=time(),changed=next.cue!==control.cue||next.view!==control.view||next.cueSequence!==control.cueSequence;
   control=next;if(!changed)cueStart+=time()-beforeTime;if(changed&&renderer){cameraFrom={position:camera.position.clone(),target:camera.userData.target.clone(),fov:camera.fov};cueFrom=lights.map(l=>l.light.intensity);cueStart=time();setDestination();}
  },
  status,
  dispose(){if(disposed)return;disposed=true;ready=false;++epoch;release();canvas.removeEventListener('webglcontextlost',onLost);canvas.removeEventListener('webglcontextrestored',onRestored);}
 };
 try{await build();return api;}catch(e){api.dispose();throw e;}
}

// Native transport is authored by Producer, never by an imported package.
if(document.documentElement.dataset.scene3dHost==='1'){
 const root=new URL('.',location.href);let source,controller,disposed=false,receiptSerial=0,session=0,marker=[];
 const report=async state=>{const canvas=document.querySelector('canvas');if(canvas)canvas.dataset.scene3dStatus=JSON.stringify(state);if(state.ready){for(const[i,value]of[state.revision,session].entries()){for(let part=0;part<3;part++){const chunk=Math.floor(value/2**(part*24));marker[i*3+part].style.backgroundColor=`rgb(${chunk%256},${Math.floor(chunk/256)%256},${Math.floor(chunk/65536)%256})`;}}}try{await fetch(new URL('receipt',root),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...state,serial:++receiptSerial,session})});}catch{}};
 const boot=async()=>{
  const config=await(await fetch(new URL('world',root))).json();session=config.session;const control=await(await fetch(new URL('state',root))).json();
  const canvas=document.createElement('canvas');canvas.style.cssText=`display:block;width:${config.width}px;height:${config.height}px`;document.body.append(canvas);
  for(let i=0;i<6;i++){const pixel=document.createElement('i');pixel.style.cssText=`position:absolute;left:${i}px;top:${config.height}px;width:1px;height:1px;background:transparent`;document.body.append(pixel);marker.push(pixel);}
  controller=await mountWorld(canvas,config.world,{...config,control,onStatus:report});
  source=new EventSource(new URL('events',root));source.onmessage=event=>{try{controller.update(JSON.parse(event.data));}catch(e){void report({ready:false,error:String(e)});}};
  if(disposed){source.close();controller.dispose();}
 };
 window.addEventListener('pagehide',()=>{disposed=true;source?.close();controller?.dispose();},{once:true});
 void boot().catch(e=>void report({ready:false,error:String(e)}));
}
