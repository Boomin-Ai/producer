import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const site = fileURLToPath(new URL('../site/', import.meta.url));
const license = await readFile(join(site, 'effects/LICENSE.react-bits.md'), 'utf8');
const output = await mkdtemp(join(tmpdir(), 'producer-hero-'));

try {
  await build({
    configFile: false,
    root: site,
    esbuild: { jsx: 'automatic', legalComments: 'inline' },
    build: {
      outDir: output,
      emptyOutDir: true,
      copyPublicDir: false,
      rollupOptions: {
        input: join(site, 'effects/hero.jsx'),
        output: { entryFileNames: 'hero-effects.js', banner: '/*!\n' + license.trim() + '\n*/' }
      }
    }
  });
  await copyFile(join(output, 'hero-effects.js'), join(site, 'hero-effects.js'));
} finally {
  await rm(output, { recursive: true, force: true });
}
