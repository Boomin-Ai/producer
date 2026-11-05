import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), 'producer-readiness-progress-'));
const binary = path.join(output, 'readiness-progress');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
try {
  run(process.env.CC ?? 'cc', [
    '-std=c11', '-Wall', '-Wextra', '-Werror', '-Isrc-tauri/src/live',
    'scripts/sets-v2/test-readiness-progress.c',
    'src-tauri/src/live/sets_v2/readiness.c', '-o', binary,
  ]);
  run(binary, []);
} finally {
  await rm(output, { recursive: true, force: true });
}
