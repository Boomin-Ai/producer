import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

// Exercise real HTML modal/top-layer behavior without Tauri or user accounts.
const playwrightModule=process.env.PRODUCER_PLAYWRIGHT_MODULE||'playwright';
const {chromium}=await import(isAbsolute(playwrightModule)?pathToFileURL(playwrightModule).href:playwrightModule);
const bundle=await build({entryPoints:['src/lib/stageCutouts.ts'],bundle:true,write:false,format:'iife',globalName:'StageCutouts',plugins:[{
 name:'native-preview-bridge',setup(b){b.onResolve({filter:/^\.\/ipc$/},()=>({path:'ipc',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const ipc={livePreviewCutouts:async rects=>{window.cutouts=rects;window.cutoutUpdates.push(rects)}}'}));},
}]});
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_CHROME_PATH?{executablePath:process.env.PRODUCER_CHROME_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:1280,height:720}});
 const until=(fn,arg)=>page.waitForFunction(fn,arg,{polling:20});
 await page.setContent('<style>dialog{width:400px;height:240px}.rm-pop{position:fixed;left:10.5px;top:20.25px;width:100.75px;height:50.5px}</style><div class="rm-pop"></div><dialog class="set-preview-dialog"><button>Close editor</button></dialog>');
 await page.evaluate(()=>{window.cutoutUpdates=[];window.requestAnimationFrame=()=>0;});
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 await page.evaluate(()=>StageCutouts.installStageCutouts());
 const full=async(w=1280,h=720)=>{await until(([w,h])=>window.cutouts?.length===1&&window.cutouts[0].x===0&&window.cutouts[0].y===0&&window.cutouts[0].w===w&&window.cutouts[0].h===h,[w,h]);};
 const partial=async()=>{await until(()=>window.cutouts?.[0]?.x===10);assert.deepEqual(await page.evaluate(()=>window.cutouts[0]),{x:10,y:20,w:102,h:51});};
 await partial();
 for(let n=0;n<8;n++){
  await page.evaluate(()=>document.querySelector('dialog').showModal());await full();
  await page.evaluate(()=>document.querySelector('dialog').close());await partial();
 }
 // Non-modal native dialogs still clip their own bounds, not the whole stage.
 await page.evaluate(()=>document.querySelector('dialog').show());
 await until(()=>window.cutouts?.length===2);
 await page.evaluate(()=>document.querySelector('dialog').close());await partial();
 // A modal wins even when earlier ordinary overlays exceed the native limit.
 await page.evaluate(()=>{for(let n=0;n<20;n++)document.body.insertAdjacentHTML('afterbegin','<div class="rm-pop"></div>');document.querySelector('dialog').showModal();});await full();
 await page.setViewportSize({width:1000,height:700});await full(1000,700);
 await page.evaluate(()=>document.querySelector('dialog').remove());
 await until(()=>window.cutouts?.length===16&&window.cutouts[0].x===10);
 await page.evaluate(()=>{document.querySelectorAll('.rm-pop').forEach(el=>el.remove());document.body.insertAdjacentHTML('beforeend','<div role="dialog" aria-modal="true" style="width:300px;height:200px"></div>');});await full(1000,700);
 await page.evaluate(()=>document.querySelector('[role="dialog"]').setAttribute('aria-modal','false'));
 await until(()=>window.cutouts?.length===1&&window.cutouts[0].w===300);
 await page.evaluate(()=>document.querySelector('[role="dialog"]').remove());await until(()=>window.cutouts?.length===0);
 console.log('PASS: modal/backdrop clipping, 8 open/close cycles, implicit dialogs, late mount/removal, overflow priority, resize and occluded-frame scheduling.');
}finally{await browser.close();}
