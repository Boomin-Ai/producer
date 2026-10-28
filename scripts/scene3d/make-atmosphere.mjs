import {parseWorld} from '../../src/features/presentation/scene3d/contract.mjs';
/** Motion accents only. The photographed architecture supplies the environment;
 * Three.js adds restrained light movement and condition-specific precipitation. */
export function atmosphereWorld(portrait=false){
 const objects=[];
 const add=(id,kind,args,position,color,extra={})=>objects.push({id,kind,args,position,rotation:[0,0,0],color,metalness:0,roughness:1,pass:'foreground',unlit:true,...extra});
 // Fine moving reflections at the perimeter, away from camera and forecast text.
 for(let i=0;i<6;i++)add('light-trace-'+i,'plane',[.012,1.4+i*.15],[(i%2?1:-1)*(portrait?6.5:13.8),2.6-Math.floor(i/2)*2,-12],'#f2d3a5',{opacity:.26,rotation:[0,0,i%2?.18:-.18],motion:{kind:'swayZ',speed:.22,amplitude:.12,phase:i*.8}});
 for(let i=0;i<24;i++)add('rain-'+i,'plane',[.012,.24+(i%3)*.08],[-15+(i*7%30),-3+(i*11%12),-14-(i%4)],'#c3deed',{opacity:.24,visible:false,rotation:[0,0,-.15],motion:{kind:'moveY',speed:-.65,amplitude:1,phase:(i%6)*.12,clock:'cue'}});
 for(let i=0;i<12;i++)add('snow-'+i,'plane',[.055,.055],[-13+(i*9%26),-2+(i*7%10),-12-i%3],'#e9f4ff',{opacity:.45,visible:false,motion:{kind:'swayZ',speed:.4,amplitude:.7,phase:i*.45}});
 const camera={position:portrait?[0,1,23]:[0,1,20],target:[0,0,-8],fov:47};
 const visibility=(rain=false,snow=false)=>Object.fromEntries(objects.filter(o=>o.visible===false).map(o=>[o.id,o.id.startsWith('rain-')?rain:snow]));
 const cue=(rain=false,snow=false)=>({visibility:visibility(rain,snow),durationMs:760});
 return parseWorld({schema:'producer.scene3d/1',fps:30,clearColor:'#101b27',environment:'none',environmentIntensity:0,exposure:1,fog:{color:'#1a293a',near:60,far:100},camera,objects,slots:[],cueDurationMs:760,views:{hero:camera,split:{...camera,position:[.25,1,20]},presenter:{...camera,position:[-.25,1.1,20.3]}},cues:{neutral:cue(),clear:cue(),cloudy:cue(),fog:cue(),rain:cue(true),snow:cue(false,true),storm:cue(true),night:cue()}});
}
