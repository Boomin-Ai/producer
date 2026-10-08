import assert from 'node:assert/strict';
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PRODUCER_TEST_URL || 'http://127.0.0.1:1420';
for (const [name, engine, options] of [
  ['Chrome', chromium, { channel: 'chrome', headless: true }],
  ['WebKit', webkit, { headless: true }],
]) {
  const browser = await engine.launch(options);
  try {
    for (const test of ['manager-draft-browser', 'publish-composer-browser', 'manager-cache-browser']) {
      const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
      page.on('pageerror', error => console.error(error));
      await page.goto(`${base}/scripts/${test}.html`);
      await page.waitForFunction(() => /^(PASS|FAIL):/.test(document.querySelector('#result')?.textContent || ''), null, { timeout: 25_000 });
      const result = await page.locator('#result').textContent();
      assert.ok(result.startsWith('PASS:'), `${name}: ${result}`);
      console.log(`${name}: ${result}`);
      await page.close();
    }
  } finally { await browser.close(); }
}
