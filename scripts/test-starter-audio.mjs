import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,sep} from 'node:path';
const root=resolve('assets/starter-audio'),manifest=JSON.parse(readFileSync(root+'/manifest.json'));
assert.equal(manifest.schema,'producer.audio-library/1');
assert.equal(manifest.owner,'Boomin');
assert.equal(manifest.assets.filter(a=>a.kind==='music').length,1);
assert.equal(manifest.assets.filter(a=>a.kind==='effect').length,255);
assert.equal(new Set(manifest.assets.map(a=>a.id)).size,256);
assert.equal(new Set(manifest.assets.filter(a=>a.kind==='effect').map(a=>a.sha256)).size,250);
for(const asset of manifest.assets){
 const path=resolve(root,asset.file);assert(path.startsWith(root+sep));
 const bytes=readFileSync(path);assert.equal(bytes.length,asset.bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
}
assert.equal(manifest.assets.find(a=>a.id==='waiting-in-case')?.duration_ms,187298);
const whoosh=manifest.assets.find(a=>a.id==='wind-whoosh');
const winner=manifest.assets.find(a=>a.id==='price-is-right-winner');
assert.equal(whoosh?.purpose,'transition');
assert.equal(winner?.purpose,'button');
for (const id of ['ahhhh-reaction','kanye-praise-the-lord','grandpa-too-damn-bad']) assert.equal(manifest.assets.find(a=>a.id===id)?.purpose,'reaction');
assert.ok(whoosh.duration_ms<1000&&winner.duration_ms>1000);
assert.equal(manifest.version,createHash('sha256').update(JSON.stringify(manifest.assets)).digest('hex'));
const classic=JSON.parse(readFileSync('docs/shows/classic.json'));
assert.deepEqual(classic.set.layouts.filter(l=>l.transitionSoundId===whoosh.sha256).map(l=>l.id),['solo-landscape','solo-portrait']);
const config=JSON.parse(readFileSync('src-tauri/tauri.conf.json'));
assert.equal(config.bundle.resources['../assets/starter-audio/'],'starter-audio/');
console.log('PASS owned starter pack: 255 catalog sounds / 250 unique effects, IN CASE and Classic transition, bundled resource path and all media checksums.');
