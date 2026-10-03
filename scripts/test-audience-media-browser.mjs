import assert from 'node:assert/strict';
const { webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(error));
  await page.goto('http://127.0.0.1:1421/scripts/audience-media-browser.html');
  await page.click('#run');
  const result = await page.evaluate(() => window.resultPromise);
  assert.ok(result.decoded.every(n=>n>5),JSON.stringify(result));
  assert.ok(result.energies.every(n=>n>0.001),'Processed audio must arrive at both viewers');
  assert.equal(result.captures,1,'Viewer legs must share one program capture');
  assert.equal(result.starts,1,'Native audio must start once');
  assert.equal(result.failures,0);
  assert.ok(result.firstReleasedStillLive,'Closing one viewer must preserve other viewers');
  assert.ok(result.lastReleasedEnded,'Closing the final viewer must release capture');
  assert.deepEqual(result.mesh,{connected:true,suspended:true,sourcePreserved:true,resumed:true},'Stage suspension and same-version host confirmation must preserve the original mic');
  console.log('PASS: two WebKit viewers decode shared program video and processed stereo audio.',result);
} finally { await browser.close(); }
