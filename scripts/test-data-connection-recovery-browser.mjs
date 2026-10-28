import assert from 'node:assert/strict';
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const R=await import('/node_modules/.vite/deps/react.js'),React=R.default??R,D=await import('/node_modules/.vite/deps/react-dom_client.js'),{dataIntegrations}=await import('/src/lib/dataIntegrations.ts'),{useDataConnections}=await import('/src/features/presentation/useDataConnections.ts');
  window.calls=[];let first=true;
  dataIntegrations.list=async endpoint=>{window.calls.push(endpoint);if(endpoint==='one'&&first){first=false;throw Error('offline');}if(endpoint==='late')return new Promise(resolve=>window.resolveLate=()=>resolve({connections:[{connection:{name:'OLD'}}]}));return {connections:[{connection:{name:endpoint.toUpperCase()}}]};};
  document.body.innerHTML='<div id="recovery-test"></div>';
  function Test(){const [endpoint,setEndpoint]=React.useState('one');window.setEndpoint=setEndpoint;const state=useDataConnections(endpoint);return React.createElement('div',null,React.createElement('span',{id:'connections'},state.connections.map(c=>c.connection.name).join(',')),state.connectionError&&React.createElement('p',{role:'alert'},state.connectionError),React.createElement('button',{onClick:state.retryConnections},'Retry connections'));}
  window.testRoot=(D.createRoot??D.default.createRoot)(document.getElementById('recovery-test'));window.testRoot.render(React.createElement(Test));
 });
 await page.getByRole('alert').filter({hasText:'offline'}).waitFor();
 await page.locator('#connections').filter({hasText:'ONE'}).waitFor();assert.equal(await page.getByRole('alert').count(),0);
 const before=await page.evaluate(()=>window.calls.length);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForFunction(n=>window.calls.length>n,before);
 await page.evaluate(()=>window.setEndpoint('late'));await page.waitForFunction(()=>!!window.resolveLate);assert.equal(await page.locator('#connections').textContent(),'');
 await page.evaluate(()=>window.setEndpoint('two'));await page.locator('#connections').filter({hasText:'TWO'}).waitFor();await page.evaluate(()=>window.resolveLate());await page.waitForTimeout(50);assert.equal(await page.locator('#connections').textContent(),'TWO');
 await page.getByRole('button',{name:'Retry connections'}).click();await page.waitForFunction(()=>window.calls.filter(c=>c==='two').length===2);
 const count=await page.evaluate(()=>{window.testRoot.unmount();return window.calls.length;});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>window.calls.length),count);
 console.log('PASS saved connections: outage automatically recovers, focus/manual refresh work, workspace changes fence late replies, unmount removes retries/listeners.');
}finally{await browser.close();}
