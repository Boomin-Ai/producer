import * as THREE from 'three';

/** One reusable texture and mesh. A successful play restarts its local clock. */
export function createSoundPopup(scene,width,height){
 const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=256;
 const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
 const geometry=new THREE.PlaneGeometry(1,1),material=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthTest:false,depthWrite:false});
 const mesh=new THREE.Mesh(geometry,material);mesh.visible=false;mesh.renderOrder=100;scene.add(mesh);
 let sequence=0,label='',started=-Infinity,emphatic=false,dirty=false;
 const lifetime=()=>emphatic?2800:1900;
 function receive(event,now=performance.now()){
  if(event===null){started=-Infinity;dirty=true;return;}
  if(!event||!Number.isSafeInteger(event.sequence)||event.sequence<=sequence||typeof event.label!=='string'||event.label.length>160||!Number.isFinite(event.ageMs)||event.ageMs<0||event.ageMs>=3000)return;
  sequence=event.sequence;emphatic=/^FA+H+$/i.test(event.label.replace(/[^a-z]/gi,''));label=emphatic?'FAHHHHHH!':event.label.trim().toUpperCase().slice(0,52);
  started=now-event.ageMs;if(!label)return;
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,1024,256);
  ctx.fillStyle='#10171deb';ctx.strokeStyle='#c6d3dd';ctx.lineWidth=3;ctx.beginPath();ctx.roundRect(5,12,1014,232,30);ctx.fill();ctx.stroke();
  ctx.fillStyle='#a9b7c1';ctx.font='bold 17px Menlo, monospace';ctx.textAlign='center';ctx.fillText(emphatic?'SOUND THE ALARM':'SOUND FX',512,51);
  let size=emphatic?142:100;ctx.font=`900 italic ${size}px Arial, sans-serif`;const measured=ctx.measureText(label).width;
  if(measured>914){size*=914/measured;ctx.font=`900 italic ${size}px Arial, sans-serif`;}
  const shine=ctx.createLinearGradient(0,70,0,220);shine.addColorStop(0,'#ffffff');shine.addColorStop(.45,'#d2dce4');shine.addColorStop(.5,'#8095a5');shine.addColorStop(.62,'#e6edf2');shine.addColorStop(1,'#aabcc9');
  ctx.strokeStyle='#05090d';ctx.lineWidth=8;ctx.lineJoin='round';ctx.strokeText(label,512,194);ctx.fillStyle=shine;ctx.fillText(label,512,194);
  texture.needsUpdate=true;dirty=true;
 }
 function update(now,enabled,motion=1){
  const redraw=dirty||mesh.visible;dirty=false;
  if(!enabled){started=-Infinity;mesh.visible=false;return redraw;}
  const age=now-started,duration=lifetime();mesh.visible=age>=0&&age<duration;if(!mesh.visible)return redraw;
  const strength=Math.max(0,Math.min(2,motion)),decay=Math.pow(Math.max(0,1-age/(emphatic?2100:1200)),2),shake=decay*strength*(emphatic?1:.45);
  const entry=age<140?.72+.4*(1-Math.pow(1-age/140,3)):age<320?1.12-.12*(age-140)/180:1;
  const exit=Math.min(1,(duration-age)/380),scale=(1+(entry-1)*Math.min(1,strength))*(.95+.05*exit);
  const w=Math.min(width*(height>width?.84:.7),height>width?960:1160);
  mesh.position.set(width*.5+Math.sin(age*.071)*26*shake,height*(height>width?.45:.24)+Math.sin(age*.093)*10*shake,2);
  mesh.rotation.z=Math.sin(age*.061)*.035*shake;mesh.scale.set(w*scale,w*.25*scale,1);material.opacity=Math.min(1,age/55,exit);
  return true;
 }
 return {receive,update,status:()=>({soundActive:mesh.visible,soundLabel:mesh.visible?label:'',soundSequence:sequence}),dispose(){texture.dispose();geometry.dispose();material.dispose();}};
}
