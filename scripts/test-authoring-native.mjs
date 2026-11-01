// Isolated OBS acceptance for an authored package; no real camera/mic or recording.
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{package:{type:'string'},output:{type:'string'},reactive:{type:'boolean'}}});
if(!values.package)throw Error('Pass --package FILE; optionally --reactive for a Set with voice rings.');
const output=resolve(values.output??'target/authoring-native');await mkdir(output,{recursive:true});
const plans=await mkdtemp(join(output,'plans-')),sourceText=await readFile(values.package,'utf8');
const sourceDocument=JSON.parse(sourceText),syntheticCamera=!!sourceDocument.set.slots.length;
const manifest={status:'running',packageSha256:createHash('sha256').update(sourceText).digest('hex'),startedAt:new Date().toISOString(),syntheticCamera,staticHostAsset:!syntheticCamera&&sourceDocument.set.assets?.headshot?'asset:headshot':null,syntheticAudio:!!values.reactive,physicalDevicesTested:false,recordingTested:false};
await writeFile(join(output,'run.json'),JSON.stringify(manifest,null,2));
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto(process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/');
 const document=JSON.parse(sourceText);
 for(const layout of document.set.layouts){
  const plan=await page.evaluate(async({doc,id})=>{
   const {parsePackage}=await import('/src/features/presentation/schema.ts');
   const {RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
   const {outputProjection}=await import('/src/features/presentation/projection.ts');
   const {compileRoomScene}=await import('/src/features/sets-v2/roomCompiler.ts');
   const pkg=parsePackage(doc),session=new RehearsalSession(pkg,undefined,'prepare');
   const p=outputProjection(pkg,{...session.snapshot(),layoutId:id});p.timeline=undefined;
   return compileRoomScene(p,{definitionId:pkg.id,instanceId:'authoring-native-proof',canvasId:id,target:{id,orientation:p.width>p.height?'landscape':'portrait',width:p.width,height:p.height,scaling:'contain'},bindings:Object.fromEntries(pkg.set.slots.map(s=>[s.id,'synthetic-camera']))});
  },{doc:document,id:layout.id});
  await writeFile(join(plans,layout.id+'.json'),JSON.stringify(plan));
 }
}finally{await browser.close();}
const child=spawn('bash',['scripts/sets-v2/run-native-probe.sh'],{stdio:'inherit',env:{...process.env,PRODUCER_PROBE_OUTPUT:output,PRODUCER_ROOM_FIXTURES:plans,PRODUCER_PROBE_SHOWCASE_ONLY:'1',PRODUCER_PROBE_SHOWCASE_FOCUS:'1',PRODUCER_PROBE_DYNAMIC_SHOWCASE:'1',...(!syntheticCamera?{PRODUCER_PROBE_STATIC_AUTHORING:'1'}:{}),...(manifest.staticHostAsset?{PRODUCER_PROBE_HOST_ASSET:manifest.staticHostAsset}:{}),...(values.reactive?{PRODUCER_PROBE_REACTIVE:'1'}:{})}});
const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>resolve(code??1));});
if(code!==0)process.exitCode=Number(code);
await writeFile(join(output,'run.json'),JSON.stringify({...manifest,status:code===0?'passed':'failed',finishedAt:new Date().toISOString(),exitCode:code},null,2));
