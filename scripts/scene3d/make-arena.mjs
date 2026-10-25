export function arena(portrait = false) {
 const objects=[];
 const add=(id,kind,args,position,color,extra={})=>objects.push({id,kind,args,position,rotation:[0,0,0],color,metalness:0.75,roughness:0.28,...extra});
 add('floor','cylinder',[13,13,0.25,32],[0,-2.5,0],'#0a111e');
 for(let i=0;i<5;i++)add(`stage-ring-${i}`,'torus',[5+i*1.6,0.035,8,64],[0,-2.32+i*0.015,0],i%2?'#ecb65a':'#469cff',{rotation:[Math.PI/2,0,0],emissive:i%2?'#aa6616':'#1754bb'});
 add('podium','cylinder',[5,5.4,0.35,32],[0,-2.12,0],'#1c293b');
 for(let side=-1;side<=1;side+=2){
  const tint=side<0?'#3c99ff':'#edb759';
  for(let i=0;i<9;i++){
   const x=side*(3.8+i*0.72), z=-6+Math.sin(i*0.3)*1.4;
   add(`${side<0?'blue':'gold'}-pillar-${i}`,'box',[0.16,10+i*0.35,0.32],[x,2,z],'#192b40');
   add(`${side<0?'blue':'gold'}-strip-${i}`,'box',[0.035,9+i*0.35,0.08],[x-0.1*side,2,z+0.2],tint,{emissive:tint});
  }
  for(let i=0;i<3;i++)add(`${side<0?'blue':'gold'}-beam-${i}`,'cone',[1.8,13,24],[side*(4+i*2.2),3,-3],tint,{rotation:[0,0,side*0.28],opacity:0.045,unlit:true,motion:{kind:'swayZ',speed:0.22+i*0.05,amplitude:0.18,phase:i*1.2}});
 }
 for(let i=0;i<3;i++)add(`ceiling-ring-${i}`,'torus',[8+i*2.2,0.08,8,64],[0,6+i*0.45,-2],'#536475',{rotation:[Math.PI/2,0,0]});
 add('horizon','plane',[34,18],[0,3,-9],'#080e19');
 return {schema:'producer.scene3d-proof/1',fps:30,clearColor:'#060a12',fog:{color:'#080f1d',near:15,far:45},camera:{position:portrait?[0,2,22]:[0,1.6,17],target:[0,0,-2],fov:portrait?52:48},objects,slots:portrait?[[0.08,0.19,0.84,0.27],[0.08,0.55,0.84,0.27]]:[[0.055,0.3,0.4,0.4],[0.545,0.3,0.4,0.4]]};
}
