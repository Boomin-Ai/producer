import fs from 'node:fs';
import {studio} from './make-studio.mjs';
const original=JSON.parse(fs.readFileSync('docs/shows/head-to-head-grand-arena.json'));
const d=structuredClone(original);d.id='grand-arena-3d-study';d.name='Grand Arena — 3D Studio';d.version="0.1.0";delete d.show;d.set.assets={};d.set.components={};d.set.controls=[];d.set.slots=d.set.slots.filter(s=>['host','guest'].includes(s.id));
// The visual renderer receives public module output. It has no Arena logic.
const state={directionSequence:{type:'number',default:0,min:0,max:1000000},lighting:{type:'text',default:'neutral',maxLength:64},cameraView:{type:'text',default:'wide',maxLength:64}};
const definitions={...d.runtime.definitions};
const actions={},controls=[];
for(const[id,label,field,value]of[['neutral','Face-off','lighting','neutral'],['hostFloor','Host’s floor','lighting','host-floor'],['guestFloor','Challenger’s floor','lighting','guest-floor'],['wide','Wide studio','cameraView','wide'],['closer','Stage push','cameraView','closer'],['revealEmblem','Reveal emblem','lighting','reveal-emblem']]){actions[id]={roles:['operator'],steps:[{op:'set',field,value},{op:'add',field:'directionSequence',value:1}]};controls.push({id,type:'button',label,action:id});}
definitions.studio={label:'Studio direction',state,publicFields:['lighting','cameraView','directionSequence'],actions,controls:[{id:'direction',label:'Lighting and framing',audience:'operator',controls}],capabilities:[]};
d.runtime={schema:'producer.modules/1',definitions:{studio:definitions.studio,scoring:definitions.scoring},instances:['studio','scoring'].map(id=>({id,definition:id,owner:'set',hidden:'continue',onExit:'continue',reenter:'resume'}))};
const rect=(left,top,width,height)=>({position:'absolute',left,top,width,height});
const text=(id,value,b,size=24,color='#e6e9e8',align='left',weight=500)=>({id,type:'text',text:value,styles:{...rect(...b),fontFamily:'Arial, sans-serif',fontSize:size,fontWeight:weight,color,textAlign:align,lineHeight:1.15,overflow:'hidden'}});
d.set.layouts=[false,true].map(p=>{
 const w=p?1080:1920,h=p?1920:1080,world=studio(p),style=rect(0,0,w,h);
 const layers=pass=>({id:'studio-'+pass,type:'scene3d',styles:style,scene3d:{id:'studio',pass,world,cue:{get:'modules.studio.lighting'},view:{get:'modules.studio.cameraView'},cueSequence:{get:'modules.studio.directionSequence'}}});
 const children=[layers('background')];
 for(const[i,slot]of world.slots.entries()){
  const b=[slot[0]*w,slot[1]*h,slot[2]*w,slot[3]*h];
  children.push({id:'well-'+i,type:'box',styles:{...rect(...b),background:'#080f18'},children:[]});
  children.push({id:'camera-'+i,type:'slot',slotId:i===0?'host':'guest',styles:rect(...b)});
  children.push(text('name-'+i,{get:i===0?'values.hostName':'values.guestName'},[b[0],b[1]+b[3]+22,b[2],44],p?32:26,i?'#e4c28b':'#a2cbef'));
  children.push(text('role-'+i,i===0?'HOST / THE BLUE SIDE':'CHALLENGER / THE GOLD SIDE',[b[0],b[1]+b[3]+68,b[2],30],p?20:14,'#8f9ba6'));
 }
 children.push(layers('foreground'));
 children.push(text('brand','HEAD TO HEAD',p?[98,88,880,70]:[124,72,1100,68],p?54:48,'#ecece8','left',800));
 children.push(text('edition','T H E   G R A N D   A R E N A',p?[100,165,880,32]:[127,143,1100,30],p?19:15,'#b8ac92'));
 children.push(text('topic',{get:'values.topic'},p?[98,260,884,160]:[300,222,1320,90],p?42:36,'#f1eee5','center',600));
 if(!p)children.push({...text('versus','VS',[878,508,164,64],38,'#c5b393','center',600),when:{op:'if',args:[{op:'eq',args:[{get:'modules.studio.lighting'},'reveal-emblem']},false,true]}});
 children.push(text('footer','TWO VOICES. ONE VERDICT.',p?[100,1850,880,30]:[124,1014,1672,30],p?22:17,'#b6b8b6','center',600));
 children.push(text('host-points',{get:'modules.scoring.hostScore'},p?[98,1770,340,60]:[124,913,600,60],p?56:48,'#a2cbef','center',700));
 children.push(text('guest-points',{get:'modules.scoring.guestScore'},p?[642,1770,340,60]:[1196,913,600,60],p?56:48,'#e4c28b','center',700));
 return {id:p?'studio-portrait':'studio-landscape',label:p?'Face-off / Portrait':'Face-off / Landscape',width:w,height:h,root:{id:'studio-root',type:'box',styles:{position:'relative',width:w,height:h,overflow:'hidden'},children}};
});
d.set.initialLayout='studio-landscape';
fs.writeFileSync('docs/shows/grand-arena-3d-study.json',JSON.stringify(d,null,2)+'\n');
