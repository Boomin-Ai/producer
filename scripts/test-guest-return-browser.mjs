import assert from 'node:assert/strict';
const { webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(error));
  await page.goto('http://127.0.0.1:1420/scripts/guest-return-browser.html');
  await page.waitForFunction(() => typeof window.runReturnTest === 'function');
  const result = await page.evaluate(() => window.runReturnTest());
  assert.ok(result.decoded > 3, JSON.stringify(result));
  assert.ok(result.width > 0, 'Program must render, not just attach a track');
  assert.equal(result.captureCalls, 1, 'Repeated requests must share one capture');
  assert.ok(result.requests > 0);
  console.log('PASS: WebKit receives and decodes program video despite host microphone denial.', result);
} finally { await browser.close(); }
