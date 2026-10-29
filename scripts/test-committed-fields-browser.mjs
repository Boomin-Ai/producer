import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'/private/tmp/producer-arrangement-browser/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:process.env.PRODUCER_CHROME??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();page.on('pageerror',error=>console.error(error.message));await page.goto(process.env.PRODUCER_TEST_URL??'http://127.0.0.1:1436/');
 await page.evaluate(async()=>{
  const R=await import('/node_modules/.vite/deps/react.js'),D=await import('/node_modules/.vite/deps/react-dom_client.js'),{CommittedField}=await import('/src/features/presentation/CommittedField.tsx');
  const h=R.createElement??R.default.createElement;
  window.submissions=[];
  function Test(){const [value,setValue]=(R.useState??R.default.useState)('Original'),[pending,setPending]=(R.useState??R.default.useState)(false);window.commit=value=>{setValue(value);setPending(false);};return h(CommittedField,{label:'Headline',field:{type:'text',default:'Original',maxLength:80},value,pending,onApply:value=>{window.submissions.push(value);setPending(true);}});}
  const host=document.createElement('div');document.body.replaceChildren(host);(D.createRoot??D.default.createRoot)(host).render(h(Test));
 });
 const input=page.getByRole('textbox',{name:'Headline'}),apply=page.getByRole('button',{name:'Apply Headline'});
 await input.fill('First draft');assert.deepEqual(await page.evaluate(()=>window.submissions),[],'typing is never authoritative');
 await apply.click();assert.deepEqual(await page.evaluate(()=>window.submissions),['First draft']);assert.equal(await apply.isDisabled(),true);
 await input.fill('Next draft');await page.evaluate(()=>window.commit('First draft'));assert.equal(await input.inputValue(),'Next draft','commit does not erase newer typing');
 await apply.click();await page.evaluate(()=>window.commit('Next draft'));assert.equal(await apply.isDisabled(),true,'applied draft becomes clean');
 await page.evaluate(()=>window.commit('Remote edit'));await page.waitForFunction(()=>document.querySelector('input')?.value==='Remote edit');assert.equal(await input.inputValue(),'Remote edit','clean input follows authoritative updates');
 console.log('PASS: shared field drafts submit only on Apply, preserve typing through pending commits, and follow remote updates');
}finally{await browser.close();}
