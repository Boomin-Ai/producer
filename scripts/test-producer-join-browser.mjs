import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '../tools/producer-mcp/node_modules/playwright-core/index.mjs';
const out=new URL('../../../outputs/producer-network/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:\d+\//,()=>{});
 await page.route('**/src/main.tsx*',r=>r.fulfill({contentType:'application/javascript',body:''}));await page.goto(process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1451');
 await page.evaluate(async()=>{
  await import('/src/App.css');const React=(await import('/node_modules/.vite/deps/react.js')).default,DOM=await import('/node_modules/.vite/deps/react-dom_client.js'),{ProducerJoin}=await import('/src/features/network/ProducerJoin.tsx');
  const host=document.createElement('main');host.className='producer-network-sheet join-sheet';document.body.replaceChildren(host);const root=(DOM.createRoot??DOM.default.createRoot)(host);window.entered=[];window.requests=[];
  window.fetch=async(url,init)=>{window.requests.push({url,init});await new Promise(r=>setTimeout(r,60));return url.endsWith('/join-intent')?{ok:true,status:200,json:async()=>({join_intent:'saved-browser-proof',expires_at_ms:Date.now()+60000})}:{ok:true,json:async()=>({invite_code:'gi_abcdefghijklmnopqrstuvwx'})};};
  const props={endpoint:{id:'mac',name:'Kleveland',base_url:'https://api.boomin.ai/v1/app/producer',kind:'connected',created_at:'',brand_slug:'kleveland'},rooms:[{id:'local-room',name:'Atlantium',endpoint_id:'mac',config:'{}'}],onClose:()=>{},onEnter:seat=>window.entered.push(seat)};
  window.mount=()=>root.render(React.createElement(React.StrictMode,null,React.createElement(ProducerJoin,props)));window.mount();
 });
 await page.getByRole('heading',{name:'Join another Producer'}).waitFor();assert.equal(await page.evaluate(()=>window.requests.length),0);
 await page.getByLabel('Producer invitation link').fill('https://studio.example/connect/guest/room/gr_abcdefghijklmnopqrstuvwx');
 await page.screenshot({path:new URL('producer-join.png',out).pathname});
 await page.getByRole('button',{name:'Join room',exact:true}).dblclick();await page.waitForFunction(()=>window.entered.length===1);assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.url.endsWith('/join')).length),1);
 const seat=await page.evaluate(()=>window.entered[0]);assert.equal(seat.videoSource,'program');assert.equal(seat.localRoomId,'local-room');assert.equal(seat.apiBase,'https://studio.example');assert.equal(seat.joinUrl,'https://studio.example/connect/guest/gi_abcdefghijklmnopqrstuvwx');
 await page.getByLabel('Webcam and microphone',{exact:false}).check();await page.getByRole('button',{name:'Join room',exact:true}).click();await page.waitForFunction(()=>window.entered.length===2);const webcam=await page.evaluate(()=>window.entered[1]);assert.equal(webcam.videoSource,'webcam');assert.equal(webcam.localRoomId,undefined);
 assert.deepEqual(errors,[]);await writeFile(new URL('producer-join-browser-proof.json',out),JSON.stringify({ok:true,checks:['StrictMode mounted form','no automatic join or device activation','explicit local Set choice','explicit webcam choice','independent issuer retained','double click sends one join'],errors},null,2));console.log('PASS Producer join: explicit media/room selection, no automatic join, StrictMode lifetime and duplicate click handling.');
}finally{await browser.close();}
