import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url)), lab = path.resolve(here, '..');
if (process.env.LIVEKIT_LAB_PHYSICAL_CAPTURE === '1') throw new Error('Generated smoke does not accept physical microphone publication; use the explicit physical runner');
const guests = Number(process.argv[2] ?? 1), mode = process.argv[3] ?? 'normal';
if (![1, 3].includes(guests) || !['normal', 'pressure', 'republish', 'network', 'hard-loss', 'churn'].includes(mode)) throw new Error('Use 1|3 normal|pressure|republish|network|hard-loss|churn');
const name = process.env.LIVEKIT_LAB_RUN_NAME ?? `transport-${guests}-${mode}`;
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid run name');
const seconds = Number(process.env.LIVEKIT_LAB_SECONDS ?? 25);
const packetLoss = Number(process.env.LIVEKIT_LAB_PACKET_LOSS ?? 2);
if (!Number.isFinite(packetLoss) || packetLoss < 0 || packetLoss > 100) throw new Error('Packet loss must be 0..100');
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
const impairments = [];
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
    if (mode === 'network') {
      const session = await page.context().newCDPSession(page);
      const conditions = { urlPattern: '', latency: 60, downloadThroughput: 250000,
        uploadThroughput: 250000, packetLoss, packetQueueLength: 50, packetReordering: true };
      const response = await session.send('Network.emulateNetworkConditionsByRule', {
        offline: false, matchedNetworkConditions: [conditions],
      });
      impairments.push({ identity: `guest-${n}`, conditions, ruleAccepted: !!response.ruleIds?.length,
        mediaPathEffectVerified: false });
    }
  }
  if (mode === 'churn') {
    for (let cycle = 0; cycle < 3; cycle++) {
      await new Promise(resolve => setTimeout(resolve,6000));
      await pages[0].evaluate(() => window.stopLab());
      await new Promise(resolve => setTimeout(resolve,1000));
      await pages[0].evaluate(() => window.startLab());
    }
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
  const packetProbe = mode === 'network' ? await Promise.all(pages.map(async (page, index) => {
    const before = audioStats[index].reduce((sum,s) => sum + (s.packetsReceived ?? 0),0);
    await new Promise(resolve => setTimeout(resolve,4000));
    const after = await page.evaluate(async () => [...((await window.returnAudioTrack?.getRTCStatsReport())?.values() ?? [])]
      .filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').reduce((sum,s) => sum + (s.packetsReceived ?? 0),0));
    return {identity:`guest-${index+1}`,returnAudioPacketsInFourSeconds:after-before,
      full_packet_loss_control: Number(process.env.LIVEKIT_LAB_PACKET_LOSS) === 100,
      hard_loss_effect_observed:Number(process.env.LIVEKIT_LAB_PACKET_LOSS) === 100 && after-before === 0};
  })) : [];
  const code = await done;
  let relay;
  if (process.env.LIVEKIT_LAB_URL === 'ws://127.0.0.1:7885') {
    const response = await fetch('http://127.0.0.1:7885/stats',{signal:AbortSignal.timeout(3000)});
    if (!response.ok) throw new Error('Packet relay stats unavailable');
    relay = await response.json();
    await writeFile(path.join(lab,`evidence/${name}-packet.json`),JSON.stringify(relay,null,2));
  }
  const states = await Promise.all(pages.map(page => page.evaluate(() => window.labState)));
  await writeFile(path.join(lab, `evidence/${name}-browser.json`), JSON.stringify({
    browser: await browser.version(), guests, mode, states, audioStats, impairments, packetProbe,
    return_transport_observed: states.every(s => s.returnVideoFrames > 20 && s.returnAudioPulses > 2),
    hardware_capture_used: false, physical_speaker_playout_used: false,
  }, null, 2));
  if (code !== 0) throw new Error(`Native exited ${code}`);
  if (mode === 'hard-loss') {
    const media = Object.entries(relay?.packets ?? {}).filter(([kind]) => !kind.endsWith(':control'));
    if (relay?.profile !== 'hard-loss' || media.length === 0 || media.some(([,s]) => s.forwarded !== 0) ||
        !media.some(([,s]) => s.dropped > 50) || states.some(s => s.returnVideoFrames !== 0 || s.returnAudioPulses !== 0)) {
      throw new Error('Packet hard-loss control did not suppress media');
    }
    console.log('Packet hard-loss control passed: RTP dropped, no return video/audio markers');
  } else if (states.some(s => s.error || s.returnVideoFrames < 20 || s.returnAudioPulses < 3)) throw new Error(`Missing return media: ${JSON.stringify(states)}`);
  console.log(`Browser/native transport passed: ${guests} guests, ${mode}`);
} finally {
  await writeFile(path.join(lab, `runtime/${name}.log`), log);
  await Promise.allSettled(pages.map(page => page.evaluate(() => window.stopLab())));
  await browser?.close(); if (child.exitCode === null) child.kill('SIGTERM');
}
