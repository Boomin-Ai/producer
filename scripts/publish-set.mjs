#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { publishPackage, listPublications, publicationRuntime, readBounded } from '../tools/producer-mcp/publication.mjs';

const args = process.argv.slice(2), options = {};
const switches = new Set(['confirm-public', 'list']);
const names = new Set(['brand', 'file', 'slug', 'title', 'description', 'visibility', 'thumbnail', 'idempotency-key', 'publication-id', 'expected-revision', ...switches]);
try {
  for (let index = 0; index < args.length; index++) {
    const key = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || !names.has(key) || Object.hasOwn(options, key)) throw Error('Unknown or repeated argument.');
    options[key] = switches.has(key) ? true : args[++index];
    if (options[key] === undefined || typeof options[key] === 'string' && options[key].startsWith('--')) throw Error('Missing argument value.');
  }
  if (!options.brand || !options.list && (!options.file || !options.slug)) throw Error('Usage: node scripts/publish-set.mjs --brand HANDLE --file SET.set.json --slug NAME [--visibility private|unlisted|public --confirm-public] [--thumbnail PREVIEW.png]. Use --list to inspect current publications.');
  if (options.list) console.log(JSON.stringify(await listPublications(options.brand), null, 2));
  else {
    const { PUBLIC_PACKAGE_BYTES } = await publicationRuntime();
    const handle = await open(options.file, constants.O_RDONLY | constants.O_NOFOLLOW); let text;
    try {
      const info = await handle.stat(); if (!info.isFile() || info.size > PUBLIC_PACKAGE_BYTES) throw Error('Public Set files must be regular files of at most 8 MiB.');
      text = (await readBounded(handle, PUBLIC_PACKAGE_BYTES)).toString('utf8');
      if (Buffer.byteLength(text) > PUBLIC_PACKAGE_BYTES) throw Error('Public Set exceeds 8 MiB.');
    } finally { await handle.close(); }
    const result = await publishPackage(text, { brand: options.brand, slug: options.slug, title: options.title, description: options.description,
      visibility: options.visibility ?? 'private', confirmPublic: options['confirm-public'] === true, thumbnailPath: options.thumbnail,
      idempotencyKey: options['idempotency-key'], publicationId: options['publication-id'], expectedRevision: options['expected-revision'] === undefined ? undefined : Number(options['expected-revision']) });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error instanceof Error ? error.message : 'Set publishing failed.'); process.exitCode = 1; }
