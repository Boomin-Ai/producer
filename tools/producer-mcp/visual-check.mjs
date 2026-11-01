import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {previewHtml} from './runtime.mjs';

/** Browser binary is operator-installed; never downloads one during a tool call. */
export async function checkRenderedSet(doc){
 const directory=await mkdtemp(join(tmpdir(),'producer-visual-'));let browser;
 try{
  const file=join(directory,'review.html');await writeFile(file,await previewHtml(doc),{mode:0o600});
  const executablePath=process.env.PRODUCER_BROWSER_PATH??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
  if(!executablePath)throw Error('Set PRODUCER_BROWSER_PATH to an installed Chromium browser for text-fit checks.');
  browser=await chromium.launch({executablePath,headless:true});
  const page=await browser.newPage();await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(()=>!!window.__producerVisualReview,undefined,{timeout:60000});
  const result=await page.evaluate(()=>window.__producerVisualReview);
  if(!result.ok)throw Error(result.error);
  return result.report;
 }finally{await browser?.close();await rm(directory,{recursive:true,force:true});}
}
