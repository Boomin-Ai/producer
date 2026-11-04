// Real React and Tauri JS, controlled native boundary: never installs an app.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const home = await readFile(new URL('../src/views/Home.tsx', import.meta.url), 'utf8');
const rail = home.slice(home.indexOf('const railIc ='));
const css = await readFile(new URL('../src/App.css', import.meta.url), 'utf8');
const { chromium } = await import('../tools/producer-mcp/node_modules/playwright-core/index.mjs');
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useUpdater } from './src/lib/updater';
    function Harness() {
      const u = useUpdater(); window.updater = u;
      return React.createElement(React.Fragment, null,
        React.createElement('output', {id:'state'}, u.state),
        React.createElement(HomeRail, {brandName:'Atlantium', surface:'rooms',
          settingsOpen:false, updateAvailable:u.version!==null, onSurface:()=>{},
          onCompose:()=>{}, onProfile:()=>{}, onSettings:()=>{}, onBack:()=>{}}));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Harness));
    ${rail}
  `, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser',
  plugins: [{ name:'native-presence', setup(b) {
    b.onResolve({filter:/^\.\/ipc$/}, a => a.importer.endsWith('/lib/updater.ts') ? {path:'ipc',namespace:'mock'} : undefined);
    b.onLoad({filter:/.*/,namespace:'mock'}, () => ({contents:'export const hasTauri = () => true;'}));
  }}],
});
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 for (const scenario of ['success','install-failure','restart-failure','current']) {
  const page=await browser.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({content:css});
  await page.evaluate(s=>{
   window.calls=[];
   window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async c=>{
    window.calls.push(c);
    if(c==='plugin:updater|check')return s==='current'?null:{rid:1,currentVersion:'0.4.81',version:'0.4.82'};
    if(c==='plugin:updater|download')return new Promise(r=>{window.finishDownload=()=>r(2);});
    if(c==='plugin:updater|install'){window.stateAtInstall=document.getElementById('state').textContent;return new Promise((r,j)=>{window.finishInstall=()=>s==='install-failure'&&!window.failedInstall?(window.failedInstall=true,j('Permission denied')):r();});}
    if(c==='plugin:process|restart'){
     if(s==='restart-failure'&&!window.failedRestart){window.failedRestart=true;throw Error('Relaunch failed');}
     return new Promise(r=>{window.finishRestart=r;});
    }
    throw Error('Unexpected IPC: '+c);
   }};
  },scenario);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  if(scenario==='current'){
   await page.waitForFunction(()=>window.updater.state==='current');
   assert.equal(await page.locator('.home-update-dot').count(),0,'no badge when current');
   await page.evaluate(()=>window.updater.restart());
   assert.equal(await page.evaluate(()=>window.calls.length),1,'no unstaged restart');
   await page.close();continue;
  }
  await page.waitForFunction(()=>window.updater.state==='downloading');
  assert.equal(await page.evaluate(()=>window.updater.version),'0.4.82','availability before download finishes');
  assert.equal(await page.getByRole('button',{name:'Settings — update available',exact:true}).count(),1);
  const badge = await page.locator('.home-update-dot').boundingBox();
  const gear = await page.locator('.home-settings-button').boundingBox();
  assert(badge.width===8 && badge.x>=gear.x && badge.x+badge.width<=gear.x+gear.width,'badge fits settings icon');
  await page.evaluate(()=>window.finishDownload());
  await page.waitForFunction(()=>window.updater.state==='ready');
  await page.evaluate(()=>{void window.updater.restart();void window.updater.restart();});
  await page.waitForFunction(()=>window.updater.state==='installing');
  await page.waitForFunction(()=>window.finishInstall);
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c==='plugin:updater|install').length),1,'double click installs once');
  assert.equal(await page.evaluate(()=>window.stateAtInstall),'installing','feedback rendered before native install begins');
  assert.equal(await page.evaluate(()=>window.calls.includes('plugin:process|restart')),false,'install before restart');
  await page.evaluate(()=>window.finishInstall());
  if(scenario==='install-failure'){
   await page.waitForFunction(()=>window.updater.state==='ready'&&window.updater.error);
   assert.match(await page.evaluate(()=>window.updater.error),/Permission denied/);
   await page.evaluate(()=>{window.finishInstall=null;void window.updater.restart();});
   await page.waitForFunction(()=>window.finishInstall);
   await page.evaluate(()=>window.finishInstall());
  }
  if(scenario==='restart-failure'){
   await page.waitForFunction(()=>window.updater.state==='installed'&&window.updater.error);
   assert.match(await page.evaluate(()=>window.updater.error),/could not restart/);
   await page.evaluate(()=>{void window.updater.restart();});
  }
  await page.waitForFunction(()=>window.updater.state==='restarting'&&window.finishRestart);
  assert.equal(await page.evaluate(()=>window.calls.filter(c=>c==='plugin:updater|install').length),scenario==='install-failure'?2:1,'restart retry does not reinstall');
  assert.deepEqual(errors,[],'no uncaught rejection');
  await page.close();
 }
 console.log('PASS: download availability, immediate install state, duplicate clicks, installation/relaunch retries, no unstaged restart');
}finally{await browser.close();}
