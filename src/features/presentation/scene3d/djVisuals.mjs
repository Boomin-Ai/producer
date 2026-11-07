import * as THREE from 'three';
import {dropMotion,DROP_DURATION_MS} from './dropMotion.mjs';
import {createSoundPopup} from './soundPopup.mjs';
const ZERO={energy:0,bass:0,high:0,bands:Array(8).fill(0),wave:Array(32).fill(0)};
const DEFAULT={sensitivity:1,intensity:1,motion:1,waveHeight:1,waveform:'bars',drop:0,money:false,color:'#dce3e8'};
/** Fixed geometry and shared textures. Audio changes uniforms/transforms only. */
export function createDjVisuals(renderer,width,height,role,header=[0,0,1,1]){
 const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(0,width,height,0,.1,200);camera.position.z=100;
 const resources=[],matrix=new THREE.Object3D(),tint=new THREE.Color();let transportLabel='',transportPosition=0,lastPosition=-1;let frame=ZERO,received=-Infinity,energy=0,bass=0,dropAt=-Infinity,dropId,previous=0,draws=0;
 const texture=draw=>{const canvas=document.createElement('canvas');canvas.width=256;canvas.height=128;draw(canvas.getContext('2d'));const t=new THREE.CanvasTexture(canvas);t.colorSpace=THREE.SRGBColorSpace;resources.push(t);return t;};
 const glow=texture(ctx=>{ctx.translate(128,64);ctx.scale(2,1);const gradient=ctx.createRadialGradient(0,0,0,0,0,64);gradient.addColorStop(0,'#ffffff');gradient.addColorStop(.25,'#ffffff80');gradient.addColorStop(1,'#ffffff00');ctx.fillStyle=gradient;ctx.fillRect(-64,-64,128,128);});
 const spriteMaterial=new THREE.SpriteMaterial({map:glow,color:'#bfc9d2',transparent:true,blending:THREE.AdditiveBlending,depthTest:false,depthWrite:false});resources.push(spriteMaterial);
 const halo=new THREE.Sprite(spriteMaterial);halo.position.set(width*(header[0]+header[2]*.5),height*(1-header[1]-header[3]*.5),-1);halo.scale.set(width*header[2]*1.15,height*header[3]*1.6,1);scene.add(halo);
 const billTexture=texture(ctx=>{ctx.fillStyle='#a6bd84';ctx.fillRect(0,0,256,128);ctx.strokeStyle='#263d23';ctx.lineWidth=3;ctx.strokeRect(7,7,242,114);ctx.strokeRect(13,13,230,102);ctx.fillStyle='#324c2d';ctx.beginPath();ctx.ellipse(128,64,35,44,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#d2ddaa';ctx.font='bold 48px Georgia';ctx.textAlign='center';ctx.fillText('$',128,81);ctx.font='bold 26px Georgia';ctx.fillStyle='#263d23';ctx.fillText('100',45,42);ctx.fillText('100',211,105);ctx.font='bold 10px Arial';ctx.fillText('PRODUCER',128,112);});
 const billGeometry=new THREE.PlaneGeometry(1,1),billMaterial=new THREE.MeshBasicMaterial({map:billTexture,transparent:true,side:THREE.DoubleSide,depthTest:false,depthWrite:false});resources.push(billGeometry,billMaterial);
 const bills=new THREE.InstancedMesh(billGeometry,billMaterial,36);bills.instanceMatrix.setUsage(THREE.DynamicDrawUsage);bills.frustumCulled=false;scene.add(bills);
 const barGeometry=new THREE.PlaneGeometry(1,1),barMaterial=new THREE.MeshBasicMaterial({color:'#dce3e8',transparent:true,depthTest:false,depthWrite:false});resources.push(barGeometry,barMaterial);
 const accentMaterial=new THREE.MeshBasicMaterial({color:'#dce3e8',transparent:true,depthTest:false,depthWrite:false});
 const streaks=new THREE.InstancedMesh(barGeometry,accentMaterial,12);streaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);streaks.frustumCulled=false;scene.add(streaks);
 const ringGeometry=new THREE.RingGeometry(.985,1,64),rings=new THREE.InstancedMesh(ringGeometry,accentMaterial,3);rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);rings.frustumCulled=false;scene.add(rings);resources.push(accentMaterial,ringGeometry);
 const bars=new THREE.InstancedMesh(barGeometry,barMaterial,32);bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);bars.frustumCulled=false;scene.add(bars);
 const lineGeometry=new THREE.BufferGeometry(),positions=new Float32Array(32*3);lineGeometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
 const lineMaterial=new THREE.LineBasicMaterial({color:'#dce3e8',transparent:true,depthTest:false,depthWrite:false});resources.push(lineGeometry,lineMaterial);const line=new THREE.Line(lineGeometry,lineMaterial);line.frustumCulled=false;scene.add(line);
 const plot={x:width*header[0],y:height*header[1],w:width*header[2],h:height*header[3]},transport=role==='spectrum'&&header[0]>0;
 const clockCanvas=document.createElement('canvas');clockCanvas.width=512;clockCanvas.height=64;
 const clockTexture=new THREE.CanvasTexture(clockCanvas);clockTexture.colorSpace=THREE.SRGBColorSpace;
 const clockMaterial=new THREE.MeshBasicMaterial({map:clockTexture,transparent:true,depthTest:false,depthWrite:false});resources.push(clockTexture,clockMaterial);
 const clockMesh=new THREE.Mesh(barGeometry,clockMaterial);const clockLeft=plot.x+plot.w+14,clockWidth=Math.max(1,width-clockLeft);
 clockMesh.position.set(clockLeft+clockWidth/2,height-plot.y-plot.h/2,0);clockMesh.scale.set(clockWidth,26,1);scene.add(clockMesh);
 const railMaterial=new THREE.MeshBasicMaterial({color:'#46505a',transparent:true,depthTest:false,depthWrite:false});resources.push(railMaterial);
 const rail=new THREE.Mesh(barGeometry,railMaterial),fill=new THREE.Mesh(barGeometry,barMaterial),cursor=new THREE.Mesh(barGeometry,barMaterial),mixCursor=new THREE.Mesh(barGeometry,barMaterial);
 const railY=height-plot.y-plot.h-9;rail.position.set(plot.x+plot.w/2,railY,0);rail.scale.set(plot.w,1.2,1);scene.add(rail,fill,cursor,mixCursor);
 let clockKey='';
 const soundPopup=role==='stage'?createSoundPopup(scene,width,height):null;


 function audio(value,now=performance.now()){
  if(!value||!Array.isArray(value.bands)||value.bands.length!==8||!Array.isArray(value.wave)||value.wave.length!==32)return;
  const finite=(v,min,max)=>typeof v==='number'&&Number.isFinite(v)?Math.max(min,Math.min(max,v)):0;
  frame={positionMs:finite(value.positionMs,0,Number.MAX_SAFE_INTEGER),durationMs:finite(value.durationMs,0,Number.MAX_SAFE_INTEGER),playing:value.playing===true,blend:finite(value.blend,0,1),mixing:value.mixing===true,energy:finite(value.energy,0,1),bass:finite(value.bass,0,1),high:finite(value.high,0,1),bands:value.bands.map(v=>finite(v,0,1)),wave:value.wave.map(v=>finite(v,-1,1))};received=now;
 }
 function update(now,settings){
  const c=settings??DEFAULT,dt=Math.min(.1,Math.max(0,(now-previous)/1000));previous=now;
  if(dropId===undefined)dropId=c.drop;else if(dropId!==c.drop){dropId=c.drop;dropAt=now;}
  const live=now-received<250?frame:ZERO;
  const target=Math.min(1,live.energy*c.sensitivity),low=Math.min(1,live.bass*c.sensitivity);
  energy+=(target-energy)*(target>energy?.65:1-Math.exp(-dt*10));bass+=(low-bass)*(low>bass?.75:1-Math.exp(-dt*12));
  const age=(now-dropAt)/1000,movement=dropMotion(age*1000,c.motion);
  const pulse=Math.min(.35,(bass*.15+energy*.08)*c.intensity);
  tint.set(c.color);spriteMaterial.color.copy(tint);barMaterial.color.copy(tint).lerp(new THREE.Color('#ffffff'),.25);lineMaterial.color.copy(barMaterial.color);
  const drop=role==='stage'&&movement.active;streaks.visible=rings.visible=drop;
  accentMaterial.color.copy(tint);accentMaterial.opacity=Math.min(.5,(.12+movement.impact*.27)*c.intensity)*Math.min(1,Math.max(0,age*1000/250))*Math.min(1,Math.max(0,(DROP_DURATION_MS-age*1000)/900));
  if(drop){for(let i=0;i<12;i++){const side=i%4,travel=(age*(.28+.035*(i%3))+i*.381966)%1;
    matrix.position.set(side<2?width*(side===0?.035:.965):width*(.06+travel*.88),side<2?height*(.04+travel*.92):height*(side===2?.975:.025),0);
    matrix.rotation.set(0,0,side<2?-.08:.08);matrix.scale.set(side<2?Math.max(1.5,width*.0015):width*(.045+movement.impact*.08),side<2?height*(.045+movement.impact*.08):Math.max(1.5,height*.001),1);matrix.updateMatrix();streaks.setMatrixAt(i,matrix.matrix);
   }streaks.instanceMatrix.needsUpdate=true;
   for(let i=0;i<3;i++){const travel=(age*.35+i/3)%1,radius=Math.min(width*header[2]*.46,height*header[3]*(.3+travel*1.3));matrix.position.set(width*(header[0]+header[2]*.5),height*(1-header[1]-header[3]*.5),0);matrix.rotation.set(0,0,0);matrix.scale.set(radius,radius,1);matrix.updateMatrix();rings.setMatrixAt(i,matrix.matrix);}rings.instanceMatrix.needsUpdate=true;
  }
  halo.visible=role==='stage';spriteMaterial.opacity=Math.min(.75,(.05+pulse*.5)*c.intensity);
  const money=role==='stage'&&c.money&&c.motion>0;bills.visible=money;
  if(money){const t=now/1000;for(let i=0;i<36;i++){const seed=(i*.61803398875)%1;const cycle=(t*(.11+.04*(i%3))*Math.max(.2,c.motion)+seed)%1;matrix.position.set(width*(seed+.07*Math.sin(t*.8+i)),height*(1.2-cycle*1.5),i*.02);matrix.rotation.set(Math.sin(t+i)*.8,Math.sin(t*.7+i)*.6,t*(i%2?1:-1)*.55+i);const size=Math.min(width,height)*[.035,.055,.085,.13,.2,.26][i%6];matrix.scale.set(size,size*.5,1);matrix.updateMatrix();bills.setMatrixAt(i,matrix.matrix);}bills.instanceMatrix.needsUpdate=true;}
  const spectrum=role==='spectrum';bars.visible=spectrum&&c.waveform==='bars';line.visible=spectrum&&c.waveform==='line';
  if(bars.visible){for(let i=0;i<32;i++){const band=live.bands[Math.min(7,Math.floor(i/4))];const h=Math.min(plot.h*.98,Math.max(2,band*c.sensitivity*plot.h*.85*c.waveHeight*movement.wave));matrix.position.set(plot.x+(i+.5)*plot.w/32,height-plot.y-plot.h*.5,0);matrix.rotation.set(0,0,0);matrix.scale.set(plot.w/32*.65,h,1);matrix.updateMatrix();bars.setMatrixAt(i,matrix.matrix);}bars.instanceMatrix.needsUpdate=true;}
  if(line.visible){for(let i=0;i<32;i++){positions[i*3]=plot.x+i*plot.w/31;positions[i*3+1]=height-plot.y-plot.h*.5+live.wave[i]*plot.h*.42*c.sensitivity*c.waveHeight*movement.wave;positions[i*3+2]=0;}lineGeometry.attributes.position.needsUpdate=true;}
  clockMesh.visible=rail.visible=fill.visible=cursor.visible=transport;
  mixCursor.visible=transport&&frame.mixing===true;
  let transportChanged=false;
  if(transport){const duration=frame.durationMs??0,playing=frame.playing===true&&now-received<500;
   transportPosition=Math.min(duration,(frame.positionMs??0)+(playing?Math.max(0,Math.min(100,now-received)):0));
   const format=ms=>{const v=Math.floor(ms/1000);return Math.floor(v/60)+':'+String(v%60).padStart(2,'0');};
   transportLabel=format(transportPosition)+' / '+format(duration);const key=transportLabel+c.color;
   if(key!==clockKey){clockKey=key;const ctx=clockCanvas.getContext('2d');ctx.clearRect(0,0,512,64);ctx.font='bold 40px Menlo, monospace';ctx.textAlign='right';ctx.fillStyle=c.color;ctx.fillText(transportLabel,508,47);clockTexture.needsUpdate=true;transportChanged=true;}
   const progress=duration?transportPosition/duration:0;fill.position.set(plot.x+plot.w*progress/2,railY,0);fill.scale.set(Math.max(.001,plot.w*progress),1.8,1);cursor.position.set(plot.x+plot.w*progress,railY,0);cursor.scale.set(2.5,9,1);
   mixCursor.position.set(plot.x+plot.w*(frame.blend??0),railY-8,0);mixCursor.scale.set(5,5,1);
   transportChanged=transportChanged||Math.abs(transportPosition-lastPosition)>.5;lastPosition=transportPosition;
  }
  const soundActive=soundPopup?.update(now,c.soundPopups===true,c.motion)??false;
  return {pulse,...movement,dropActive:movement.active,active:energy>.005||bass>.005||money||movement.active||transportChanged||soundActive};
 }
 return {audio,sound(value){soundPopup?.receive(value);},update,render(){renderer.clearDepth();renderer.render(scene,camera);draws++;},status:()=>({energy,bass,positionMs:transportPosition,transportLabel,dropActive:performance.now()-dropAt<DROP_DURATION_MS,dropStreaks:streaks.visible?12:0,moneyParticles:bills.visible?36:0,...soundPopup?.status(),draws}),dispose(){soundPopup?.dispose();for(const r of resources)r.dispose();}};
}
