import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicationRuntime, preparePublication, publishingRequest } from '../tools/producer-mcp/publication.mjs';
const api = await publicationRuntime();
const source = await readFile('docs/shows/atmosphere.json', 'utf8');
const doc = JSON.parse(source);
const checked = api.validatePublicPackageText(source);
assert.equal(checked.ok, true, JSON.stringify(checked.errors));
assert.equal(checked.summary.layout_count, 6);
assert.deepEqual([...checked.summary.orientations].sort(), ['landscape','portrait']);
assert.equal(api.validatePublicPackageText(checked.text).text, checked.text, 'canonical admission is stable');
function rejects(value, code) {
  const result = api.validatePublicPackageText(typeof value === 'string' ? value : JSON.stringify(value));
  assert.equal(result.ok, false); assert.equal(result.errors[0].code, code); return result;
}
rejects(' '.repeat(api.PUBLIC_PACKAGE_BYTES + 1), 'package_too_large');
rejects('é'.repeat(api.PUBLIC_PACKAGE_BYTES / 2 + 1), 'package_too_large');
rejects('['.repeat(65)+'0'+']'.repeat(65), 'nesting_limit');
rejects({ ...doc, room: { streamKey: 'secret-not-published' } }, 'invalid_package');
const privateAsset = structuredClone(doc);
privateAsset.set.assets = { ...privateAsset.set.assets, privateVideo: { name: 'private', mime: 'video/mp4', data: 'producer-media:11111111-1111-4111-8111-111111111111' } };
rejects(privateAsset, 'local_reference');
const tokenDoc = structuredClone(doc); tokenDoc.set.values.publishNote = { type:'text', maxLength:4096, default:'https://example.com/?access_token=private-marker-do-not-echo' };
const rejected = rejects(tokenDoc, 'credential_reference');
assert(!JSON.stringify(rejected).includes('private-marker-do-not-echo'));
tokenDoc.set.values.publishNote.default='Visit https://producer.dev/kleveland/set/internetdj';
assert.equal(api.validatePublicPackageText(JSON.stringify(tokenDoc)).ok, true, 'ordinary CTA links are portable text');
const prepared=await preparePublication(source,{slug:'atmosphere',visibility:'private',idempotencyKey:'public-test'});
assert.equal(prepared.body.visibility,'private'); assert.equal(prepared.body.package_text, checked.text);
await assert.rejects(()=>preparePublication(source,{slug:'atmosphere',visibility:'public'}), /Confirm/);
await assert.rejects(()=>preparePublication(source,{slug:'../escape',visibility:'private'}), /slug/);
await assert.rejects(()=>preparePublication(source,{slug:'atmosphere',publicationId:'11111111-1111-4111-8111-111111111111'}), /revision/);
const dir=await mkdtemp(join(tmpdir(),'producer-publication-'));
try {
  const credentialFile=join(dir,'config.json'); await writeFile(credentialFile,JSON.stringify({authToken:'private-auth-marker'}),{mode:0o600});
  let calls=0;
  const success=await publishingRequest('kleveland','/v1/app/producer/v1/profile',{configPath:credentialFile,fetcher:async(url,options)=>{
    calls++; assert.equal(url.origin,'https://api.boomin.ai'); assert.equal(url.searchParams.get('brandSlug'),'kleveland');
    assert.equal(options.headers.Authorization,'Bearer private-auth-marker'); assert.equal(options.redirect,'error');
    return Response.json({handle:'kleveland'});
  }});
  assert.deepEqual(success,{handle:'kleveland'});assert.equal(calls,1);
  await assert.rejects(()=>publishingRequest('kleveland','https://elsewhere.example',{configPath:credentialFile,fetcher:()=>{throw Error('must not fetch');}}),/route/);
  await assert.rejects(()=>publishingRequest('../other','/v1/app/producer/v1/profile',{configPath:credentialFile}),/workspace/);
  const redacted=await publishingRequest('kleveland','/v1/app/producer/v1/profile',{configPath:credentialFile,fetcher:async()=>Response.json({error:{code:'access_denied',message:'private-auth-marker'}},{status:403})}).catch(error=>error.message);
  assert.match(redacted,/403, access_denied/);assert(!redacted.includes('private-auth-marker'));
  await symlink(credentialFile,join(dir,'symlink.json'));
  await assert.rejects(()=>publishingRequest('kleveland','/v1/app/producer/v1/profile',{configPath:join(dir,'symlink.json')}));
} finally { await rm(dir,{recursive:true,force:true}); }
console.log('PASS: full six-layout admission, UTF-8/depth budgets, canonical stability, local/credential reference rejection, explicit public consent, revision fences, credential destination binding and redacted errors.');
