import assert from 'node:assert/strict';
const { chromium, webkit } = await import(process.env.PRODUCER_PLAYWRIGHT_MODULE ?? '/private/tmp/rene-browser/node_modules/playwright/index.mjs');
for (const [name, engine, options] of [['chromium', chromium, { channel: 'chrome' }], ['webkit', webkit, {}]]) {
  const browser = await engine.launch({ headless: true, ...options });
  try {
    const page = await browser.newPage();
    await page.goto(`${process.env.PRODUCER_PREVIEW_ORIGIN ?? 'http://127.0.0.1:1420'}/scripts/chat-overlay-browser.html`);
    await page.waitForFunction(() => /^(PASS|FAIL):/.test(document.querySelector('#result').textContent));
    const result = await page.locator('#result').textContent();
    assert.match(result, /^PASS:/);
    console.log(`${name} ${result}`);
  } finally { await browser.close(); }
}
