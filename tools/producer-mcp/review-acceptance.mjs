// Review the real MCP previews. Camera and microphone samples remain simulated.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = new URL('../../target/prompt-acceptance/', import.meta.url);
await mkdir(output, {recursive: true});
const {chromium} = await import(process.env.PRODUCER_PLAYWRIGHT_MODULE ?? 'playwright-core');
const browser = await chromium.launch({
  executablePath: process.env.PRODUCER_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const results = JSON.parse(await readFile(new URL('results.json', output), 'utf8'));
const checks = [];
try {
  for (const result of results) {
    const page = await browser.newPage({viewport: {width: 1400, height: 1050}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('file://' + result.preview.path);
    const profile = result.file.includes('weather') ? 'weather' : result.file.includes('reactive') ? '3d' : 'cta';
    for (const layout of result.layouts) {
      await page.locator('#layouts').selectOption(layout.id);
      await page.waitForTimeout(300);
      const frame = page.frames().find(frame => frame !== page.mainFrame());
      assert(frame, 'Preview iframe must mount');
      if (profile === '3d') {
        await frame.locator('canvas[data-scene3d-ready="true"]').waitFor({timeout: 30000});
      }
      await page.locator('#preview').screenshot({
        path: new URL(`browser-${layout.id}-${profile}.png`, output).pathname,
      });
      checks.push({file: result.file, layout: layout.id, errors: [...errors]});
      await writeFile(new URL('browser-review.json', output), JSON.stringify(checks, null, 2));
      assert.deepEqual(errors, [], `Browser errors in ${layout.id}`);
    }
    await page.close();
  }
  console.log(`PASS: ${checks.length} MCP previews rendered; managed 3D ready in both orientations`);
} finally {
  await browser.close();
}
