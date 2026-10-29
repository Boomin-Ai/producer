import { build } from 'esbuild';
import { open } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function validationRuntime() {
  const result = await build({
    entryPoints: ['src/features/presentation/validation.ts'],
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    bundle: true, platform: 'node', format: 'esm', write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('Usage: npm run validate:set -- package.json [package.json ...]'); process.exitCode = 2; return; }
  const { validatePackageText } = await validationRuntime();
  for (const file of files) {
    let handle;
    try {
      handle = await open(file, 'r');
      // Bounded read even if the file grows after opening; no network or assets fetched.
      const chunks = []; let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
        bytes += chunk.length;
        if (bytes > 40 * 1024 * 1024) break;
        chunks.push(chunk);
      }
      const result = bytes > 40 * 1024 * 1024
        ? { ok: false, issues: [{ code: 'package_too_large', path: '$', message: 'Set package exceeds 40 MB.' }] }
        : validatePackageText(Buffer.concat(chunks).toString('utf8'));
      const report = result.ok
        ? { ok: true, scope: 'package-structure', id: result.package.id, layouts: result.package.set.layouts.map(l => l.id), nativeReadiness: 'not-tested' }
        : result;
      console.log(JSON.stringify({ file, ...report }));
      if (!result.ok) process.exitCode = Math.max(Number(process.exitCode) || 0, 1);
    } catch (error) {
      console.log(JSON.stringify({ file, ok: false, issues: [{ code: 'validator_or_io_error', path: '$', message: error instanceof Error ? error.message : String(error) }] }));
      process.exitCode = 2;
    } finally { await handle?.close(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
