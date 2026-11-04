import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';
const{chromium}=await import('../tools/producer-mcp/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
await page.goto('http://127.0.0.1:1436/scripts/soundboard-browser.html');
const dock = page.getByRole('list', { name: 'Connected sounds' });
await dock.getByRole('button', { name: 'Air horn', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.sb-pad.is-playing'));
await dock.getByRole('button', { name: 'Preview Applause', exact: true }).click();
assert.equal(await page.evaluate(() => window.calls.filter(x => x.action === 'preview').at(-1).id), 'b'.repeat(64));
await page.getByRole('button', { name: 'Stop all', exact: true }).click();
await page.waitForFunction(() => !document.querySelector('.sb-pad.is-playing'));

const settings = page.getByRole('dialog', { name: 'Sound settings' });
await dock.getByRole('button', { name: 'Edit Air horn', exact: true }).click();
await settings.getByLabel('Name', { exact: true }).fill('My air horn');
await settings.getByLabel('Playback', { exact: true }).selectOption('overlap');
await settings.getByRole('button', { name: 'Done', exact: true }).click();
await dock.getByRole('button', { name: 'My air horn', exact: true }).waitFor();
assert.equal(await dock.getByRole('button', { name: 'Bell', exact: true }).count(), 0);

const opener = page.getByRole('button', { name: 'Sound settings', exact: true });
await opener.click();
const search = settings.getByRole('searchbox', { name: 'Search sound library' });
await search.fill('Bell');
assert.equal(await settings.locator('.sb-inventory li').count(), 1);
await settings.getByRole('button', { name: 'Connect Bell to room' }).click();
await page.keyboard.press('Escape');
assert.equal(await opener.evaluate(button => document.activeElement === button), true);
await dock.getByRole('button', { name: 'Bell', exact: true }).click();
await page.waitForFunction(() => window.calls.some(call => call.action === 'play' && call.id === 'c'.repeat(64)));
await opener.click();
await settings.getByRole('button', { name: 'Remove Bell from room' }).click();
await settings.getByRole('button', { name: 'Connect Bell to room' }).waitFor();

for (const width of [200, 320, 600, 1000]) {
  await page.setViewportSize({ width, height: 800 });
  assert.equal(await settings.evaluate(dialog => dialog.scrollWidth > dialog.clientWidth), false, `dialog overflow at ${width}`);
}
await settings.getByRole('button', { name: 'Done', exact: true }).click();
assert.equal(await dock.getByRole('button', { name: 'Bell', exact: true }).count(), 0);
for (const width of [200, 320, 600, 1000]) {
  await page.setViewportSize({ width, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `dock overflow at ${width}`);
}
await page.setViewportSize({ width: 600, height: 800 });
await page.screenshot({ path: '/private/tmp/producer-soundboard-ui.png' });
await page.goto('http://127.0.0.1:1436/scripts/soundboard-browser.html?compact');
const mini = page.locator('.sb-panel--compact');
await mini.getByRole('button',{name:'Air horn',exact:true}).click();
await mini.getByRole('button',{name:'Air horn',exact:true,pressed:true}).waitFor();
await mini.getByRole('button',{name:'Stop all',exact:true}).click();
await mini.getByRole('button',{name:'Air horn',exact:true,pressed:false}).waitFor();
await mini.getByRole('button',{name:'Sound settings',exact:true}).click();
await settings.getByRole('button',{name:'Edit Applause',exact:true}).click();
await settings.getByRole('region',{name:'Edit sound',exact:true}).waitFor();
const icon=await browser.newPage({viewport:{width:144,height:144}});const svg=await readFile('tools/producer-streamdeck/icon-source.svg','utf8');for(const[name,color]of[['icon','#0b1d30'],['active','#155f70']]){await icon.setContent('<style>body{margin:0}</style>'+svg.replace('#0b1d30',color));await icon.screenshot({path:`tools/producer-streamdeck/ai.boomin.producer.sounds.sdPlugin/${name}@2x.png`,omitBackground:true});await icon.setViewportSize({width:72,height:72});await icon.addStyleTag({content:'svg{width:72px;height:72px}'});await icon.screenshot({path:`tools/producer-streamdeck/ai.boomin.producer.sounds.sdPlugin/${name}.png`,omitBackground:true});await icon.setViewportSize({width:144,height:144})}
await page.goto('http://127.0.0.1:1436/tools/producer-streamdeck/ai.boomin.producer.sounds.sdPlugin/property-inspector.html');
await page.evaluate(()=>{window.framesSent=[];window.WebSocket=class{constructor(){window.mockSocket=this;setTimeout(()=>this.onopen(),0)}send(s){window.framesSent.push(JSON.parse(s))}};window.connectElgatoStreamDeckSocket('1234','context','registerPropertyInspector','{}',JSON.stringify({action:'ai.boomin.producer.sounds.play',payload:{settings:{sound:'a'.repeat(64)}}}));});
await page.waitForFunction(()=>window.framesSent.length===2);assert.equal(await page.evaluate(()=>window.framesSent[1].action),'ai.boomin.producer.sounds.play');await page.evaluate(()=>window.mockSocket.onmessage({data:JSON.stringify({event:'sendToPropertyInspector',payload:{paired:true,room:'room1',pads:[{id:'a'.repeat(64),name:'Air horn'},{id:'b'.repeat(64),name:'Applause'}]}})}));await page.locator('#sound').selectOption('b'.repeat(64));assert.equal(await page.evaluate(()=>window.framesSent.at(-1).action),'ai.boomin.producer.sounds.play');assert.equal(await page.evaluate(()=>window.framesSent.at(-1).payload.sound),'b'.repeat(64));
console.log('PASS: property inspector registration, sound discovery and stable-ID settings');
console.log('PASS: soundboard playback, editing, library search, room assignments, focus return and 200–1000px layouts');}finally{await browser.close()}
