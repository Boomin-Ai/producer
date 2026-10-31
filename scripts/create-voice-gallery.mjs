import {writeFileSync} from 'node:fs';
// Authored topologies in a 1000×1000 logical canvas, adapted to each orientation.
const designs=[
 ['Halo Portrait',[350,240,300,520,'circle'],[[330,220,340,560,'voiceRing',0]],'One voice. All eyes.'],
 ['Broadcast Line',[100,200,800,560,'rectangle'],[[70,790,860,120,'voiceBars',0]],'The conversation, uninterrupted.'],
 ['Twin Towers',[350,170,300,660,'rectangle'],[[180,220,100,560,'voiceBars',0],[720,220,100,560,'voiceBars',0]],'Stand in the sound.'],
 ['Sidecar Studio',[70,230,480,580,'rectangle'],[[610,250,320,130,'voiceBars',0],[610,440,320,130,'voiceBars',0],[610,630,320,130,'voiceBars',0]],'Room for every thought.'],
 ['Cinema Rails',[90,260,820,480,'rectangle'],[[60,140,880,100,'voiceBars',0],[60,760,880,100,'voiceBars',0]],'Your voice, widescreen.'],
 ['Sound Below',[270,150,460,360,'rectangle'],[[100,570,800,290,'voiceBars',0]],'Let the sound take the floor.'],
 ['Right of Reply',[600,230,330,570,'rectangle'],[[70,290,450,420,'voiceRing',2]],'Make a statement.'],
 ['Corner Lights',[340,330,320,340,'rectangle'],[[230,210,230,260,'voiceRing',8],[540,210,230,260,'voiceRing',8],[230,530,230,260,'voiceRing',8],[540,530,230,260,'voiceRing',8]],'Four corners. One presence.'],
 ['Lower Third',[80,590,240,270,'circle'],[[380,610,540,210,'voiceBars',0]],'Keep the room moving.'],
 ['Orbital Stack',[390,340,220,330,'circle'],[[230,210,430,560,'voiceRing',1],[370,210,430,560,'voiceRing',11],[310,300,430,560,'voiceRing',3]],'In your orbit.'],
 ['Audio Canopy',[310,490,380,370,'rectangle'],[[120,180,760,250,'voiceBars',0]],'A voice worth following.'],
 ['Split Signal',[100,190,330,630,'rectangle'],[[520,190,130,630,'voiceBars',0],[730,190,130,630,'voiceBars',0]],'Across the divide.'],
 ['Spotlight Badge',[650,600,240,280,'circle'],[[120,220,490,560,'voiceRing',12]],'Make every beat count.'],
 ['Crossfade',[380,380,240,270,'rectangle'],[[90,270,270,170,'voiceBars',0],[640,570,270,170,'voiceBars',0],[370,140,260,180,'voiceRing',13]],'Find a new angle.'],
 ['The Sound Desk',[100,280,380,480,'rectangle'],[[530,280,360,280,'voiceRing',14],[530,660,360,130,'voiceBars',0]],'Your daily frequency.'],
];
const palettes=[['#080e1b','#244a77','#65f6dc','#b0baff'],['#071a1b','#135d62','#65fff0','#efffba'],['#190e0b','#8c2b13','#ffad38','#fff0ad'],['#170d22','#663c83','#edb1f3','#fce9dc'],['#130c1a','#622460','#fb69c8','#ffd1e6'],['#071722','#175b8c','#62cfff','#d9f6ff'],['#091710','#215f35','#84f79a','#f1ffd1'],['#100c26','#5c24b5','#ba75ff','#5df9e6'],['#1c101b','#88486a','#f7b9d3','#fff1db'],['#0c1023','#334eb1','#7aa7ff','#e2f0ff'],['#1b1510','#715632','#deb96b','#fff0c9'],['#0e1420','#455e79','#c5d4ed','#f9b6a3'],['#200c12','#8a2339','#ff718c','#ffd1c1'],['#14121c','#50495f','#c1b2d9','#f3e9ff'],['#101626','#3c55a0','#89e8f5','#f2a2e9']];
const layouts=[];
for(const [i,[name,host,surfaces,tagline]] of designs.entries())for(const portrait of [false,true]){
 const width=portrait?1080:1920,height=portrait?1920:1080,[background,...colors]=palettes[i],id=`style-${i+1}-${portrait?'portrait':'landscape'}`;
 const geom=([x,y,w,h])=>({position:'absolute',left:Math.round(x*width/1000),top:Math.round(y*height/1000),width:Math.round(w*width/1000),height:Math.round(h*height/1000)});
 const hostGeometry=geom(host);if(host[4]==='circle'){const size=Math.min(hostGeometry.width,hostGeometry.height);hostGeometry.left+=(hostGeometry.width-size)/2;hostGeometry.top+=(hostGeometry.height-size)/2;hostGeometry.width=hostGeometry.height=size;}
 const shaders=surfaces.map((s,index)=>{const geometry=geom(s);if(s[4]==='voiceRing'){const side=Math.min(geometry.width,geometry.height);geometry.left+=(geometry.width-side)/2;geometry.top+=(geometry.height-side)/2;geometry.width=geometry.height=side;}return{id:`visual-${index}`,type:'shader',styles:geometry,shader:{effect:s[4],...(s[4]==='voiceRing'?{variant:s[5]}:{}),colors,speed:1.6,intensity:1.5,scale:[.6,1.8,.4,2.5,1.2,.7,1.4,.8,2,1.1,3,.5,1.7,2.2,.9][i],opacity:i===9?.7:1,radius:s[4]==='voiceRing'?geometry.width*.27:20,quality:'medium',clock:'show',glow:.65,bindings:{intensity:{get:'values.sensitivity'},speed:{get:'values.motion'},glow:{get:'values.glow'}}}};});
 // The border halo has generous padding around its own camera, in both orientations.
 if(i===0){const pad=portrait?90:75,side=hostGeometry.width+pad*2;shaders[0].styles={position:'absolute',left:hostGeometry.left-pad,top:hostGeometry.top-pad,width:side,height:side};shaders[0].shader.radius=hostGeometry.width/2;}
 const text=(id,text,y,size,color)=>({id,type:'text',text,styles:{...geom([50,y,900,65]),fontSize:size,fontWeight:600,color,textAlign:'center'}});
 layouts.push({id,label:`${String(i+1).padStart(2,'0')} · ${name} · ${portrait?'Portrait':'Landscape'}`,width,height,root:{id:'gallery-root',type:'box',styles:{position:'relative',width,height,background,overflow:'hidden'},children:[...shaders,text('collection',{get:'values.title'},35,portrait?23:20,colors[1]),text('headline',`${String(i+1).padStart(2,'0')} / ${name}`,95,portrait?48:42,colors[2]),{id:'host-camera',type:'slot',slotId:'host',styles:hostGeometry,framing:{mode:'fill',x:.5,y:.5},appearance:{shape:host[4],cornerRadius:i===2?Math.min(hostGeometry.width,hostGeometry.height)/2:24,outlineWidth:2,outlineColor:colors[1],grayscale:0,opacity:1}},text('tagline',tagline,920,portrait?28:24,colors[2])]}});
}
const fields=[['sensitivity','Sensitivity',1.5,0,2],['motion','Motion',1.6,0,4],['glow','Glow',.65,0,1]],controls=[{id:'title',type:'text',label:'Collection title',key:'title'},...fields.map(([id,label])=>({id,type:'number',label,key:id})),...layouts.map(l=>({id:l.id,type:'button',label:l.label,action:{type:'layout.select',layoutId:l.id}}))];
const sections=[{id:'visuals',label:'Voice visuals',controls:['set:sensitivity','set:motion','set:glow','set:title']}];
for(const portrait of [false,true])for(let group=0;group<3;group++)sections.push({id:`${portrait?'portrait':'landscape'}-${group+1}`,label:`${portrait?'Portrait':'Landscape'} · ${group*5+1}–${group*5+5}`,collapsed:portrait||group>0,controls:layouts.filter(l=>l.id.endsWith(portrait?'portrait':'landscape')).slice(group*5,group*5+5).map(l=>`set:${l.id}`)});
writeFileSync('docs/shows/voice-gallery.json',JSON.stringify({schema:'producer.presentation/2',id:'voice-gallery',version:'2.0.0',name:'Voice Collection · 15 Compositions',set:{initialLayout:layouts[2].id,values:{title:{type:'text',default:'THE VOICE COLLECTION',maxLength:60},...Object.fromEntries(fields.map(([key,,value,min,max])=>[key,{type:'number',default:value,min,max}]))},feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},controls,controlArrangement:{sections,minimized:['set:sensitivity','set:motion','set:glow']},layouts}},null,2)+'\n');
console.log(`Wrote ${layouts.length} layouts with distinct host/audio topologies.`);
