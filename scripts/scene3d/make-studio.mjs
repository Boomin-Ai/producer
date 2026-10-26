import {parseWorld} from '../../src/features/presentation/scene3d/contract.mjs';
export function studio(portrait=false){
 const objects=[];
 const add=(id,kind,args,position,color,extra={})=>objects.push({id,kind,args,position,rotation:[0,0,0],color,metalness:.82,roughness:.26,...extra});
 const rounded=(id,size,p,color,extra={})=>add(id,'roundedBox',[...size,3,Math.min(.06,...size.map(n=>n/3))],p,color,extra);
 // A restrained, machined studio: stone stage, champagne structure and inset LEDs.
 add('floor','plane',[64,64],[0,-2.8,0],'#080e16',{rotation:[-Math.PI/2,0,0],metalness:.28,roughness:.36,receiveShadow:true});
 add('stage-base','cylinder',[7.5,7.7,.34,64],[0,-2.65,-1],'#131920');
 add('stage-surface','cylinder',[7.35,7.35,.09,64],[0,-2.43,-1],'#14202b',{roughness:.35,metalness:.35});
 for(const [i,r]of[7.42,7.62].entries())add('stage-reveal-'+i,'torus',[r,.024,8,64],[0,-2.48-i*.14,-1],i?'#c6a576':'#96b9d8',{rotation:[Math.PI/2,0,0],emissive:i?'#806137':'#496f94',emissiveIntensity:.4});
 rounded('back-wall',[64,48,.3],[0,3,-12],'#080e14',{roughness:.9,metalness:.05});
 for(let i=-9;i<=9;i++){
  const height=8.5-Math.abs(i)*.22,x=i*.73;
  rounded(`flute-${i+9}`,[.12,height,.22],[x,1.9,-8.68],i%3===0?'#786d5c':'#252e37',{roughness:.36});
 }
 for(const side of[-1,1]){
  const name=side<0?'blue':'gold',tint=side<0?'#4d9fe0':'#d8b276';
  rounded(name+'-pier',[.38,11,.8],[side*8.2,2,-5.4],'#7a776e');
  rounded(name+'-inset',[.035,9,.12],[side*7.96,2,-4.93],tint,{emissive:tint,emissiveIntensity:1.1,metalness:.3});
  for(let i=0;i<4;i++){
   rounded(`${name}-fin-${i}`,[.3,9.5-i*.7,.6],[side*(8.7+i*.7),1.2,-6.2-i*.45],'#363d43',{roughness:.3});
   rounded(`${name}-fin-light-${i}`,[.026,7.5-i*.7,.08],[side*(8.52+i*.7),1.2,-5.85-i*.45],tint,{emissive:tint,emissiveIntensity:.55});
  }
  add(name+'-plinth','cylinder',[2.5,2.75,.22,64],[side*4,-2.28,.3],'#1b242e');
  add(name+'-plinth-reveal','torus',[2.55,.022,8,64],[side*4,-2.2,.3],tint,{rotation:[Math.PI/2,0,0],emissive:tint,emissiveIntensity:.65});
 }
 // Layered overhead architecture provides depth without a distracting backdrop.
 for(let i=0;i<3;i++)add('canopy-'+i,'torus',[10+i*.38,.075,8,64],[0,8.1+i*.16,-5.5],'#736e62',{rotation:[Math.PI/2,0,0],roughness:.22});
 for(let i=0;i<3;i++)rounded('ceiling-slat-'+i,[11.5,.055,.16],[0,5.05+i*.17,-5.5+i*.9],'#b9d1e0',{emissive:'#adc9df',emissiveIntensity:.7,motion:{kind:'swayZ',speed:.11+i*.025,amplitude:.012,phase:i*1.7}});
 add('emblem-core','sphere',[.56,32,24],[0,-.4,4],'#cda761',{pass:'foreground',visible:false,metalness:.92,roughness:.2,motion:{kind:'moveY',clock:'cue',speed:1.2,amplitude:1,phase:0}});
 add('emblem-orbit','torus',[.9,.035,8,64],[0,.6,4],'#e0bf7c',{pass:'foreground',visible:false,rotation:[.2,.25,.18],motion:{kind:'rotateY',clock:'cue',speed:.36,amplitude:0,phase:0}});
 add('emblem-orbit-inner','torus',[.76,.022,8,64],[0,.6,4],'#938677',{pass:'foreground',visible:false,rotation:[1.2,0,-.3],motion:{kind:'rotateY',clock:'cue',speed:-.25,amplitude:0,phase:0}});
 const camera={position:portrait?[0,3.4,24]:[0,2.3,19.5],target:[0,.6,-3],fov:portrait?49:46};
 return parseWorld({schema:'producer.scene3d/1',fps:30,environment:'studio',environmentIntensity:.18,exposure:1.05,clearColor:'#080e14',fog:{color:'#0b1118',near:26,far:65},camera,objects,slots:portrait?[[.09,.25,.82,.26],[.09,.59,.82,.26]]:[[.065,.335,.385,.385],[.55,.335,.385,.385]],views:{wide:camera,closer:{...camera,position:portrait?[0,3,22.8]:[0,2,18.5]}},frameStyles:[{color:'#569bfa',metalness:.85,roughness:.21,thickness:7,depth:10,radius:2},{color:'#e5ba76',metalness:.85,roughness:.21,thickness:7,depth:10,radius:2}],cueDurationMs:650,lights:[{id:'blue-key',position:[-6,4,4],color:'#76bfff',intensity:140},{id:'gold-key',position:[6,4,4],color:'#ffd69a',intensity:145},{id:'ceiling',position:[0,7,-1],color:'#e9f2ff',intensity:230}],cues:{'reveal-emblem':{visibility:{'emblem-core':true,'emblem-orbit':true,'emblem-orbit-inner':true},lights:{'blue-key':180,'gold-key':180,ceiling:250}},neutral:{lights:{'blue-key':140,'gold-key':145,ceiling:230}},'host-floor':{lights:{'blue-key':270,'gold-key':65,ceiling:190}},'guest-floor':{lights:{'blue-key':65,'gold-key':270,ceiling:190}}}});
}
