import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
const {webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const frame=process.argv[2];if(!frame)throw Error('Pass a native portrait JPEG frame file');
const server=createServer((q,r)=>{r.setHeader('Access-Control-Allow-Origin','*');r.setHeader('Content-Type','image/jpeg');r.end(readFileSync(frame));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await webkit.launch({headless:true});
try {const page=await browser.newPage();page.on("console",m=>console.log(m.text()));page.on("pageerror",e=>console.log(e.message));page.setDefaultTimeout(15000);await page.goto((process.env.MEDIA_TEST_BASE || 'http://127.0.0.1:1421')+'/scripts/audience-media-browser.html?portraitFrame='+encodeURIComponent('http://127.0.0.1:'+server.address().port));await page.click('#run');const result=await page.evaluate(()=>Promise.race([window.resultPromise,new Promise((_,r)=>setTimeout(()=>r(Error("test timed out")),45000))]));console.log(JSON.stringify(result));if(!result.outputSizes.every(s=>s[0]>0&&s[1]>s[0]&&Math.abs(s[0]/s[1]-9/16)<0.01)||!result.decoded.every(n=>n>5)||!result.energies.every(n=>n>0.001))throw Error('portrait failed');if(!result.switches.every((pair,i)=>pair.every(s=>i%2?s[1]>s[0]:s[0]>s[1])))throw Error('switch failed');}finally{await browser.close();server.close();}
