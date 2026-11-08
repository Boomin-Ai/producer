// Actual entry components/CSS with synthetic IPC only. No login, device access,
// engine, installed app, credentials, OS settings or external navigation.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, extname, sep } from 'node:path';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = process.env.PRODUCER_ENTRY_PREVIEW_DIR ? resolve(process.env.PRODUCER_ENTRY_PREVIEW_DIR) : null;
const mocks = {
  nativeInvoke: 'export const invoke=(command,args)=>window.entryInvoke(command,args);',
  workspace: 'export const setActiveEndpointId=id=>{window.activeEndpoint=id;};',
  opener: 'export const openUrl=async url=>{window.openedUrls.push(url);};',
  process: 'export const relaunch=async()=>{window.relaunchRequested=true;};',
};
const bundle = await build({
  stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import './src/App.css';import {Onboarding,SignIn} from './src/views/Onboarding';import {FirstLight} from './src/views/FirstLight';
    const root=createRoot(document.getElementById('root'));const onDone=()=>{window.finished=true;};
    const name=new URL(location.href).searchParams.get('view');root.render(name==='welcome'||name==='permissions'?<FirstLight onDone={onDone}/>:<main className="shell">{name==='returning'?<SignIn onConnected={onDone}/>:<Onboarding onConnected={onDone} onModLink={()=>{}}/>}</main>);`, resolveDir: root, loader: 'tsx' },
  bundle: true, write: false, outdir: '/entry-preview', entryNames: 'entry', format: 'iife', platform: 'browser',
  define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'entry-native-boundary', setup(b) {
    b.onResolve({ filter: /nativeInvoke|lib\/workspace|plugin-opener|plugin-process/ }, args => {
      const key = args.path.endsWith('plugin-opener') ? 'opener' : args.path.endsWith('plugin-process') ? 'process' : Object.keys(mocks).find(name => args.path.endsWith('/' + name));
      return key ? { path: key, namespace: 'fixture' } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  } }],
});
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Producer setup preview</title><link rel="stylesheet" href="/fonts/instrument-sans/font.css"><link rel="stylesheet" href="/entry.css"></head><body><div id="root"></div><script src="/entry.js"></script></body></html>';
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/entry.js' || path === '/entry.css') { res.setHeader('Content-Type', path.endsWith('js') ? 'text/javascript' : 'text/css'); res.end(path.endsWith('js') ? js : css); return; }
  if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
  const asset = resolve(root, 'public', '.' + decodeURIComponent(path));
  if (!asset.startsWith(resolve(root, 'public') + sep)) { res.writeHead(404).end(); return; }
  try { const bytes = await readFile(asset); const types = { '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf' }; res.setHeader('Content-Type', types[extname(asset)] ?? 'application/octet-stream'); res.end(bytes); } catch { res.writeHead(404).end(); }
});
await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
const origin = `http://127.0.0.1:${server.address().port}`;
const module = process.env.PRODUCER_PLAYWRIGHT_MODULE;
const { chromium } = await import(module ? (module.startsWith('file:') ? module : pathToFileURL(resolve(module)).href) : new URL('../tools/producer-mcp/node_modules/playwright-core/index.mjs', import.meta.url).href);
let browser;
const results = [], errors = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PRODUCER_TEST_CHROME ? { executablePath: process.env.PRODUCER_TEST_CHROME } : { channel: process.env.PRODUCER_BROWSER_CHANNEL ?? 'chrome' }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  async function pageFor(view) {
    const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ view }) => {
      window.__TAURI_INTERNALS__ = {}; window.calls = []; window.openedUrls = []; window.finished = false;
      window.fixture = { screen: 'denied', camera: 'granted', mic: 'denied', resume: view === 'permissions' };
      window.AudioContext = class { constructor() { throw Error('Entry must not start audio'); } };
      window.entryInvoke = async (command, args) => {
        window.calls.push({ command, args });
        if (command === 'firstlight_resume') return args.action === 'take' ? window.fixture.resume : false;
        if (command === 'live_permissions') return { screen: window.fixture.screen, camera: window.fixture.camera, mic: window.fixture.mic };
        if (command === 'live_vcam_status') return { installed: false, state: 'idle', error: null };
        if (command === 'live_screen_coach') return;
        if (command === 'live_request_permission') { window.fixture[args.kind] = 'granted'; return; }
        if (command === 'boomin_request_otp') return {};
        if (command === 'boomin_connect') return { needs_brand: true, brands: [{ slug: 'studio-north', name: 'Studio North' }, { slug: 'after-hours', name: 'After Hours' }] };
        if (command === 'boomin_select_brand') return { id: 'preview-workspace' };
        if (command === 'list_endpoints') return [{ id: 'preview-workspace', kind: 'connected' }];
        if (command === 'network_status') return { membership: null };
        if (command === 'network_join') return {};
        throw Error('Unexpected preview boundary: ' + command);
      };
    }, { view });
    await page.goto(origin + '/?view=' + view); await page.locator('.entry-content').waitFor(); await page.evaluate(() => document.fonts.ready);
    return page;
  }
  async function capture(page, name) {
    if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true }); }
  }
  async function bounds(page, label) {
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
    if (dimensions.scrollWidth > dimensions.width || dimensions.scrollHeight > dimensions.height) await capture(page, 'overflow-' + label.replace(/[^a-z0-9]/gi, '-'));
    assert(dimensions.scrollWidth <= dimensions.width, `${label}: horizontal overflow ${JSON.stringify(dimensions)}`);
    assert(dimensions.scrollHeight <= dimensions.height, `${label}: desktop controls require page scrolling ${JSON.stringify(dimensions)}`);
  }
  const signIn = await pageFor('signin'); await signIn.getByRole('heading', { name: 'Sign in to Producer', exact: true }).waitFor();
  await bounds(signIn, '1280×800 sign in'); await capture(signIn, '01-sign-in');
  assert.equal(await signIn.getByRole('button', { name: 'Email me a code', exact: true }).count(), 1);
  assert(await signIn.getByLabel('Email', { exact: true }).evaluate(el => el === document.activeElement));
  for (const viewport of [{ width: 960, height: 600 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await signIn.setViewportSize(viewport); await bounds(signIn, `${viewport.width}×${viewport.height} sign in`);
  }
  await capture(signIn, '02-sign-in-narrow'); await signIn.setViewportSize({ width: 1280, height: 800 });
  await signIn.getByLabel('Email', { exact: true }).fill('creator@example.test'); await signIn.getByRole('button', { name: 'Email me a code', exact: true }).click();
  await signIn.getByRole('heading', { name: 'Check your inbox', exact: true }).waitFor();
  assert.equal(await signIn.getByLabel('Email', { exact: true }).isVisible(), false);
  assert(await signIn.getByLabel('Sign-in code', { exact: true }).evaluate(el => el === document.activeElement));
  await bounds(signIn, '1280×800 code'); await capture(signIn, '03-code');
  await signIn.getByLabel('Sign-in code', { exact: true }).fill('000000'); await signIn.getByRole('button', { name: 'Verify & connect', exact: true }).click();
  await signIn.getByRole('heading', { name: 'Choose a workspace', exact: true }).waitFor(); await capture(signIn, '04-workspaces');
  await signIn.getByRole('button', { name: /Studio North/ }).click(); await signIn.getByRole('heading', { name: 'Meet your network', exact: true }).waitFor();
  assert.equal(await signIn.getByRole('checkbox').isChecked(), false); await capture(signIn, '05-network');
  results.push('real sign-in, OTP, workspace and optional listing layouts; no desktop overflow at four sizes');
  await signIn.close();
  const welcome = await pageFor('welcome'); await welcome.getByRole('heading', { name: 'Your studio starts here.', exact: true }).waitFor(); await capture(welcome, '06-welcome');
  assert.equal(await welcome.locator('.fl-intro').count(), 0); await welcome.getByRole('button', { name: 'Continue to setup', exact: true }).click();
  await welcome.getByRole('heading', { name: 'Give your studio access.', exact: true }).waitFor(); await welcome.getByText('Granted', { exact: true }).waitFor();
  await bounds(welcome, '1280×800 permissions'); await capture(welcome, '07-permissions');
  await welcome.setViewportSize({ width: 960, height: 600 }); await bounds(welcome, '960×600 permissions'); await capture(welcome, '08-permissions-small');
  await welcome.setViewportSize({ width: 1280, height: 800 });
  const screen = welcome.getByRole('listitem').filter({ hasText: 'Screen recording' }); await screen.getByRole('button', { name: 'Open Settings', exact: true }).click();
  await welcome.waitForFunction(() => window.calls.some(c => c.command === 'live_screen_coach' && c.args.action === 'chip_show'));
  await welcome.evaluate(() => { window.fixture.screen = 'granted'; });
  await welcome.getByRole('button', { name: 'Restart Producer', exact: true }).waitFor(); assert(await welcome.getByRole('button', { name: 'Skip for now', exact: true }).isDisabled());
  await welcome.getByRole('button', { name: 'Restart Producer', exact: true }).click(); await welcome.waitForFunction(() => window.relaunchRequested);
  assert.equal(await welcome.evaluate(() => window.calls.at(-1).command), 'firstlight_resume');
  results.push('screen-grant restart stays visible and writes its resume marker before relaunch'); await welcome.close();
  const resumed = await pageFor('permissions'); await resumed.getByRole('heading', { name: 'Give your studio access.', exact: true }).waitFor();
  await resumed.getByRole('button', { name: 'Skip for now', exact: true }).click(); await resumed.waitForFunction(() => window.finished);
  assert.equal(await resumed.evaluate(() => localStorage.getItem('producer.firstlight.v1')), '1');
  await resumed.waitForFunction(() => window.calls.some(c => c.command === 'firstlight_resume' && c.args.action === 'clear'));
  results.push('resumed permission setup can finish and preserves the existing completion key'); await resumed.close();
  assert.deepEqual(errors, []);
  if (output) await writeFile(resolve(output, 'verification.json'), JSON.stringify({ scope: 'actual components and CSS; synthetic native boundaries; no real authentication or permissions', results, errors }, null, 2) + '\n');
  console.log('PASS entry presentation: ' + results.join('; '));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
