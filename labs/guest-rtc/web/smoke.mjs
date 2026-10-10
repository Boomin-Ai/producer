import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)), lab = path.resolve(here, '..');
const guests = Number(process.argv[2] ?? 1), mode = process.argv[3] ?? 'normal';
if (![1, 3].includes(guests) || !['normal', 'pressure', 'republish'].includes(mode)) throw new Error('Use 1|3 normal|pressure|republish');
const name = process.env.LIVEKIT_LAB_RUN_NAME ?? `transport-${guests}-${mode}`;
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid run name');
const seconds = Number(process.env.LIVEKIT_LAB_SECONDS ?? 25);
await mkdir(path.join(lab, 'runtime'), { recursive: true });
const child = spawn(process.env.LIVEKIT_LAB_EXECUTABLE ?? path.join(lab, 'target/debug/producer-guest-rtc-lab'), ['transport',
  path.join(lab, 'runtime/native-token'), path.join(lab, `evidence/${name}.json`), String(seconds),
  ...(mode === 'pressure' ? ['pressure'] : [])], { cwd: lab });
let log = '', connected;
const ready = new Promise((resolve, reject) => {
  connected = resolve;
  child.on('error', reject);
  child.on('exit', code => { if (code !== 0) reject(new Error(`Native exit ${code}: ${log}`)); });
});
child.stdout.on('data', data => { log += data; process.stdout.write(data); if (log.includes('Native host connected')) connected(); });
child.stderr.on('data', data => { log += data; process.stderr.write(data); });
const done = new Promise(resolve => child.on('exit', code => resolve(code)));
let browser;
const pages = [];
try {
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Native connect timeout')), 15000))]);
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  for (let n = 1; n <= guests; n++) {
    const page = await browser.newPage(); pages.push(page);
    page.on('pageerror', error => console.error('Browser:', error.message));
    await page.goto(`http://127.0.0.1:8990/?identity=guest-${n}`);
    await page.evaluate(() => window.startLab());
    await page.waitForFunction(() => window.labState.published);
  }
  if (mode === 'republish') {
    await new Promise(resolve => setTimeout(resolve, 7000));
    await pages[0].evaluate(() => window.stopLab());
    await new Promise(resolve => setTimeout(resolve, 1000));
    await pages[0].evaluate(() => window.startLab());
  }
  await new Promise(resolve => setTimeout(resolve, 4000));
  const audioStats = await Promise.all(pages.map(page => page.evaluate(async () => {
    const stats = await window.returnAudioTrack?.getRTCStatsReport();
    return [...(stats?.values() ?? [])].filter(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio');
  })));
  const code = await done;
  const states = await Promise.all(pages.map(page => page.evaluate(() => window.labState)));
  await writeFile(path.join(lab, `evidence/${name}-browser.json`), JSON.stringify({
    browser: await browser.version(), guests, mode, states, audioStats,
    return_transport_observed: states.every(s => s.returnVideoFrames > 20 && s.returnAudioPulses > 2),
    hardware_capture_used: false, physical_speaker_playout_used: false,
  }, null, 2));
  if (code !== 0) throw new Error(`Native exited ${code}`);
  if (states.some(s => s.error || s.returnVideoFrames < 20 || s.returnAudioPulses < 3)) throw new Error(`Missing return media: ${JSON.stringify(states)}`);
  console.log(`Browser/native transport passed: ${guests} guests, ${mode}`);
} finally {
  await writeFile(path.join(lab, `runtime/${name}.log`), log);
  await Promise.allSettled(pages.map(page => page.evaluate(() => window.stopLab())));
  await browser?.close(); if (child.exitCode === null) child.kill('SIGTERM');
}
