import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';

const source = await readFile(new URL('../src/views/Live.tsx', import.meta.url), 'utf8');
const pickers = source.slice(source.indexOf('function WindowPickerList('), source.indexOf('function SceneSettingsStrip('));
const form = source.slice(source.indexOf('function WindowSourceForm('), source.indexOf('function DevicePicker('));
const bundle = await build({
  stdin: {contents: `
    import React, {useEffect, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ipc, extraSources} from './src/lib/ipc';
    import {windowSourceLabel} from './src/lib/sourceSpec';
    ${pickers}
    ${form}
    window.renderPicker = kind => {
      const onPick = (id, window, label) => extraSources.replace(id, label, {kind:'window', window});
      const props = {itemId:'existing', onPick, onPicked:()=>{}};
      const element = kind === 'add'
        ? <WindowSourceForm onAdd={(window, label)=>extraSources.add('added',label,{kind:'window',window})}/>
        : kind === 'sidebar' ? <WindowPickerList {...props}/> : <WindowStripList {...props}/>;
      createRoot(document.getElementById('root')).render(element);
    };
  `, resolveDir: process.cwd(), loader:'tsx'},
  bundle:true, write:false, platform:'browser', format:'iife',
});
const {chromium} = await import(process.env.PRODUCER_PLAYWRIGHT_MODULE ??
  new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs', import.meta.url).href);
const browser = await chromium.launch({headless:true, ...(process.env.PRODUCER_TEST_CHROME
  ? {executablePath:process.env.PRODUCER_TEST_CHROME} : {channel:'chrome'})});
try {
  for (const [nativeWindow, expected] of [
    [{id:123, title:'Windows test window'}, 'Windows test window'],
    [{id:123, owner:'Safari', title:'Mac test window'}, 'Safari'],
    [{id:123, owner:' ', title:' '}, 'Window'],
  ]) {
    for (const kind of ['add','sidebar','strip']) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error=>errors.push(error.message));
      await page.setContent('<div id="root"></div>');
      await page.evaluate(nativeWindow=>{
        window.calls=[];
        window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(command,args)=>{
          if(command==='live_list_windows')return [nativeWindow];
          if(command==='live_add_source'||command==='live_replace_source'){
            if(typeof args.label!=='string'||!args.label.trim())throw Error('Missing source label');
            window.calls.push({command,args});return {items:[]};
          }
          throw Error('Unexpected native command '+command);
        }};
      }, nativeWindow);
      await page.addScriptTag({content:bundle.outputFiles[0].text});
      await page.evaluate(kind=>window.renderPicker(kind),kind);
      await page.locator('button').click();
      await page.waitForFunction(()=>window.calls.length===1);
      const [call] = await page.evaluate(()=>window.calls);
      assert.equal(call.args.label,expected);
      assert.deepEqual(call.args.spec,{kind:'window',window:123});
      assert.equal(call.command,kind==='add'?'live_add_source':'live_replace_source');
      assert.deepEqual(errors,[]);
      await page.close();
    }
  }
  console.log('PASS: all three real window pickers send a required label for Windows, Mac and untitled windows.');
} finally {
  await browser.close();
}
