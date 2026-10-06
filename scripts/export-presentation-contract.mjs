import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
const result = await build({ stdin: { contents: `export * from './src/features/presentation/schema'; export * from './src/features/presentation/fixtures';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { presentationJsonSchema, AFTER_HOURS, HEAD_TO_HEAD } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
await mkdir('docs/shows/fixtures', { recursive: true });
for (const [path, data] of [['docs/shows/presentation.schema.json', presentationJsonSchema], ['docs/shows/fixtures/after-hours.set.json', AFTER_HOURS], ['docs/shows/fixtures/head-to-head.presentation.json', HEAD_TO_HEAD]]) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n'); console.log(path);
}
