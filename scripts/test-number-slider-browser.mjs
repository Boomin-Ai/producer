// Actual React range/ownership regression. All commits and room transports are fixtures.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {NumberSlider} from './src/features/presentation/NumberSlider';
 import {SetControlsPanel} from './src/features/presentation/SetControlsPanel';
 import {RehearsalSession} from './src/features/presentation/rehearsal';
 import {parsePackage,presentationJsonSchema} from './src/features/presentation/schema';
 window.__TAURI_INTERNALS__={invoke:async command=>{if(command==='set_library_list')return [];throw Error('Unexpected test native command: '+command);}};
 const owners={a:{id:'a'},b:{id:'b'}},f=window.fixture={calls:[],mode:'sync',serial:0,livePending:false};
 const root=createRoot(document.getElementById('root'));
 const initial={owner:'a',value:1,min:1,max:3,step:.01,disabled:false,pending:false,shown:true};
 function Harness({start}){
  const [props,setProps]=useState(start);window.sliderProps=props;window.update=patch=>setProps(old=>({...old,...patch}));
  const commit=value=>{
   const call={owner:props.owner,value};f.calls.push(call);
   if(f.mode==='false')return false;
   if(f.mode==='throw')throw Error('Fixture denied the change');
   if(f.mode==='async')return new Promise((resolve,reject)=>{call.resolve=resolve;call.reject=reject;});
   setProps(old=>({...old,value}));return true;
  };
  return props.shown?<NumberSlider owner={owners[props.owner]} label="Screen zoom" value={props.value} min={props.min} max={props.max} step={props.step} disabled={props.disabled} pending={props.pending} isPending={()=>f.livePending} onCommit={commit}/>:null;
 }
 window.fresh=patch=>{f.calls=[];f.mode='sync';f.livePending=false;root.render(<Harness key={++f.serial} start={{...initial,...patch}}/>);};
 window.complete=(index,accepted=true)=>{const call=f.calls[index];if(accepted&&window.sliderProps.owner===call.owner)window.update({value:call.value});call.resolve(accepted);};
 window.reject=index=>f.calls[index].reject(Error('Fixture transport rejected the change'));
 window.input=values=>{const input=document.querySelector('input[type="range"]'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const value of values){set.call(input,String(value));input.dispatchEvent(new Event('input',{bubbles:true}));}};
 window.pointerStart=()=>document.querySelector('input[type="range"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse'}));
 window.keyStart=key=>document.querySelector('input[type="range"]').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key}));
 window.release=()=>document.querySelector('input[type="range"]').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,pointerType:'mouse'}));
 window.cancel=()=>document.querySelector('input[type="range"]').dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1,pointerType:'mouse'}));
 window.keyRelease=key=>document.querySelector('input[type="range"]').dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key}));
 window.blur=()=>{const input=document.querySelector('input[type="range"]');input.focus();document.getElementById('outside').focus();};
 window.calls=()=>f.calls.map(({owner,value})=>({owner,value}));
 const packageInput={schema:'producer.presentation/2',id:'slider-proof',name:'Slider proof',version:'1.0.0',set:{initialLayout:'main',values:{zoom:{type:'number',default:1,min:1,max:3},legacy:{type:'number',default:1,min:1,max:3}},feeds:{},slots:[],components:{},controls:[{id:'zoom',type:'number',label:'Screen zoom',key:'zoom',presentation:'slider',step:.01},{id:'legacy',type:'number',label:'Legacy number',key:'legacy'}],controlArrangement:{sections:[{id:'numbers',label:'Numbers',controls:['set:zoom','set:legacy']}],minimized:[]},layouts:[{id:'main',label:'Main',width:640,height:360,root:{id:'root',type:'box',styles:{position:'relative',width:640,height:360},children:[{id:'caption',type:'text',text:{op:'concat',args:[{get:'values.zoom'},' / ',{get:'values.legacy'}]},styles:{position:'absolute',left:0,top:0,width:640,height:80,fontSize:24}}]}}]}};
 window.schemaProof=()=>{
  const valid=parsePackage(packageInput),rejected=[];
  for(const patch of [{step:0},{step:-.01},{step:1e9},{step:3},{presentation:'knob'}]){const doc=structuredClone(packageInput);Object.assign(doc.set.controls[0],patch);try{parsePackage(doc);rejected.push(false);}catch{rejected.push(true);}}
  const equal=structuredClone(packageInput);equal.set.values.zoom.max=1;try{parsePackage(equal);rejected.push(false);}catch{rejected.push(true);}
  return {control:valid.set.controls[0],legacy:valid.set.controls[1],rejected,schema:presentationJsonSchema};
 };
 window.panel=authoritative=>{const session=new RehearsalSession(parsePackage(packageInput),undefined,authoritative?'live':'prepare');if(authoritative)session.attachControlTransport(async()=>({status:'accepted'}),true);root.render(<SetControlsPanel key={++f.serial} session={session} onChange={()=>{}}/>);};
 window.dispose=()=>root.unmount();window.fresh({});
 `},bundle:true,format:'iife',platform:'browser',write:false,loader:{'.css':'empty'},define:{'import.meta.env.DEV':'false'},plugins:[{name:'vite-raw-imports',setup(build){build.onResolve({filter:/\?raw$/},args=>({path:resolve(args.resolveDir,args.path.replace(/\?raw$/,'')),namespace:'raw'}));build.onLoad({filter:/.*/,namespace:'raw'},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));}}]});
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
try{
 const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const fixtureURL='http://127.0.0.1:17395/number-slider-fixture';
 await page.route('**/*',route=>route.request().url()===fixtureURL?route.fulfill({contentType:'text/html',body:'<!doctype html><div id="root"></div><button id="outside">Outside</button>'}):route.abort());
 // An intercepted localhost document supplies normal secure-context UUID and
 // storage APIs. Every request is fulfilled/aborted here; no server is contacted.
 await page.goto(fixtureURL);await page.addScriptTag({content:bundle.outputFiles[0].text});
 const slider=page.getByRole('slider',{name:'Screen zoom',exact:true});await slider.waitFor();
 const fresh=async(patch={})=>{await page.evaluate(patch=>window.fresh(patch),patch);await slider.waitFor();await page.waitForTimeout(25);};
 const calls=()=>page.evaluate(()=>window.calls());
 const release=async(value,kind='pointer')=>{await page.evaluate(({value,kind})=>{if(kind==='keyboard')window.keyStart('ArrowRight');else window.pointerStart();window.input([value]);if(kind==='keyboard')window.keyRelease('ArrowRight');else if(kind==='blur')window.blur();else window.release();},{value,kind});};
 const quiet=()=>page.waitForTimeout(60);
 await page.evaluate(()=>{window.pointerStart();window.input(Array.from({length:50},(_,i)=>1+(i+1)/25));});assert.deepEqual(await calls(),[],'A drag must not mutate once per input event');
 assert.equal(await slider.inputValue(),'3');await page.evaluate(()=>window.release());await page.waitForFunction(()=>window.fixture.calls.length===1);assert.deepEqual(await calls(),[{owner:'a',value:3}]);
 await page.evaluate(()=>{window.keyRelease('ArrowRight');window.blur();});await quiet();assert.equal((await calls()).length,1,'Pointer/key/blur duplicates cannot repeat the same final commit');
 console.log('PASS: 50 real range inputs remain local; release commits exactly the final value once');

 await fresh();await release(1.4,'keyboard');await page.waitForFunction(()=>window.fixture.calls.length===1);await release(1.7,'blur');await page.waitForFunction(()=>window.fixture.calls.length===2);assert.deepEqual((await calls()).map(c=>c.value),[1.4,1.7]);
 console.log('PASS: keyboard and blur commit opt-in range edits without Apply');

 await fresh();await page.evaluate(()=>window.input([1.65]));await page.waitForFunction(()=>window.fixture.calls.length===1);await page.evaluate(()=>window.blur());await quiet();assert.deepEqual(await calls(),[{owner:'a',value:1.65}]);
 console.log('PASS: assistive-technology input without a pointer/key gesture commits once');

 await fresh({pending:true});assert.equal(await slider.isEnabled(),true);await release(1.5);await release(2.3);await page.evaluate(()=>window.update({value:1.2}));await quiet();assert.deepEqual(await calls(),[]);assert.equal(await slider.inputValue(),'2.3','Another confirmed edit must not erase a released queued value');
 await page.evaluate(()=>window.update({pending:false}));await page.waitForFunction(()=>window.fixture.calls.length===1);assert.deepEqual(await calls(),[{owner:'a',value:2.3}]);
 console.log('PASS: pending room command retains only the latest released value');

 await fresh();await page.evaluate(()=>window.fixture.livePending=true);await release(1.5);await release(2.7);await quiet();assert.deepEqual(await calls(),[],'A live pending getter must fence commits even before React updates the pending prop');
 await page.evaluate(()=>{window.fixture.livePending=false;window.update({});});await page.waitForFunction(()=>window.fixture.calls.length===1);assert.deepEqual(await calls(),[{owner:'a',value:2.7}]);await quiet();assert.equal((await calls()).length,1);
 console.log('PASS: live pending getter closes same-turn prop lag and flushes only the latest release');

 await fresh({pending:true});await release(1.8);await page.evaluate(()=>{window.pointerStart();window.input([2.6]);window.cancel();window.blur();window.update({pending:false});});await quiet();assert.deepEqual(await calls(),[]);assert.equal(await slider.inputValue(),'1');
 console.log('PASS: pointer cancellation clears queued/dragged intent and blur cannot revive it');

 await fresh();await page.evaluate(()=>window.fixture.mode='async');await release(1.5);await page.waitForFunction(()=>window.fixture.calls.length===1);await release(1.8);await release(2.6);await quiet();assert.equal((await calls()).length,1);
 await page.evaluate(()=>window.complete(0));await page.waitForFunction(()=>window.fixture.calls.length===2);assert.deepEqual((await calls()).map(c=>c.value),[1.5,2.6]);await page.evaluate(()=>window.complete(1));await quiet();assert.equal((await calls()).length,2);
 console.log('PASS: one in-flight Promise coalesces later releases to the latest value');

 for(const cancel of ['owner','disabled','unmount']){
  await fresh({pending:true});await release(2.5);
  await page.evaluate(cancel=>window.update(cancel==='owner'?{owner:'b',value:1.1}:cancel==='disabled'?{disabled:true}:{shown:false}),cancel);await quiet();
  await page.evaluate(()=>window.update({pending:false}));await quiet();assert.deepEqual(await calls(),[],cancel+' must cancel queued intent');
  if(cancel==='disabled'){await page.evaluate(()=>window.update({disabled:false}));await quiet();assert.deepEqual(await calls(),[],'Re-enable cannot revive an old queue');}
 }
 console.log('PASS: owner replacement, disabling and unmount cancel unsent releases');

 await fresh();await page.evaluate(()=>window.fixture.mode='async');await release(1.5);await page.waitForFunction(()=>window.fixture.calls.length===1);await release(1.8);
 await page.evaluate(()=>{window.fixture.mode='sync';window.update({owner:'b',value:1.1});});await quiet();await release(2.2);await page.waitForFunction(()=>window.fixture.calls.length===2);assert.deepEqual(await calls(),[{owner:'a',value:1.5},{owner:'b',value:2.2}]);
 await page.evaluate(()=>window.complete(0));await quiet();assert.equal(await slider.inputValue(),'2.2');assert.equal((await calls()).length,2,'An old owner response cannot flush old queued work');
 console.log('PASS: new owner can commit while old Promise remains unresolved; late completion stays fenced');

 await fresh();await page.evaluate(()=>window.fixture.mode='async');await release(1.5);await page.waitForFunction(()=>window.fixture.calls.length===1);await release(2.8);await page.evaluate(()=>window.update({shown:false}));await quiet();await page.evaluate(()=>window.complete(0));await quiet();assert.equal((await calls()).length,1);
 for(const mode of ['false','throw','async']){
  await fresh();await page.evaluate(mode=>window.fixture.mode=mode,mode);await release(2);await page.waitForFunction(()=>window.fixture.calls.length===1);if(mode==='async')await page.evaluate(()=>window.reject(0));await page.getByRole('alert').waitFor();await quiet();assert.equal((await calls()).length,1,'Rejected commit must not auto-retry');
 }
 console.log('PASS: unmount fences in-flight completion; refusal and transport errors never auto-retry');

 await fresh({step:undefined});assert.equal(await slider.getAttribute('step'),'0.01');assert.equal(await slider.getAttribute('min'),'1');assert.equal(await slider.getAttribute('max'),'3');
 const proof=await page.evaluate(()=>window.schemaProof());assert.equal(proof.control.presentation,'slider');assert.equal(proof.control.step,.01);assert(!('presentation'in proof.legacy));assert(!('step'in proof.legacy));assert(proof.rejected.every(Boolean),'Reject invalid presentation/step/span');
 assert.deepEqual(proof.schema,JSON.parse(await readFile(new URL('../docs/shows/presentation.schema.json',import.meta.url),'utf8')),'Generated documentation matches canonical schema');
 console.log('PASS: slider bounds/default step and canonical/generated schema remain aligned');

 for(const authoritative of [false,true]){
  await page.evaluate(authoritative=>window.panel(authoritative),authoritative);await slider.waitFor();await page.getByRole('spinbutton',{name:'Legacy number',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Apply Screen zoom',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Apply Legacy number',exact:true}).count(),authoritative?1:0);
 }
 await page.evaluate(()=>window.dispose());assert.deepEqual(errors,[]);
 console.log('PASS: actual SetControlsPanel opts sliders in before committed fields; legacy numeric controls retain their existing local/Apply paths');
}finally{await browser.close();}
