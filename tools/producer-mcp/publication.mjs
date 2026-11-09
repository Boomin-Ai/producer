import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { repository } from './runtime.mjs';

const API = 'https://api.boomin.ai';
const ROOT = '/v1/app/producer/v1';
const MAX_RESPONSE = 1024 * 1024;
let runtime;
export async function readBounded(handle, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
    size += chunk.length; if (size > limit) throw Error('File exceeds its publication byte budget.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export const publicationRuntime = () => runtime ??= build({
  absWorkingDir: repository, entryPoints: ['src/features/presentation/publication.ts'],
  bundle: true, platform: 'node', format: 'esm', write: false,
}).then(result => import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')));

/** Credentials are read only for an explicit publish/list operation and never returned. */
export async function publishingRequest(brand, path, { method = 'GET', body, configPath, fetcher = fetch } = {}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(brand) || brand.length > 80) throw Error('Select an exact Boomin workspace handle.');
  if (!path.startsWith(ROOT + '/') || path.includes('..') || path.includes('?') || path.includes('#')) throw Error('Invalid publishing route.');
  const credentialsPath = configPath ?? process.env.PRODUCER_PUBLISH_CONFIG ?? join(homedir(), '.boomin', 'config.json');
  let handle, config;
  try {
    handle = await open(credentialsPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024) throw Error('Invalid Boomin CLI credential file.');
    config = JSON.parse((await readBounded(handle, 64 * 1024)).toString('utf8'));
  } catch { throw Error('Sign in with the Boomin CLI; its credential file could not be read safely.'); }
  finally { await handle?.close(); }
  if (typeof config.authToken !== 'string' || !config.authToken) throw Error('Sign in with the Boomin CLI before publishing.');
  const url = new URL(path, API); url.searchParams.set('brandSlug', brand);
  const response = await fetcher(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: 'Bearer ' + config.authToken, 'Content-Type': 'application/json', 'X-Boomin-Client': 'producer-mcp/0.3.0' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let size = 0; const chunks = [];
  if (!response.body) throw Error('Publishing server returned an empty response.');
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_RESPONSE) { await reader.cancel(); throw Error('Publishing response exceeds its budget.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let result; try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('Publishing server returned invalid JSON.'); }
  if (!response.ok) {
    // An upstream error can contain credentials or arbitrary echoed user input.
    // Only expose a bounded machine code; the authenticated UI has richer errors.
    const code = result?.error?.code ?? result?.code;
    throw Error(`Publishing failed (${response.status}${typeof code === 'string' && /^[a-z_]{1,80}$/.test(code) ? ', ' + code : ''}).`);
  }
  return result;
}

export async function preparePublication(text, { slug, title, description = '', visibility = 'private', confirmPublic = false, thumbnailPath, idempotencyKey = randomUUID(), publicationId, expectedRevision } = {}) {
  if (!['private', 'unlisted', 'public'].includes(visibility)) throw Error('Choose private, unlisted or public visibility.');
  if (visibility !== 'private' && confirmPublic !== true) throw Error('Confirm that this package and its authored values/assets may be downloaded publicly.');
  const { validatePublicPackageText, PUBLIC_THUMBNAIL_BYTES } = await publicationRuntime();
  const checked = validatePublicPackageText(text);
  if (!checked.ok) throw Error(checked.errors.map(e => `${e.path}: ${e.message}`).join('\n'));
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? '') || slug.length > 80) throw Error('Choose a lowercase Set slug using letters, numbers and hyphens.');
  const name = title ?? checked.summary.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || description.length > 2000) throw Error('Set title or description is missing or too long.');
  if (publicationId && (!/^[a-f0-9-]{36}$/.test(publicationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw Error('Updates require the publication ID and exact current revision.');
  const body = { ...(publicationId ? { expected_revision: expectedRevision } : { slug }), title: name.trim(), description, visibility, package_text: checked.text, idempotency_key: idempotencyKey };
  if (thumbnailPath) {
    const handle = await open(thumbnailPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > PUBLIC_THUMBNAIL_BYTES) throw Error('Preview must be a PNG or JPEG of at most 512 KiB.');
      bytes = await readBounded(handle, PUBLIC_THUMBNAIL_BYTES);
      if (bytes.length > PUBLIC_THUMBNAIL_BYTES) throw Error('Preview exceeds 512 KiB.');
    } finally { await handle.close(); }
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw Error('Preview must contain PNG or JPEG bytes.');
    body.thumbnail = { mime_type: png ? 'image/png' : 'image/jpeg', data_base64: bytes.toString('base64') };
  }
  return { body, summary: checked.summary, path: publicationId ? `${ROOT}/sets/publications/${publicationId}/versions` : `${ROOT}/sets/publications` };
}

export async function publishPackage(text, options) {
  const prepared = await preparePublication(text, options);
  const result = await publishingRequest(options.brand, prepared.path, { method: 'POST', body: prepared.body, configPath: options.configPath, fetcher: options.fetcher });
  return { ...result, nativeReadiness: 'not-tested', outputChanged: false };
}
export const listPublications = (brand, options) => publishingRequest(brand, ROOT + '/sets/publications', options);
