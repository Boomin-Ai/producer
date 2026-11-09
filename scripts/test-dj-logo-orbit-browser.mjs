import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
Error.stackTraceLimit=0;
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright');
const out=process.env.PRODUCER_LOGO_PROOF_DIR??await mkdtemp(join(tmpdir(),'producer-logo-orbit-'));await mkdir(out,{recursive:true});
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDaMAAAAASUVORK5CYII=';
let world={schema:'producer.scene3d/1',fps:30,clearColor:'#000000',fog:{color:'#000000',near:10,far:100},camera:{position:[0,0,10],target:[0,0,0],fov:45},objects:[],slots:[],dj:{role:'logoOrbit',logoOrbit:{title:'360 DEAL',subtitle:'THE NEW',ink:'#171720',seconds:18,logos:Array.from({length:13},(_,i)=>({id:'logo-'+i,band:i%8,data:png}))}}};
if(process.env.PRODUCER_DJ_LOGO_SET){const doc=JSON.parse(await readFile(process.env.PRODUCER_DJ_LOGO_SET,'utf8'));world=doc.set.layouts.find(l=>l.id==='cover-portrait').root.children.find(n=>n.type==='scene3d').scene3d.world;}
const script=await readFile(new URL('../src/features/presentation/vendor/scene3d-renderer.js',import.meta.url),'utf8');
const file=join(out,'logo-orbit.html');await writeFile(file,'<!doctype html><body style="margin:0;background:#fff8ed"><canvas id="scene"></canvas></body>');
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_CHROME?{executablePath:process.env.PRODUCER_CHROME}:{})});
try{
 const page=await browser.newPage({viewport:{width:1100,height:400}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(pathToFileURL(file).href);await page.addScriptTag({content:script});
 await page.evaluate(async world=>{window.control={revision:1,anchor:Date.now(),elapsed:0,paused:false,cue:'neutral',music:{sensitivity:1,intensity:1,waveform:'line',waveHeight:1,drop:0,money:false,color:'#171720',motion:1,soundPopups:false}};window.orbit=await ProducerScene3d.mountWorld(document.querySelector('canvas'),world,{width:1100,height:390,pass:'foreground',control:window.control});},world);
 await page.waitForFunction(()=>window.orbit.status().ready);const silent=await page.evaluate(()=>window.orbit.status());assert.equal(silent.music.logos.length,13);assert.ok(silent.music.logos.every(l=>l.strength===0));await page.locator('canvas').screenshot({path:join(out,'silent.png')});
 await page.evaluate(()=>{window.feed=setInterval(()=>window.orbit.audio({energy:.9,bass:.9,high:.6,bands:[1,.1,.8,.15,.7,.2,.6,.3],wave:Array.from({length:32},(_,i)=>Math.sin(i*.6))}),16);});
 await page.waitForFunction(()=>window.orbit.status().music.logos.some(l=>l.strength>.8));await page.waitForTimeout(150);const beat=await page.evaluate(()=>window.orbit.status());assert.ok(beat.music.logos.filter(l=>l.band===0).every(l=>l.size>silent.music.logos[0].size*1.25));assert.ok(beat.music.logos.find(l=>l.band===0).strength>beat.music.logos.find(l=>l.band===1).strength*3);await page.locator('canvas').screenshot({path:join(out,'music-reactive.png')});
 await page.evaluate(()=>{window.control={...window.control,revision:2,music:{...window.control.music,intensity:0}};window.orbit.update(window.control);});await page.waitForTimeout(100);const off=await page.evaluate(()=>window.orbit.status());assert.ok(off.music.logos.every(l=>l.strength===0));
 await page.evaluate(()=>{window.control={...window.control,revision:3,music:{...window.control.music,intensity:1}};window.orbit.update(window.control);clearInterval(window.feed);});await page.waitForTimeout(1400);const stale=await page.evaluate(()=>window.orbit.status());assert.ok(stale.music.logos.every(l=>l.strength<.005));assert.equal(stale.music.energy,0);
 await page.evaluate(()=>window.orbit.dispose());const disposed=await page.evaluate(()=>window.orbit.status());await page.waitForTimeout(150);assert.equal((await page.evaluate(()=>window.orbit.status())).frames,disposed.frames);assert.deepEqual(errors,[]);
 const report={ok:true,logos:13,checks:['actual WebGL images decoded','individual DJ bands change logo scale','stale/silent audio settles','response off suppresses pulses','dispose stops drawing'],scope:'Renderer with injected DJ analysis frames; installed app/native DJ path not exercised',silent,beat,stale};await writeFile(join(out,'proof.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,logos:13,out}));
}finally{await browser.close();}
