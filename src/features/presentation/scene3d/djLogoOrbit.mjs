import * as THREE from 'three';
import {parseLogoOrbit,logoPlacement} from './logoOrbit.mjs';

/** Actual post-mix DJ bands/wave drive logo transforms; no fake beat clock. */
export async function createDjLogoOrbit(renderer,width,height,input,header=[0,0,1,1]){
 const config=parseLogoOrbit(input),scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(0,width,height,0,.1,200);camera.position.z=100;
 const plot={x:width*header[0],y:height*header[1],w:width*header[2],h:height*header[3]};
 const resources=[],logos=[];let frame=null,received=-Infinity,start,previous=0,draws=0,disposed=false,paintTitle=()=>{},lastInk;
 const geometry=new THREE.PlaneGeometry(1,1);resources.push(geometry);
 const texture=canvas=>{const t=new THREE.CanvasTexture(canvas);t.colorSpace=THREE.SRGBColorSpace;resources.push(t);return t;};
 const material=t=>{const m=new THREE.MeshBasicMaterial({map:t,transparent:true,depthTest:false,depthWrite:false});resources.push(m);return m;};
 try{
  for(const logo of config.logos){
   const image=new Image();image.src=logo.data;await image.decode();if(disposed)throw Error('Logo orbit disposed');
   const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff8ed';ctx.beginPath();ctx.roundRect(2,2,252,252,38);ctx.fill();
   const fit=Math.min(196/image.naturalWidth,196/image.naturalHeight);ctx.drawImage(image,(256-image.naturalWidth*fit)/2,(256-image.naturalHeight*fit)/2,image.naturalWidth*fit,image.naturalHeight*fit);
   const mesh=new THREE.Mesh(geometry,material(texture(canvas)));scene.add(mesh);logos.push({mesh,logo,level:0,wave:0,placement:null});
  }
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.min(2048,Math.ceil(plot.w)));canvas.height=Math.max(1,Math.min(1024,Math.ceil(plot.h)));const ctx=canvas.getContext('2d'),titleTexture=texture(canvas);
  paintTitle=ink=>{lastInk=ink;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle=ink;ctx.textAlign='center';const wide=plot.w/plot.h>4;
   let size=canvas.height*(wide?.48:.34);ctx.font=`900 ${size}px Arial Black, Arial`;size*=Math.min(1,canvas.width*.63/ctx.measureText(config.title).width);ctx.font=`900 ${size}px Arial Black, Arial`;ctx.fillText(config.title,canvas.width/2,canvas.height*(wide?.73:.68));
   let sub=canvas.height*(wide?.16:.125);ctx.font=`900 ${sub}px Arial`;sub*=Math.min(1,canvas.width*.42/ctx.measureText(config.subtitle).width);ctx.font=`900 ${sub}px Arial`;ctx.fillText(config.subtitle,canvas.width/2,canvas.height*(wide?.36:.385));titleTexture.needsUpdate=true;
  };paintTitle(config.ink);
  const title=new THREE.Mesh(geometry,material(titleTexture));title.position.set(plot.x+plot.w/2,height-plot.y-plot.h/2,1);title.scale.set(plot.w,plot.h,1);scene.add(title);
 }catch(e){for(const r of resources)r.dispose();throw e;}
 function audio(value,now=performance.now()){
  if(!value||!Array.isArray(value.bands)||value.bands.length!==8||!Array.isArray(value.wave)||value.wave.length!==32)return;
  const finite=(n,a,b)=>typeof n==='number'&&Number.isFinite(n)?Math.max(a,Math.min(b,n)):0;
  frame={energy:finite(value.energy,0,1),bands:value.bands.map(n=>finite(n,0,1)),wave:value.wave.map(n=>finite(n,-1,1))};received=now;
 }
 function update(now,settings){
  start??=now;const dt=Math.min(.1,Math.max(0,(now-previous)/1000));previous=now;
  if(/^#[\da-f]{6}$/i.test(settings?.color)&&settings.color!==lastInk)paintTitle(settings.color);
  const live=now-received<250?frame:null,sensitivity=settings?.sensitivity??1,response=settings?.intensity??1,motion=settings?.motion??1;
  for(const [i,l]of logos.entries()){
   const target=Math.min(1,(live?.bands[l.logo.band]??0)*sensitivity),wave=live?.wave[Math.round(i*31/Math.max(1,logos.length-1))]??0;
   l.level+=(target-l.level)*(target>l.level?.65:1-Math.exp(-dt*10));l.wave+=(wave-l.wave)*.65;
   const p=logoPlacement({width:plot.w,height:plot.h,count:logos.length,index:i,seconds:config.seconds,time:(now-start)/1000*motion,level:l.level,wave:l.wave,response});
   l.mesh.position.set(plot.x+p.x,height-plot.y-p.y,0);l.mesh.scale.set(p.size,p.size,1);l.placement=p;
  }
  return {pulse:Math.min(.35,(live?.energy??0)*response*.2),active:motion>0||logos.some(l=>l.level>.005),dropActive:false};
 }
 return {audio,sound(){},update,render(){renderer.clearDepth();renderer.render(scene,camera);draws++;},status:()=>({energy:frame&&performance.now()-received<250?frame.energy:0,draws,logos:logos.map(l=>({id:l.logo.id,band:l.logo.band,...l.placement}))}),dispose(){disposed=true;for(const r of resources)r.dispose();}};
}
