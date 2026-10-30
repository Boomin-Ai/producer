import {writeFileSync} from 'node:fs';
const g=(left,top,width,height)=>({position:'absolute',left,top,width,height});
const text=(id,value,left,top,width,height,fontSize,color='#f4f4f2',fontWeight=600)=>({id,type:'text',text:value,styles:{...g(left,top,width,height),fontSize,fontWeight,color}});
const fields={topic:{type:'text',default:'THE COST OF ATTENTION',maxLength:60},host:{type:'text',default:'KLEVELAND',maxLength:40},sensitivity:{type:'number',default:.85,min:0,max:2},motion:{type:'number',default:.6,min:0,max:4}};
const layouts=[false,true].map(p=>{
 const width=p?1080:1920,height=p?1920:1080,size=p?740:650,x=p?170:160,y=p?550:265,pad=90;
 const heading=p?[76,1480,928,200,76]:[1030,410,790,250,86];
 return{id:p?'portrait':'landscape',label:p?'Cover · Portrait':'Cover · Landscape',width,height,root:{id:'cover',type:'box',styles:{position:'relative',width,height,background:'#0b0b0c',overflow:'hidden'},children:[
 {id:'voice-contour',type:'shader',styles:g(x-pad,y-pad,size+pad*2,size+pad*2),shader:{effect:'voiceRing',variant:15,colors:['#f4f4f2','#f4f4f2','#f4f4f2'],speed:.6,intensity:.85,scale:.4,opacity:1,radius:size/2,quality:'medium',clock:'show',glow:0,bindings:{intensity:{get:'values.sensitivity'},speed:{get:'values.motion'}}}},
 text('masthead','ATTN',p?62:78,p?90:30,p?950:830,p?285:205,p?242:180,'#f4f4f2',800),
 text('brand','IS CURRENCY',p?74:1020,p?350:96,p?900:750,p?85:76,p?46:54,'#f4f4f2',700),
 {id:'top-rule',type:'box',styles:{...g(p?74:80,p?445:232,p?932:1760,2),background:'#444446'},children:[]},
 {id:'host-camera',type:'slot',slotId:'host',styles:g(x,y,size,size),framing:{mode:'fill',x:.5,y:.5},appearance:{shape:'circle',cornerRadius:0,outlineWidth:0,outlineColor:'#f4f4f2',grayscale:0,opacity:1}},
 text('section','MONEY / CULTURE / MUSIC',p?76:1035,p?1420:330,p?928:760,60,p?27:25,'#99999e',500),
 text('topic',{get:'values.topic'},...heading),
 {id:'bottom-rule',type:'box',styles:{...g(p?76:1035,p?1720:765,p?928:730,2),background:'#444446'},children:[]},
 text('byline','WITH',p?76:1035,p?1750:805,p?250:250,45,22,'#99999e',500),
 text('host-name',{get:'values.host'},p?76:1035,p?1800:854,p?900:730,65,p?42:38,'#f4f4f2',600),
 ]}};
});
const controls=[{id:'topic',type:'text',label:'Topic headline',key:'topic'},{id:'host',type:'text',label:'Host name',key:'host'},...['sensitivity','motion'].map(id=>({id,type:'number',label:id==='motion'?'Motion':'Sensitivity',key:id})),...layouts.map(l=>({id:l.id,type:'button',label:l.label,action:{type:'layout.select',layoutId:l.id}}))];
const doc={schema:'producer.presentation/2',id:'attention-signal',version:'1.0.1',name:'Attention Is Currency · Signal',set:{initialLayout:'landscape',values:fields,feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},controls,controlArrangement:{sections:[{id:'editorial',label:'On the cover',controls:['set:topic','set:host']},{id:'signal',label:'Voice motion',controls:['set:sensitivity','set:motion']},{id:'format',label:'Format',controls:['set:landscape','set:portrait']}],minimized:['set:topic','set:landscape','set:portrait']},layouts}};
writeFileSync('docs/shows/attention-signal.json',JSON.stringify(doc,null,2)+'\n');
