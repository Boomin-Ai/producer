import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function loadRuntime() {
  const bundled = await build({ stdin: { contents: `export * from './src/features/presentation/schema';
export * from './src/features/presentation/fixtures';export * from './src/features/presentation/rehearsal';
export * from './src/features/presentation/projection';`, resolveDir: process.cwd() }, bundle:true,platform:'node',format:'esm',write:false });
  const dir=await mkdtemp(join(tmpdir(),'producer-set-proof-runtime-'));
  try {const file=join(dir,'runtime.mjs');await writeFile(file,bundled.outputFiles[0].text);return await import(pathToFileURL(file));}
  finally {await rm(dir,{recursive:true,force:true});}
}
