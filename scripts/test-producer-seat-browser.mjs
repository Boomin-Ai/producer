import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,...(process.env.PRODUCER_TEST_CHROME?{executablePath:process.env.PRODUCER_TEST_CHROME}:{})});
try{
 const page=await browser.newPage();await page.goto(`${process.env.PRODUCER_TEST_URL||'http://127.0.0.1:1451'}/scripts/producer-seat-browser.html`);await page.waitForFunction(()=>typeof window.runProducerSeatTest==='function');
 const result=await page.evaluate(()=>window.runProducerSeatTest());assert.ok(result.before.frames>3&&result.after.frames>3);assert.ok(result.before.audioBytes>0&&result.after.audioBytes>0);assert.equal(result.captures,1);assert.equal(result.localTracksStopped,true);assert.equal(result.allMediaPeersClosed,true);
 if(process.env.PRODUCER_SEAT_EVIDENCE)await writeFile(process.env.PRODUCER_SEAT_EVIDENCE,JSON.stringify({...result,at:new Date().toISOString(),scope:'Browser legacy guest transport only; not a real Mac/Windows or native LiveKit media qualification'},null,2)+'\n');
 console.log('PASS: full Producer guest seat sends synthetic video/audio before and after host recreation, without recapturing media.',result);
}finally{await browser.close();}
