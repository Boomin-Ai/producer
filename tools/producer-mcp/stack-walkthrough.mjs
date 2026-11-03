// One shared selection drives both output orientations.
export function stackWalkthrough(plan){
 const doc=plan.package,V=key=>({get:'values.'+key}),eq=value=>({op:'eq',args:[V('stackFocus'),value]}),iff=(test,yes,no)=>({op:'if',args:[test,yes,no]});
 const products=[['frontend','Workers Static Assets','Serves your website’s HTML, CSS, JavaScript and images.'],['compute','Workers','Runs your backend code and handles requests.'],['database','D1','Stores structured app data in a managed SQL database.'],['storage','R2','Stores uploads, images, documents and other files.'],['ai','Workers AI','Runs AI models through an API or Worker.'],['security','Access / WAF','Access restricts app access. WAF filters harmful web requests.']];
 doc.set.values.stackFocus={type:'text',default:'',maxLength:20};
 for(const [id,label,description]of products){doc.set.controls.push({id:'explain-'+id,type:'button',label,action:{type:'value.set',key:'stackFocus',value:id}});doc.set.values['explain-'+id]={type:'text',default:description,maxLength:120};}
 doc.set.controls.push({id:'explain-none',type:'button',label:'Hide descriptions',action:{type:'value.set',key:'stackFocus',value:''}});
 doc.set.controlArrangement.sections.splice(1,0,{id:'stack-walkthrough',label:'Product walkthrough',controls:[...products.map(([id])=>'set:explain-'+id),'set:explain-none']});
 for(const l of doc.set.layouts.filter(l=>l.id.startsWith('why-'))){
  const p=l.height>l.width;
  products.forEach(([id],i)=>{
   const card=l.root.children.find(n=>n.id==='stack-'+i),selected=eq(id),base=p?730+i*142:490+Math.floor(i/3)*220;
   const above=p?products.slice(0,i):i>=3?products.slice(0,3):[];
   card.styles.top=above.reduceRight((rest,[key])=>iff(eq(key),base+(p?80:70),rest),base);
   card.styles.height=iff(selected,p?204:265,p?124:195);
   card.styles.background=iff(selected,'linear-gradient(115deg,#152F49,#17415f 62%,#0B1D30)','linear-gradient(135deg,#152F49eb,#0B1D30f5 65%,#030B16fa)');
   card.styles.border=iff(selected,'2px solid #36DFFF','1px solid #36DFFF55');card.styles.boxShadow=iff(selected,'inset 0 0 24px #36DFFF20','inset 0 1px 0 #EAF4FF18');
   const product=card.children.find(node=>node.id==='stack-product-'+i);product.styles.height=p?48:50;
   card.children.push({id:'stack-description-'+i,type:'text',when:selected,text:V('explain-'+id),styles:{position:'absolute',left:116,top:p?118:145,width:Number(card.styles.width)-145,height:p?76:105,fontFamily:'Arial, sans-serif',fontSize:p?27:22,fontWeight:500,lineHeight:1.1,whiteSpace:'pre-wrap',overflow:'hidden',color:'#EAF4FFcc'}});
  });
  l.animation.tracks=l.animation.tracks.filter(t=>!(t.property==='y'&&/^stack-\d$/.test(t.target)));
 }
 return plan;
}
