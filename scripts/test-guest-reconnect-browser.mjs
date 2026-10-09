import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.PRODUCER_TEST_CHROME ? { executablePath: process.env.PRODUCER_TEST_CHROME } : {}) });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(error));
  await page.goto(`${process.env.PRODUCER_TEST_URL || 'http://127.0.0.1:1433'}/scripts/guest-reconnect-browser.html`);
  await page.waitForFunction(() => typeof window.runGuestReconnectTest === 'function');
  const result = await page.evaluate(() => window.runGuestReconnectTest());
  assert.ok(result.before > 3 && result.after > 3, JSON.stringify(result));
  assert.equal(result.renewals, 1);
  assert.equal(result.cameraState, 'live');
  console.log('PASS: real browser decodes guest video before and after signaling loss and host peer recreation.', result);
} finally { await browser.close(); }
