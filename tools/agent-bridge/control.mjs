import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { authHeaders, loadConfig, atomicJson } from './client.mjs';

const [command, path, eventId] = process.argv.slice(2);
const config = await loadConfig(resolve(path ?? 'bridge.local.json'));
if (command === 'status') {
  const remote = await fetch(`${config.relay}/status?peer=${config.peer}`, { headers: await authHeaders(config), signal: AbortSignal.timeout(15_000) });
  if (!remote.ok) throw new Error(`Relay status HTTP ${remote.status}`);
  const local = JSON.parse(await readFile(join(config.stateDir,'status.json'),'utf8').catch(()=>'{"listener":"not started"}'));
  let processRunning = false;
  if (Number.isSafeInteger(local.pid)) { try { process.kill(local.pid,0); processRunning=true; } catch {} }
  local.processRunning = processRunning;
  local.connected = Boolean(local.connected && processRunning);
  console.log(JSON.stringify({local,relay:await remote.json()},null,2));
} else if (command === 'pause') {
  await writeFile(join(config.stateDir,'PAUSED'),'Paused by operator\n',{mode:0o600});
  console.log('New worker turns paused; an already-running turn may finish. Transport continues saving events.');
} else if (command === 'resume') {
  await unlink(join(config.stateDir,'PAUSED')).catch(error=>{if(error.code!=='ENOENT')throw error;});
  console.log('Worker queue resumed.');
} else if (command === 'retry') {
  // Pause first, so a live writer cannot race an operator's state repair.
  throw new Error('Review the failed worker thread, stop the listener, then explicitly move the reviewed event from failed to pending in state.json. Automatic blind retry is deliberately disabled.');
} else throw new Error('Usage: node control.mjs status|pause|resume <private-config.json>');
