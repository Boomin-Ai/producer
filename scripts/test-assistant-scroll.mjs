import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 import React,{useEffect,useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
 import {AssistantTranscript} from './src/features/assistant/AssistantTranscript';
 import {AssistantDockSurface} from './src/features/assistant/AssistantDockSurface';
 import {AssistantMessage} from './src/features/assistant/AssistantMessage';
 const messages=Array.from({length:45},(_,i)=>({id:i,text:'Message '+(i+1)+'\\n\\nA detailed response about layouts, cameras and production controls. '.repeat(3)}));
 function Modal({children}){const ref=useRef(null);useEffect(()=>{ref.current.showModal();return()=>ref.current?.close();},[]);return <dialog ref={ref} className="assistant-workspace" style={{width:600,height:650}}>{children}</dialog>;}
 function Harness(){
  const [items,setItems]=useState(messages),[compact,setCompact]=useState(false),[target,setTarget]=useState(document.getElementById('side')),[settings,setSettings]=useState(false),[modal,setModal]=useState(false);
  window.setCompact=setCompact;window.setTarget=setTarget;window.setSettings=setSettings;window.setModal=setModal;
  window.append=()=>setItems(old=>[...old,{id:old.length,text:'LATEST '+old.length+'\\n\\nThe latest answer should stay in view. '.repeat(12)}]);
  window.stream=()=>setItems(old=>old.map((m,i)=>i===old.length-1?{...m,text:m.text+' More streaming text.'.repeat(10)}:m));
  const conversation=()=> <section className="assistant-panel" style={{height:'100%',minHeight:0,display:'flex',flexDirection:'column'}}><header style={{padding:12,flexShrink:0}}>Room assistant <button onClick={()=>setSettings(old=>!old)}>Settings</button></header>{settings&&<div style={{height:300}}>Connection settings</div>}<AssistantTranscript hidden={settings}>{items.map(m=><div className="assistant-message assistant" key={m.id}><span>Assistant</span><AssistantMessage text={m.text}/></div>)}</AssistantTranscript><form className="assistant-composer" onSubmit={e=>e.preventDefault()}><textarea aria-label="Assistant prompt" placeholder="Ask Producer…"/></form></section>;
  return modal?<Modal>{conversation()}</Modal>:<AssistantDockSurface dock={{target,compact,onExpand:()=>setCompact(false)}} parking={document.getElementById('parking')} reviewOpen={false} busy={false} connected connecting={false} onConnect={()=>{}} status="Ask anything" summary="The latest answer" conversation={conversation} composer={<input placeholder="Ask Producer…"/>} onRead={()=>{}}/>;
 }
 window.frames=[];let watching=false;
 window.watch=()=>{window.frames=[];watching=true;const tick=()=>{if(!watching)return;requestAnimationFrame(()=>{setTimeout(()=>{if(!watching)return;const el=[...document.querySelectorAll('.assistant-messages')].find(el=>el.clientHeight&&el.clientWidth&&el.isConnected&&!el.hidden&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el.closest('.assistant-workspace')??el).visibility!=='hidden');if(el)window.frames.push({gap:el.scrollHeight-el.clientHeight-el.scrollTop,height:el.clientHeight,top:el.scrollTop});tick();},0);});};tick();};
 window.stopWatch=()=>{watching=false;return window.frames;};
 createRoot(document.getElementById('root')).render(<Harness/>);
 `},bundle:true,platform:'browser',format:'iife',write:false,define:{'process.env.NODE_ENV':'"production"'}});
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const css=await readFile('src/features/assistant/assistant.css','utf8'),report=[];
const folder=process.env.PRODUCER_SCROLL_REVIEW??'/private/tmp/producer-assistant-scroll';await mkdir(folder,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:17396/assistant-scroll';await page.route('**/*',r=>r.request().url()===url?r.fulfill({contentType:'text/html',body:`<!doctype html><style>${css}body{margin:20px;background:#080d14}#side{width:360px;height:760px}#mini{position:fixed;left:20px;bottom:20px;width:1000px;height:40px}.assistant-dock-mount{container:assistant-dock / size}</style><div id="root"></div><div id="parking" hidden></div><section id="side" class="assistant-dock-mount"></section><section id="mini" class="assistant-dock-mount"></section>`}):r.abort());
 await page.goto(url);await page.addScriptTag({content:bundle.outputFiles[0].text});
 const log=()=>page.locator('.assistant-messages:visible');
 const atBottom=async(label)=>{const metrics=await log().evaluate(el=>({gap:el.scrollHeight-el.clientHeight-el.scrollTop,behavior:getComputedStyle(el).scrollBehavior}));assert(metrics.gap<=1,label+': '+JSON.stringify(metrics));assert.equal(metrics.behavior,'auto');};
 const firstFrames=async(label)=>{await page.waitForFunction(()=>window.frames.length>=5);const frames=await page.evaluate(()=>window.stopWatch());assert(frames.length&&frames.every(frame=>frame.gap<=1),label+' exposed an earlier scroll position: '+JSON.stringify(frames));report.push({label,firstVisibleFrameGap:frames[0].gap,framesChecked:frames.length});};
 await log().waitFor();await atBottom('initial sidebar');
 // Streaming does not pull a reader away from older messages.
 await log().evaluate(el=>el.scrollTop=120);await page.waitForTimeout(40);await page.evaluate(()=>window.append());await page.waitForTimeout(40);assert.equal(await log().evaluate(el=>el.scrollTop),120);
 await log().evaluate(el=>el.scrollTop=el.scrollHeight);await page.waitForTimeout(40);await page.evaluate(()=>window.stream());await atBottom('streaming at tail');
 await page.evaluate(()=>{window.setCompact(true);window.setTarget(document.getElementById('mini'));});
 for(let i=0;i<5;i++){
  await page.evaluate(()=>window.watch());await page.getByRole('button',{name:'Expand Assistant',exact:true}).click();await firstFrames('floating open '+i);await atBottom('floating open');
  await log().evaluate((el,i)=>el.scrollTop=i%2?el.scrollHeight/2:0,i);await page.waitForTimeout(40);
  await page.getByRole('button',{name:'Close Assistant conversation',exact:true}).click();assert.equal(await log().count(),0);
 }
 // Returning from settings must position the revealed log before its first paint.
 await page.getByRole('button',{name:'Expand Assistant',exact:true}).click();await log().evaluate(el=>el.scrollTop=100);await page.waitForTimeout(40);
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.evaluate(()=>window.watch());await page.getByRole('button',{name:'Settings',exact:true}).click();await firstFrames('settings return');
 // Reparent into a dock and reveal a dock hidden with CSS, without a new chat.
 await page.getByRole('button',{name:'Close Assistant conversation',exact:true}).click();await page.evaluate(()=>{window.watch();window.setTarget(document.getElementById('side'));window.setCompact(false);});await firstFrames('expanded dock return');
 await log().evaluate(el=>el.scrollTop=100);await page.waitForTimeout(40);await page.evaluate(()=>document.getElementById('side').style.display='none');await page.waitForTimeout(40);await page.evaluate(()=>{window.watch();document.getElementById('side').style.display='block';});await firstFrames('closed dock reveal');
 // The actual Set editor uses a native dialog that starts without layout.
 await page.evaluate(()=>{window.watch();window.setModal(true);});await firstFrames('native dialog mount');await atBottom('native dialog');
 await log().evaluate(el=>el.scrollTop=160);await page.waitForTimeout(40);await page.evaluate(()=>window.append());await page.waitForTimeout(40);assert.equal(await log().evaluate(el=>el.scrollTop),160);
 assert.deepEqual(errors,[]);await page.screenshot({path:folder+'/assistant-tail.png'});await writeFile(folder+'/verification.json',JSON.stringify({report,historyReadingPreserved:true,streamingTailFollow:true,pageErrors:errors},null,2));
 console.log(`PASS Assistant scroll: ${report.length} opens/reveals start at the bottom on the first sampled visible frame; no smooth jump; reading history is preserved during streaming.`);
}finally{await browser.close();}
