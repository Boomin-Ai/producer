import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'playwright-core');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route(/\/src\/lib\/dataIntegrations\.ts(?:\?.*)?$/,route=>route.fulfill({contentType:'application/javascript',body:'export const dataIntegrations={list:(...args)=>window.portability.list(...args),save:(...args)=>window.portability.save(...args),test:(...args)=>window.portability.test(...args)};'}));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const R=(await import('/node_modules/.vite/deps/react.js')).default,D=await import('/node_modules/.vite/deps/react-dom_client.js');
  const {SetIntegrationConnections}=await import('/src/features/presentation/SetIntegrationConnections.tsx'),{useDataConnections}=await import('/src/features/presentation/useDataConnections.ts'),{dataIntegrations}=await import('/src/lib/dataIntegrations.ts'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
  const doc=(new RehearsalSession(await(await fetch('/docs/shows/atmosphere.json')).json(),undefined,'prepare')).package;
  window.portability={doc,saved:[],bindings:{},saves:0};
  const adapter={schema:'producer.data-adapter/1',id:'open-meteo',version:1,capability:'data.weather@1',transport:'poll',operations:[{id:'forecast',input:'weather.location-query@1',output:'weather.observation@1',delivery:'snapshot',refresh:true}]};
  window.portability.list=async()=>({connections:window.portability.saved,adapters:[adapter],capabilities:['data.weather@1']});
  window.portability.save=async(_endpoint,connection)=>{window.portability.saves++;const saved={connection,revision:1,hasSecret:false,status:'unverified',error:'',testedAt:null};window.portability.saved.push(saved);return saved;};
  window.portability.test=async()=>{window.portability.saved[0].status='ready';return {ok:true};};
  function Harness(){const data=useDataConnections('recipient-workspace'),[bindings,setBindings]=R.useState({});window.portability.bindings=bindings;return R.createElement(SetIntegrationConnections,{doc,endpoint:'recipient-workspace',connections:data.connections,adapters:data.adapters,bindings,onBind:(role,value)=>setBindings(old=>({...old,[role]:value})),error:data.connectionError,onRetry:data.retryConnections});}
  const host=document.createElement('div');document.body.replaceChildren(host);(D.createRoot??D.default.createRoot)(host).render(R.createElement(Harness));
 });
 await page.getByText('Choose a saved connection or add your own.',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.portability.saves),0,'import cannot create accounts or fetch weather');
 await page.getByRole('button',{name:'Add weather connection',exact:true}).click();
 await page.getByRole('button',{name:'Save connection',exact:true}).click();
 await page.waitForFunction(()=>window.portability.saves===1);
 const id=await page.evaluate(()=>window.portability.saved[0].connection.id);
 await page.getByLabel('Live weather connection',{exact:true}).selectOption(id);
 await page.getByText('Configured · connection has not been tested yet.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Test connection',exact:true}).click();
 await page.locator('.set-integration-requirement').getByText('Connected',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>Object.values(window.portability.bindings)[0].id),id);
 assert.equal(await page.evaluate(()=>JSON.stringify(window.portability.doc).includes(window.portability.saved[0].connection.id)),false,'recipient connection is separate from downloadable package');
 await page.evaluate(()=>{window.portability.saved[0].revision++;window.dispatchEvent(new Event('producer:data-connections-changed'));});
 await page.getByText('The previous connection changed or is unavailable. Choose a current connection.',{exact:true}).waitFor();
 await page.getByLabel('Live weather connection',{exact:true}).selectOption(id);
 await page.locator('.set-integration-requirement').getByText('Connected',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>Object.values(window.portability.bindings)[0].revision),2);
 assert.deepEqual(errors,[]);
 console.log('PASS: imported weather Set survives missing connection; importer creates and binds their own provider; binding stays outside export; stale revision requires reconnection');
}finally{await browser.close();}
