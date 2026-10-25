import assert from 'node:assert/strict';
const {chromium}=await import('/private/tmp/producer-sets-v2-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1200,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  await import('/src/App.css');const M=await import('/node_modules/.vite/deps/react.js'),React=M.default??M,D=await import('/node_modules/.vite/deps/react-dom_client.js'),{DataIntegrations}=await import('/src/components/DataIntegrations.tsx');
  window.connections=[];window.integrationCalls=[];
  window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(cmd,args)=>{
   if(cmd!=='endpoint_request')return null;window.integrationCalls.push({method:args.method,path:args.path,body:args.body});
   if(args.method==='GET')return {available:true,status:200,body:{connections:window.connections,capabilities:['data.weather@1','data.agent@1']}};
   const body=args.body;
   if(args.path.endsWith('/test')){window.connections=window.connections.map(c=>({...c,status:'ready'}));return {available:true,status:200,body:{ok:true}};}
   if(args.method==='DELETE'){window.connections=window.connections.filter(c=>!args.path.endsWith('/'+c.connection.id));return {available:true,status:200,body:{deleted:true}};}
   const previous=window.connections.find(c=>c.connection.id===body.connection.id);const saved={connection:body.connection,revision:(previous?.revision??0)+1,hasSecret:body.connection.kind==='agent',status:'unverified',error:'',testedAt:null};window.connections=[...window.connections.filter(c=>c.connection.id!==saved.connection.id),saved];return {available:true,status:200,body:saved};
  }};
  const host=document.createElement('main');host.className='cr-page';const root=document.createElement('div');root.className='set-page-in set';host.appendChild(root);document.body.replaceChildren(host);(D.createRoot??D.default.createRoot)(root).render(React.createElement(DataIntegrations,{endpointId:'test-workspace'}));
 });
 await page.getByRole('button',{name:'Add LLM connection'}).click();assert.equal(await page.getByLabel('LLM provider').inputValue(),'anthropic');await page.getByLabel('Model ID',{exact:true}).fill('claude-test');await page.getByLabel('API key',{exact:true}).fill('synthetic-key-never-returned');await page.getByRole('button',{name:'Save connection'}).click();
 await page.getByText('claude-test · Claude · Web research',{exact:true}).waitFor();assert.equal(await page.getByLabel('API key',{exact:true}).count(),0);assert(!(await page.locator('body').innerText()).includes('synthetic-key-never-returned'));
 await page.getByRole('button',{name:'Test connection',exact:true}).click();await page.getByRole('status').filter({hasText:'Connected'}).waitFor();
 await page.getByRole('button',{name:'Edit',exact:true}).click();assert.equal(await page.getByLabel('API key',{exact:true}).inputValue(),'');await page.getByLabel('Name',{exact:true}).fill('Claude facts');await page.getByRole('button',{name:'Save connection'}).click();assert.equal(await page.evaluate(()=>window.integrationCalls.filter(c=>c.method==='POST'&&c.body?.connection).at(-1).body.apiKey),undefined);
 await page.getByRole('button',{name:'Add LLM connection'}).click();await page.getByLabel('LLM provider').selectOption('openai');await page.getByLabel('Name',{exact:true}).fill('OpenAI facts');await page.getByLabel('Model ID',{exact:true}).fill('openai-test');await page.getByLabel('API key',{exact:true}).fill('synthetic-openai-key');await page.getByRole('button',{name:'Save connection'}).click();await page.getByText('openai-test · OpenAI · Web research',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Add weather connection'}).click();await page.getByLabel('Location label').fill('Denver');await page.getByLabel('Latitude').fill('39.739');await page.getByLabel('Longitude').fill('-104.99');await page.getByRole('button',{name:'Save connection'}).click();await page.getByText('Denver · Open-Meteo',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.connections.length),3);assert.deepEqual(errors,[]);await page.screenshot({path:'/private/tmp/producer-data-integrations.png'});
 console.log('PASS: Claude/OpenAI/weather connections configure in Integrations, tested status renders, saved keys stay absent, edits retain secrets');
}finally{await browser.close();}
