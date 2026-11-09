import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { previewHtml } from './runtime.mjs';
import { publicationRuntime } from './publication.mjs';

/** Isolated, package-only poster. No account feeds, device frames or native IPC. */
export async function renderPublicationPreview(doc, layoutId) {
  const { validatePublicPackageText, PUBLIC_THUMBNAIL_BYTES } = await publicationRuntime();
  const checked = validatePublicPackageText(JSON.stringify(doc));
  if (!checked.ok) throw Error(checked.errors.map(issue => issue.message).join(' '));
  const layout = doc.set.layouts.find(item => item.id === (layoutId ?? doc.set.initialLayout));
  if (!layout) throw Error('Choose an authored layout for the publication preview.');
  const dir = await mkdtemp(join(tmpdir(), 'producer-poster-')); let browser;
  try {
    const file = join(dir, 'preview.html');
    await writeFile(file, await previewHtml(doc, { review: false }), { mode: 0o600 });
    const executablePath = process.env.PRODUCER_BROWSER_PATH ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
    if (!executablePath) throw Error('Set PRODUCER_BROWSER_PATH to an installed Chromium browser, or publish without a poster.');
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 2000 }, deviceScaleFactor: 1 });
    await page.context().grantPermissions([]);
    // Packages cannot turn thumbnail rendering into an external fetch service.
    await page.route('**/*', route => /^(file:|data:|blob:|about:)/.test(route.request().url()) ? route.continue() : route.abort());
    await page.goto(pathToFileURL(file).href, { timeout: 30_000 });
    await page.locator('#layouts').selectOption(layout.id);
    await page.addStyleTag({ content: `#preview{width:${Math.min(960, Math.floor(960 * layout.width / layout.height))}px!important;max-width:none!important}.set-preview{max-height:none!important}` });
    await page.locator('.set-preview iframe').waitFor();
    await page.waitForFunction(() => !document.querySelector('.set-preview-status'), undefined, { timeout: 20_000 });
    const frame = page.frames().find(item => item !== page.mainFrame());
    if (!frame) throw Error('The isolated Set preview did not mount.');
    await frame.locator('#canvas > *').first().waitFor({ timeout: 15_000 });
    const canvases = frame.locator('canvas[data-scene3d-ready]');
    if (await canvases.count()) await frame.locator('canvas[data-scene3d-ready="true"]').first().waitFor({ timeout: 20_000 });
    // Wait for layout, fonts and a committed frame, not live input or timers.
    await frame.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const bytes = await page.locator('#preview').screenshot({ type: 'jpeg', quality: 82, timeout: 15_000 });
    if (bytes.length > PUBLIC_THUMBNAIL_BYTES) throw Error('Rendered preview exceeds 512 KiB; choose a simpler layout or a smaller custom image.');
    return bytes;
  } finally { await browser?.close(); await rm(dir, { recursive: true, force: true }); }
}
