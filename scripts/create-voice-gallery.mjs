import {writeFileSync} from 'node:fs';
// Deterministic, asset-free authored gallery. Run from the repository root.
const styles=[
 ['Liquid Halo','#080e1b',['#244a77','#65f6dc','#b0baff'],'Find your flow.'],
 ['Twin Current','#071a1b',['#135d62','#65fff0','#efffba'],'Two currents. One voice.'],
 ['Solar Corona','#190e0b',['#8c2b13','#ffad38','#fff0ad'],'Bring the heat.'],
 ['Silk Orbit','#170d22',['#663c83','#edb1f3','#fce9dc'],'Soft touch. Strong presence.'],
 ['Bass Bloom','#130c1a',['#622460','#fb69c8','#ffd1e6'],'Let it bloom.'],
 ['Ripple Pool','#071722',['#175b8c','#62cfff','#d9f6ff'],'Every word makes waves.'],
 ['Magnetic Field','#091710',['#215f35','#84f79a','#f1ffd1'],'Draw them in.'],
 ['Neon Braid','#100c26',['#5c24b5','#ba75ff','#5df9e6'],'Stay connected.'],
 ['Lotus Pulse','#1c101b',['#88486a','#f7b9d3','#fff1db'],'Open up.'],
 ['Electric Crown','#0c1023',['#334eb1','#7aa7ff','#e2f0ff'],'Own the room.'],
 ['Vinyl Groove','#1b1510',['#715632','#deb96b','#fff0c9'],'Keep the conversation spinning.'],
 ['Saturn Drift','#0e1420',['#455e79','#c5d4ed','#f9b6a3'],'A world of your own.'],
 ['Heartbeat Loop','#200c12',['#8a2339','#ff718c','#ffd1c1'],'Feel every moment.'],
 ['Ink Aura','#14121c',['#50495f','#c1b2d9','#f3e9ff'],'Leave your mark.'],
 ['Prism Echo','#101626',['#3c55a0','#89e8f5','#f2a2e9'],'Make yourself heard.'],
];
const geometry=(left,top,width,height)=>({position:'absolute',left,top,width,height});
const text=(id,value,left,top,width,height,size,color,weight=600)=>({id,type:'text',text:value,styles:{...geometry(left,top,width,height),fontSize:size,fontWeight:weight,color,textAlign:'center'}});
const layouts=[];
for(const [variant,[name,background,colors,tagline]] of styles.entries())for(const portrait of [false,true]){
 const width=portrait?1080:1920,height=portrait?1920:1080,size=portrait?660:620,padding=110,surface=size+padding*2;
 const cx=width/2,cy=portrait?940:555,id=`style-${variant+1}-${portrait?'portrait':'landscape'}`;
 layouts.push({id,label:`${String(variant+1).padStart(2,'0')} · ${name} · ${portrait?'Portrait':'Landscape'}`,width,height,root:{id:'gallery-root',type:'box',styles:{position:'relative',width,height,background,overflow:'hidden'},children:[
  {id:'voice-visual',type:'shader',styles:geometry(cx-surface/2,cy-surface/2,surface,surface),shader:{effect:'voiceRing',variant,colors,speed:1.6,intensity:1.5,scale:1,opacity:1,radius:size/2,quality:'medium',clock:'show',glow:.65,bindings:{intensity:{get:'values.sensitivity'},speed:{get:'values.motion'},glow:{get:'values.glow'}}}},
  text('collection',{get:'values.title'},60,portrait?130:35,width-120,60,portrait?24:21,colors[1],500),
  text('style-title',variant%3===0?name.toUpperCase():name,60,portrait?260:105,width-120,100,portrait?64:54,colors[2],variant%3===1?500:700),
  {id:'host-camera',type:'slot',slotId:'host',styles:geometry(cx-size/2,cy-size/2,size,size),framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'circle',cornerRadius:0,outlineWidth:2,outlineColor:colors[1],grayscale:0,opacity:1}},
  text('tagline',tagline,60,portrait?1480:925,width-120,70,portrait?34:27,colors[2],500),
  text('edition',`LIVE SESSIONS  /  ${String(variant+1).padStart(2,'0')}`,60,portrait?1750:1010,width-120,44,18,colors[1],500),
 ]}});
}
const fields=[['sensitivity','Sensitivity',1.5,0,2],['motion','Motion',1.6,0,4],['glow','Glow',.65,0,1]];
const controls=[{id:'title',type:'text',label:'Collection title',key:'title'},...fields.map(([id,label])=>({id,type:'number',label,key:id})),...layouts.map(l=>({id:l.id,type:'button',label:l.label,action:{type:'layout.select',layoutId:l.id}}))];
const sections=[{id:'visuals',label:'Voice visuals',controls:['set:sensitivity','set:motion','set:glow','set:title']}];
for(const portrait of [false,true])for(let group=0;group<3;group++)sections.push({id:`${portrait?'portrait':'landscape'}-${group+1}`,label:`${portrait?'Portrait':'Landscape'} · ${group*5+1}–${group*5+5}`,collapsed:portrait||group>0,controls:layouts.filter(l=>l.id.endsWith(portrait?'portrait':'landscape')).slice(group*5,group*5+5).map(l=>`set:${l.id}`)});
const doc={schema:'producer.presentation/2',id:'voice-gallery',version:'1.0.0',name:'Voice Collection · 15 Studies',set:{initialLayout:layouts[0].id,values:{title:{type:'text',default:'THE VOICE COLLECTION',maxLength:60},...Object.fromEntries(fields.map(([key,,value,min,max])=>[key,{type:'number',default:value,min,max}]))},feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},controls,controlArrangement:{sections,minimized:['set:sensitivity','set:motion','set:glow']},layouts}};
writeFileSync('docs/shows/voice-gallery.json',JSON.stringify(doc,null,2)+'\n');
console.log(`Wrote ${layouts.length} layouts, ${controls.length} controls; every layout includes host camera.`);
