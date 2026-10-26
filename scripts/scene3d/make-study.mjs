import fs from 'node:fs';
import {studio} from './make-studio.mjs';
const original=JSON.parse(fs.readFileSync('docs/shows/head-to-head-grand-arena.json'));
const d=structuredClone(original);d.id='grand-arena-3d-study';d.name='Grand Arena — 3D Studio';d.version="0.2.0";delete d.show;d.set.assets={};d.set.components={};d.set.controls=[];d.set.slots=d.set.slots.filter(s=>['host','guest'].includes(s.id));
// The visual renderer receives public module output. It has no Arena logic.
const state={directionSequence:{type:'number',default:0,min:0,max:1000000},lighting:{type:'text',default:'neutral',maxLength:64},cameraView:{type:'text',default:'wide',maxLength:64}};
const definitions={...d.runtime.definitions};
const actions={},controls=[];
for(const[id,label,field,value]of[['neutral','Face-off','lighting','neutral'],['hostFloor','Host’s floor','lighting','host-floor'],['guestFloor','Challenger’s floor','lighting','guest-floor'],['wide','Wide studio','cameraView','wide'],['closer','Stage push','cameraView','closer'],['revealEmblem','Reveal emblem','lighting','reveal-emblem']]){actions[id]={roles:['operator'],steps:[{op:'set',field,value},{op:'add',field:'directionSequence',value:1}]};controls.push({id,type:'button',label,action:id});}
for(const [id,view]of [['neutral','faceoff'],['hostFloor','hostFocus'],['guestFloor','guestFocus'],['revealEmblem','faceoff']]){actions[id].steps.push({op:'set',field:'cameraView',value:view==='faceoff'?'wide':'closer'},{op:'view',view});}
definitions.studio={label:'Studio direction',initialView:'faceoff',views:['faceoff','hostFocus','guestFocus'],state,publicFields:['lighting','cameraView','directionSequence'],actions,controls:[{id:'direction',label:'Lighting and framing',audience:'operator',controls}],capabilities:[]};
d.runtime={schema:'producer.modules/1',definitions:{studio:definitions.studio,scoring:definitions.scoring},instances:['studio','scoring'].map(id=>({id,definition:id,owner:'set',hidden:'continue',onExit:'continue',reenter:'resume'}))};
const rect=(left,top,width,height)=>({position:'absolute',left,top,width,height});
const text=(id,value,b,size=24,color='#e6e9e8',align='left',weight=500)=>({id,type:'text',text:value,styles:{...rect(...b),fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,color,textAlign:align,lineHeight:1.15,overflow:'hidden'}});
const poses=['faceoff','hostFocus','guestFocus'];
d.set.viewController='studio';d.set.initialView='faceoff';d.set.views=Object.fromEntries(poses.map(pose=>[pose,{landscape:pose==='faceoff'?'studio-landscape':pose+'-landscape',portrait:pose==='faceoff'?'studio-portrait':pose+'-portrait'}]));
d.set.layouts=poses.flatMap(pose=>[false,true].map(p=>{
 const w=p?1080:1920,h=p?1920:1080,world=studio(p),style=rect(0,0,w,h);
 const slots=pose==='faceoff'?world.slots:p?(pose==='hostFocus'?[[.075,.23,.85,.269],[.48,.68,.44,.139]]:[[.08,.68,.44,.139],[.075,.23,.85,.269]]):(pose==='hostFocus'?[[.045,.27,.56,.56],[.715,.45,.24,.24]]:[[.045,.45,.24,.24],[.395,.27,.56,.56]]);
 // Video outlines belong to the native slot, so they follow every native transform.
 world.slots=[];world.frameStyles=[];for(const object of world.objects)object.pass='background';
 const layers=pass=>({id:'studio-'+pass,type:'scene3d',styles:style,scene3d:{id:'studio',pass,world,cue:{get:'modules.studio.lighting'},view:{get:'modules.studio.cameraView'},cueSequence:{get:'modules.studio.directionSequence'}}});
 const children=[layers('background')];
 for(const[i,slot]of slots.entries()){
  const b=[slot[0]*w,slot[1]*h,slot[2]*w,slot[3]*h];
  children.push({id:'well-'+i,type:'box',styles:{...rect(...b),background:'#080f18',border:`5px solid ${i?'#e4c28b':'#569bfa'}`},children:[]});
  children.push({id:'camera-'+i,type:'slot',slotId:i===0?'host':'guest',styles:rect(...b),appearance:{outlineWidth:5,outlineColor:i?'#e4c28b':'#569bfa',cornerRadius:3}});
  const caption=[b[0],b[1]+b[3]+20,b[2],94];
  children.push({id:'caption-'+i,type:'box',styles:rect(...caption),children:[
   text('name-'+i,{get:i===0?'values.hostName':'values.guestName'},[0,0,b[2]-100,44],p?32:26,i?'#e4c28b':'#a2cbef'),
   text('role-'+i,i===0?'HOST / THE BLUE SIDE':'CHALLENGER / THE GOLD SIDE',[0,46,b[2],30],p?20:14,'#8f9ba6'),
   text(i?'guest-points':'host-points',{get:i?'modules.scoring.guestScore':'modules.scoring.hostScore'},[b[2]-96,0,96,60],p?48:40,i?'#e4c28b':'#a2cbef','right',700)
  ]});
 }
 // Native outlines move with video; the stage and emblem share one GPU pass.
 children.push(text('brand','HEAD TO HEAD',p?[98,88,880,70]:[124,72,1100,68],p?54:48,'#ecece8','left',800));
 children.push(text('edition','T H E   G R A N D   A R E N A',p?[100,165,880,32]:[127,143,1100,30],p?19:15,'#b8ac92'));
 children.push(text('topic',{get:'values.topic'},p?[98,260,884,160]:[300,222,1320,90],p?42:36,'#f1eee5','center',600));
 if(!p&&pose==='faceoff')children.push({...text('versus','VS',[878,508,164,64],38,'#c5b393','center',600),when:{op:'if',args:[{op:'eq',args:[{get:'modules.studio.lighting'},'reveal-emblem']},false,true]}});
 children.push(text('footer','TWO VOICES. ONE VERDICT.',p?[100,1850,880,30]:[124,1014,1672,30],p?22:17,'#b6b8b6','center',600));
 return {id:d.set.views[pose][p?'portrait':'landscape'],label:(pose==='faceoff'?'Face-off':pose==='hostFocus'?'Host’s floor':'Challenger’s floor')+(p?' / Portrait':' / Landscape'),animation:{tracks:[],transition:{type:'morph',durationMs:650}},width:w,height:h,root:{id:'studio-root',type:'box',styles:{position:'relative',width:w,height:h,overflow:'hidden'},children}};
}));
d.set.initialLayout='studio-landscape';
fs.writeFileSync('docs/shows/grand-arena-3d-study.json',JSON.stringify(d,null,2)+'\n');
