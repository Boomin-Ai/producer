import assert from 'node:assert/strict';
import fs from 'node:fs';
import {atmosphereSample} from './sets-v2/atmosphere-sample.mjs';
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const directory='/private/tmp/atmosphere-previews';fs.mkdirSync(directory,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1510,height:1950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async sample=>{
  await import('/src/App.css');await import('/shared/set-runtime/panels.css');
  const R=await import('/node_modules/.vite/deps/react.js'),React=R.default??R,D=await import('/node_modules/.vite/deps/react-dom_client.js'),{SetPreview}=await import('/src/features/presentation/SetPreview.tsx'),{OperatorPanel}=await import('/shared/set-runtime/OperatorPanel.tsx'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts'),{weatherPayload}=await import('/shared/set-runtime/weather.ts');
  const doc=await(await fetch('/docs/shows/atmosphere.json')).json(),s=new RehearsalSession(doc,undefined,'rehearsal');window.atmosphere=s;window.weatherPayload=weatherPayload;
  await s.sendModule('sky','start');await s.sendModule('studio','start');const snapshot=s.moduleSnapshot();s.receiveModuleData({id:crypto.randomUUID(),setEpoch:snapshot.setEpoch,module:'sky',epoch:snapshot.modules.sky.epoch,op:'weather.update',input:weatherPayload(sample)});s.send({type:'control',action:{type:'layout.select',layoutId:'hero-portrait'}});
  document.body.innerHTML='<div id="atmosphere-root"></div>';
  function Surface(){const state=React.useSyncExternalStore(s.subscribe,s.snapshot),portrait=state.layoutId.endsWith('portrait');return React.createElement('main',{style:{display:'grid',gridTemplateColumns:(portrait?'1080px':'1920px')+' 390px',gap:18,background:'#0a1522'}},React.createElement('div',{id:'output'},React.createElement(SetPreview,{doc:s.package,state})),React.createElement(OperatorPanel,{definition:s.package.runtime,snapshot:s.moduleSnapshot(),segment:'',send:s.sendModule,searchWeatherLocations:async()=>[{id:'5128581',label:'New York, New York, US',latitude:40.714,longitude:-74.006,timezone:'America/New_York'}],requestAgent:async()=>{}}));}
  (D.createRoot??D.default.createRoot)(document.getElementById('atmosphere-root')).render(React.createElement(Surface));
 },atmosphereSample());
 const frame=page.frameLocator('iframe');await frame.getByText('69°F',{exact:true}).waitFor();
 const panel=page.getByRole('region',{name:'Module controls'});
 for(const orientation of ['portrait','landscape']){
  await page.setViewportSize({width:orientation==='portrait'?1510:2340,height:orientation==='portrait'?1950:1120});
  for(const pose of ['hero','split','presenter']){
   await page.evaluate(({pose,orientation})=>window.atmosphere.send({type:'control',action:{type:'layout.select',layoutId:pose+'-'+orientation}}),{pose,orientation});
   await panel.getByRole('button',{name:'Now',exact:true}).click();await frame.getByText('RIGHT NOW',{exact:true}).waitFor();await page.waitForTimeout(800);
   await page.locator('#output').screenshot({path:directory+'/'+orientation+'-'+pose+'-now.png'});
   await panel.getByRole('button',{name:'7 day',exact:true}).click();await frame.getByText('YOUR WEEK AHEAD',{exact:true}).waitFor();await page.waitForTimeout(350);
   await page.locator('#output').screenshot({path:directory+'/'+orientation+'-'+pose+'-week.png'});
   const inspection=await frame.locator('[data-node$="/forecast-panel"]').evaluate(el=>({scroll:el.scrollHeight,height:el.clientHeight}));assert(inspection.scroll<=inspection.height+2,JSON.stringify(inspection));
  }
 }
 await panel.getByRole('button',{name:'Today',exact:true}).click();await frame.locator('[data-transition="content"]').waitFor();await frame.getByText("TODAY'S FORECAST",{exact:true}).waitFor();await page.waitForTimeout(350);assert.equal(await frame.locator('[data-transition="content"]').count(),0,'content dissolve completes and releases the outgoing pixels');await page.locator('#output').screenshot({path:directory+'/landscape-presenter-today.png'});
 await panel.getByRole('button',{name:'Hourly',exact:true}).click();await frame.getByText('THE NEXT HOURS',{exact:true}).waitFor();await page.waitForTimeout(350);await page.locator('#output').screenshot({path:directory+'/landscape-presenter-hourly.png'});
 await panel.getByRole('button',{name:'Next hours',exact:true}).click();assert.equal(await page.evaluate(()=>window.atmosphere.moduleSnapshot().modules.sky.values.hourPage),1);
 await panel.getByRole('searchbox',{name:'Search city'}).fill('New York');await panel.getByRole('button',{name:'Find city',exact:true}).click();await panel.getByRole('button',{name:'New York, New York, US',exact:true}).click();assert.equal(await page.evaluate(()=>window.atmosphere.moduleSnapshot().modules.sky.weatherLocation.label),'New York, New York, US');await frame.getByText('New York',{exact:true}).waitFor();await frame.getByText('69°F',{exact:true}).waitFor({state:'hidden'});assert.equal(await frame.getByText('69°F',{exact:true}).count(),0);
 await page.evaluate(async()=>{const {outputProjection}=await import('/src/features/presentation/projection.ts'),{compileRoomScene}=await import('/src/features/sets-v2/roomCompiler.ts'),{planPasses}=await import('/src/features/sets-v2/planner.ts');for(const orientation of ['landscape','portrait'])for(const pose of ['hero','split','presenter']){window.atmosphere.send({type:'control',action:{type:'layout.select',layoutId:pose+'-'+orientation}});const p=outputProjection(window.atmosphere.package,window.atmosphere.snapshot());const plan=await compileRoomScene(p,{definitionId:'atmosphere',instanceId:'weather-browser',canvasId:pose+'-'+orientation,target:{id:orientation==='portrait'?'portrait':'program',orientation,width:orientation==='portrait'?1080:1920,height:orientation==='portrait'?1920:1080,scaling:'contain'},bindings:{host:'test-camera'}});let graphics=0;const graphicsOnly=n=>!n.backdrop&&(!n.mask||n.mask.kind==='rounded')&&['text','graphic','group'].includes(n.kind)&&(n.children??[]).every(graphicsOnly);const count=n=>{if(n.kind!=='group')return;let batch=false;for(const child of n.children){if(graphicsOnly(child)){batch=true;}else{if(batch){graphics++;batch=false;}count(child);}}if(batch)graphics++;};count(plan.root);if(graphics>12)throw Error('Atmosphere chart/label batching exceeded twelve graphics surfaces: '+graphics);planPasses(plan);}});
 assert.deepEqual(errors,[]);console.log('PASS Atmosphere real previews: six large-camera compositions, four forecast views, room city picker, no stale city values, native lowering and bounded morph tracks.');
}finally{await browser.close();}
