import fs from 'node:fs';
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1436/');
 const plans=await page.evaluate(async()=>{
  const {parsePackage}=await import('/src/features/presentation/schema.ts'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts'),{outputProjection}=await import('/src/features/presentation/projection.ts'),{compileRoomScene}=await import('/src/features/sets-v2/roomCompiler.ts');
  const rect=(left,top,width,height)=>({position:'absolute',left,top,width,height});
  const doc=parsePackage({schema:'producer.presentation/2',id:'pooled-graphics',name:'Graphics cache',version:'1.0.0',set:{initialLayout:'main',values:{caption:{type:'text',default:'NOW',maxLength:60}},feeds:{},slots:[{id:'host',label:'Host'}],components:{},controls:[],layouts:[{id:'main',label:'Main',width:640,height:360,root:{id:'root',type:'box',styles:{position:'relative',width:640,height:360},children:[{id:'header',type:'text',text:'PERMANENT HEADER',styles:{...rect(0,0,640,60),background:'#224466',color:'#ffffff',fontSize:30}},{id:'host',type:'slot',slotId:'host',styles:rect(400,70,200,200)},{id:'caption',type:'text',text:{get:'values.caption'},styles:{...rect(0,280,640,80),background:'#662244',color:'#ffffff',fontSize:40}}]}}]}});
  const session=new RehearsalSession(doc);const plans=[];
  for(const text of ['NOW','TODAY','TODAY']){session.send({type:'field',key:'caption',value:text});plans.push(await compileRoomScene(outputProjection(doc,session.snapshot()),{definitionId:doc.id,instanceId:'graphics-proof',canvasId:'main',target:{id:'program',orientation:'landscape',width:640,height:360,scaling:'contain'},bindings:{host:'synthetic-camera'}}));}return plans;
 });
 fs.mkdirSync('/private/tmp/producer-graphics-cache-proof',{recursive:true});for(let i=0;i<plans.length;i++)fs.writeFileSync('/private/tmp/producer-graphics-cache-proof/plan-'+i+'.json',JSON.stringify(plans[i]));
 console.log('PASS compiled real graphics-cache fixture');
}finally{await browser.close();}
