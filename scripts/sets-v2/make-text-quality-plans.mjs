import fs from 'node:fs';
import path from 'node:path';
const out=process.argv[2];fs.mkdirSync(out,{recursive:true});
const n=(id,kind,x,y,width,height,properties={},children=[])=>({id,kind,bounds:{x,y,width,height},properties,children,...(kind==='graphic'?{resource:'graphic:fixture'}:{})});
const nodes=[n('title','text',0,0,1760,66,{text:'PRODUCER / 1080P TEXT',fontSize:52,fontWeight:700,color:'#f2f5f7'}),n('description','text',0,78,1760,32,{text:'Identical typography. Native 1920 × 1080 output. Compare at 100% zoom.',fontSize:21,color:'#aeb9c6'})];
for(const [index,x,bg,fg,muted] of [[0,0,'#1b2838','#f1f4f7','#a6b7c7'],[1,920,'#f2efe6','#182433','#5c6877']]){
 nodes.push(n('panel'+index,'graphic',x,134,840,650,{background:bg}));
 nodes.push(n('theme'+index,'text',x+28,158,784,32,{text:index?'LIGHT / ARIAL':'DARK / ARIAL',fontSize:18,fontWeight:700,color:muted}));
 for(const [row,y,size,text,weight] of [[0,213,12,'12 px  •  Small labels / Atlanta, GA / 0123456789',400],[1,248,14,'14 px  •  LOCAL NEWS / 7 SEGMENTS / ON AIR',400],[2,292,18,'18 px  •  Your sources are ready. Let’s go live.',400],[3,346,24,'24 px  •  The local perspective.',400],[4,410,32,'32 px  •  Clear conversation.',400],[5,487,44,'Every detail matters.',700],[6,566,22,'62% audience vote   /   01:28   /   LIVE',700]]){
  nodes.push(n('text'+index+'-'+row,'text',x+28+(row===2?.25:0),y,784,Math.ceil(size*1.4),{text,fontSize:size,fontWeight:weight,color:fg}));
 }
 nodes.push(n('rule'+index,'graphic',x+28,626,784,1,{background:muted}));
 nodes.push(n('symbols'+index,'text',x+28,656,784,64,{text:'Aa Bb  /  1Il  0O  @  123456789',fontSize:28,color:fg}));
 nodes.push(n('note'+index,'text',x+28,735,784,24,{text:'Native glyph edges, fine stems and round letterforms',fontSize:14,color:muted}));
}
fs.writeFileSync(path.join(out,'text-quality-nodes.json'),JSON.stringify(n('root','group',0,0,1760,800,{},nodes)));
const root=n('root','group',0,0,1920,1080,{},[n('text-source','source',0,0,1920,1080)]);root.children[0].resource='synthetic-camera';root.children[0].fit='contain';
const plan={definitionId:'text-quality',definitionRevision:1,instanceId:'quality',canvasId:'landscape',target:{id:'program',orientation:'landscape',width:1920,height:1080,scaling:'contain'},viewport:{scaleX:1,scaleY:1,offsetX:0,offsetY:0,clip:{x:0,y:0,width:1920,height:1080}},root,resources:['synthetic-camera']};
fs.writeFileSync(path.join(out,'text-quality-plan.json'),JSON.stringify(plan));
