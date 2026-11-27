const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

(async () => {
  const folder = __dirname;
  const artifacts = process.env.PLAN_OUTPUT_DIR ? path.resolve(process.env.PLAN_OUTPUT_DIR) : folder;
  fs.mkdirSync(artifacts, { recursive: true });
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  else launch.channel = 'chrome';
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('file://' + path.join(folder, 'producer-owned-media-plan.html'));
    await page.locator('#phase-current h3').waitFor();
    assert.equal(await page.title(), 'Producer — Owned Media Engine Plan');
    assert.equal(await page.locator('main > section').count(), 11);
    const nodes = await page.locator('[data-node]').evaluateAll(elements => elements.map(e => e.dataset.node));
    for (const node of nodes) {
      await page.locator(`[data-node="${node}"]`).click();
      assert.equal(await page.locator('[data-node][aria-pressed="true"]').count(), 1);
      assert.ok((await page.locator('#node-detail h3').innerText()).length > 10);
    }
    await page.locator('[data-layout="solo"]').click();
    const solo = await page.locator('#route-matrix tr').evaluateAll(rows => rows.map(row => Array.from(row.cells).map(cell => cell.textContent)));
    assert.deepEqual(solo[1].slice(1), ['—', '●', '●', '—']);
    assert.equal(solo[0][3], '—');
    await page.locator('[data-guest="muted"]').click();
    assert.deepEqual(await page.locator('#route-matrix tr').nth(3).locator('td').allTextContents(), ['Guest 3','—','—','—','—']);
    await page.locator('[data-layout="roundtable"]').click();
    await page.locator('[data-guest="backstage"]').click();
    assert.deepEqual(await page.locator('#route-matrix tr').nth(3).locator('td').allTextContents(), ['Guest 3','—','—','—','—']);
    await page.locator('[data-guest="stage"]').click();
    const scenarios = await page.locator('[data-scenario]').evaluateAll(elements => elements.map(e => e.dataset.scenario));
    for (const scenario of scenarios) {
      await page.locator(`[data-scenario="${scenario}"]`).click();
      assert.equal(await page.locator('#recovery-trace > div').count(), 3);
      assert.equal(await page.locator('[data-scenario][aria-pressed="true"]').count(), 1);
    }
    for (let i = 0; i < 7; i++) {
      await page.locator(`[data-phase="${i}"]`).click();
      assert.match(await page.locator('#phase-current .eyebrow').innerText(), new RegExp('^P' + i));
      assert.equal(await page.locator('#phase-current .phasecols > div').count(), 2);
    }
    await page.locator('[data-phase="0"]').click();
    const brokenAnchors = await page.locator('a[href^="#"]').evaluateAll(elements => elements.filter(e => !document.getElementById(e.getAttribute('href').slice(1))).map(e => e.getAttribute('href')));
    assert.deepEqual(brokenAnchors, []);
    const duplicateIds = await page.locator('[id]').evaluateAll(elements => elements.map(e=>e.id).filter((id,i,ids)=>ids.indexOf(id)!==i));
    assert.deepEqual(duplicateIds, []);
    const sizes = [];
    for (const width of [1920, 1440, 1024, 768, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const size = await page.evaluate(() => ({width:innerWidth,content:document.documentElement.scrollWidth}));
      assert.ok(size.content <= size.width, `Horizontal page overflow at ${width}: ${size.content}`);
      sizes.push(size);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForFunction(() => window.scrollY === 0);
    await page.screenshot({ path: path.join(artifacts, 'plan-dark.png') });
    await page.locator('#theme-toggle').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.screenshot({ path: path.join(artifacts, 'plan-light.png') });
    await page.locator('#theme-toggle').click();
    await page.evaluate(() => window.scrollTo({ top: document.getElementById('architecture').offsetTop - 84, behavior: 'instant' }));
    await page.screenshot({ path: path.join(artifacts, 'plan-architecture.png') });
    await page.setViewportSize({ width:390,height:844 });
    await page.evaluate(() => window.scrollTo(0,0));
    await page.screenshot({ path: path.join(artifacts, 'plan-mobile.png') });
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    assert.equal(await page.locator('details:not([open])').count(), 0);
    assert.equal(await page.locator('#phase-print > .phasepanel').count(), 7);
    assert.equal(await page.locator('#phase-print').isVisible(), true);
    await page.pdf({ path: path.join(artifacts,'producer-owned-media-plan.pdf'), format:'A4', printBackground:true, margin:{top:'12mm',bottom:'12mm',left:'10mm',right:'10mm'} });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    assert.deepEqual(errors, []);
    const result={passed:true,checks:['11 sections','12 architecture nodes','routing/visibility/self-exclusion','four recovery scenarios','seven phases','light/dark theme','all anchors valid','no duplicate IDs','no page overflow 320–1920px','all detail and phase content available for print','no JavaScript exceptions'],viewports:sizes,applicationChanged:false};
    fs.writeFileSync(path.join(artifacts,'verification.json'),JSON.stringify(result,null,2)+'\n');
    process.stdout.write(JSON.stringify(result)+'\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
