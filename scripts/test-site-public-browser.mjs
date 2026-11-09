/** Real-browser layout/preview checks for the public Worker. All page, API and
 * image responses are fixtures; browser network is intercepted completely. */
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import worker from '../site/_worker.js';
const playwright=process.env.PRODUCER_PLAYWRIGHT_MODULE;
const {chromium}=await import(playwright?(playwright.startsWith('file:')?playwright:pathToFileURL(resolve(playwright)).href):new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs',import.meta.url).href);
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{channel:process.env.PRODUCER_BROWSER_CHANNEL??'chrome'})});
const thumb=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
const sample={handle:'kleveland',slug:'djaylas-kitchen',title:'Djayla’s Kitchen',description:'Fresh ingredients, good company, and a seat at the table.',status:'published',visibility:'public',revision:2,version:1,byte_length:78234,layout_count:6,orientations:['landscape','portrait'],preview_url:null};
const chair=await readFile(new URL('../site/chair.png',import.meta.url));
const staticAsset=async req=>new URL(req.url).pathname==='/chair.png'?new Response(chair,{headers:{'Content-Type':'image/png'}}):new Response('STATIC');
const originalFetch=globalThis.fetch;
let profile={handle:'kleveland',name:'Kleveland',bio:'Building in public. Making things worth watching.',sets:[sample]};
const apiCalls=[];
globalThis.fetch=async input=>{
 const url=new URL(input);assert.equal(url.origin,'https://api.boomin.ai');apiCalls.push(url.pathname);
 if(url.pathname.endsWith('/preview'))return new Response(thumb,{headers:{'Content-Type':'image/png'}});
 return new Response(JSON.stringify(url.pathname.includes('/sets/')?{profile,publication:profile.sets[0]}:profile),{headers:{'Content-Type':'application/json'}});
};
let passed=0;
try{
 if(process.env.PRODUCER_SITE_PREVIEW_DIR)await mkdir(process.env.PRODUCER_SITE_PREVIEW_DIR,{recursive:true});
 for(const width of [1440,390])for(const kind of ['profile','set']){
  const page=await browser.newPage({viewport:{width,height:1000},deviceScaleFactor:1});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());assert.equal(url.origin,'https://producer.dev','No authored or arbitrary external URL may be requested');
   const res=await worker.fetch(new Request(url,{method:route.request().method()}),{ASSETS:{fetch:staticAsset}});
   await route.fulfill({status:res.status,headers:Object.fromEntries(res.headers),body:Buffer.from(await res.arrayBuffer())});
  });
  await page.goto('https://producer.dev/kleveland'+(kind==='set'?'/set/djaylas-kitchen':''));
  assert.equal(await page.locator('h1').count(),1);assert.equal(await page.locator('main').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,kind+' at '+width);
  assert.equal(await page.locator('script,iframe').count(),0);
  await page.locator('.brand-mark').evaluate(img=>img.decode());assert.ok(await page.locator('.brand-mark').evaluate(img=>img.naturalWidth)>0);
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Producer home');
  if(kind==='set')assert.equal(await page.getByRole('link',{name:'Download Set'}).getAttribute('href'),'/kleveland/set/djaylas-kitchen/download');
  if(process.env.PRODUCER_SITE_PREVIEW_DIR)await page.screenshot({path:resolve(process.env.PRODUCER_SITE_PREVIEW_DIR,`${kind}-${width}.png`),fullPage:true});
  await page.close();passed++;
 }
 // An approved preview must really decode, rather than passing because an img
 // tag exists. Authored remote asset URLs are never loaded by this browser.
 profile={...profile,sets:[{...sample,preview_url:'https://never-fetch.invalid/private.png'}]};
 const page=await browser.newPage({viewport:{width:390,height:1000}});
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());assert.equal(url.origin,'https://producer.dev');
  const res=await worker.fetch(new Request(url),{ASSETS:{fetch:staticAsset}});
  await route.fulfill({status:res.status,headers:Object.fromEntries(res.headers),body:Buffer.from(await res.arrayBuffer())});
 });
 await page.goto('https://producer.dev/kleveland/set/djaylas-kitchen');
 await page.locator('.art img').evaluate(img=>img.decode());assert.equal(await page.locator('.art img').evaluate(img=>img.naturalWidth),1);
 assert.ok(apiCalls.some(p=>p.endsWith('/preview')));passed++;
 // Stress authored text: a valid but long handle/name/title must wrap safely.
 profile={...profile,name:'A'.repeat(240),bio:'B'.repeat(4000),sets:[{...sample,title:'C'.repeat(240),description:'D'.repeat(4000)}]};
 for(const path of ['/kleveland','/kleveland/set/djaylas-kitchen']){
  await page.goto('https://producer.dev'+path);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'long authored text '+path);passed++;
 }
 await page.close();console.log(`Producer public browser: ${passed} real layout, keyboard, preview-decode and long-text checks passed (fixture network only).`);
}finally{globalThis.fetch=originalFetch;await browser.close();}
