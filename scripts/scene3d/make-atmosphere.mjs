import {parseWorld} from '../../src/features/presentation/scene3d/contract.mjs';
/** Transparent architectural accents sit between the photograph and native video. */
export function atmosphereWorld(portrait=false){
 const objects=[];
 const add=(id,kind,args,position,color,extra={})=>objects.push({id,kind,args,position,rotation:[0,0,0],color,metalness:.7,roughness:.28,pass:'foreground',...extra});
 add('stage','cylinder',[9,9.15,.16,64],[0,-3.1,-2],'#26323c',{metalness:.48,roughness:.3});
 add('stage-surface','cylinder',[8.85,8.85,.04,64],[0,-3,-2],'#273743',{metalness:.65,roughness:.22});
 for(const [i,r]of[8.95,9.13].entries())add('stage-light-'+i,'torus',[r,.018,8,64],[0,-2.98-i*.1,-2],'#edcf98',{rotation:[Math.PI/2,0,0],emissive:'#f4d5a3',emissiveIntensity:.2});
 add('atmosphere-orbit','torus',[2.25,.012,8,64],[0,2,-10],'#a7cbd8',{rotation:[.2,.3,.1],opacity:.16,unlit:true,motion:{kind:'rotateY',speed:.035,amplitude:0,phase:0}});
 const camera={position:portrait?[0,3.1,22]:[0,2.1,19],target:[0,-.5,-4],fov:portrait?49:47};
 const lights=[{id:'warm',position:[-7,6,4],color:'#ffdcaa',intensity:150},{id:'cool',position:[7,5,3],color:'#9fd9ff',intensity:70},{id:'ceiling',position:[0,9,-2],color:'#e9f2ff',intensity:180}];
 const cue=(warm,cool,ceiling)=>({lights:{warm,cool,ceiling},durationMs:700});
 return parseWorld({schema:'producer.scene3d/1',fps:30,clearColor:'#101b27',environment:'studio',environmentIntensity:.28,exposure:1.05,fog:{color:'#1a293a',near:35,far:100},camera,objects,slots:[],lights,cueDurationMs:700,views:{hero:camera,split:{...camera,position:portrait?[.6,2.7,22.5]:[-.7,2,19.5]},presenter:{...camera,position:portrait?[-.5,3.5,23]:[.6,2.8,20.2]}},cues:{neutral:cue(150,70,180),clear:cue(180,60,190),cloudy:cue(100,120,170),fog:cue(65,100,125),rain:cue(45,150,130),snow:cue(85,180,190),storm:cue(35,130,90),night:cue(90,65,65)}});
}
