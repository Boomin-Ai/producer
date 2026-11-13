import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,sep} from 'node:path';
const root=resolve('assets/starter-audio'),manifest=JSON.parse(readFileSync(root+'/manifest.json'));
assert.equal(manifest.schema,'producer.audio-library/1');
assert.equal(manifest.owner,'Boomin');
assert.equal(manifest.assets.filter(a=>a.kind==='music').length,1);
assert.equal(manifest.assets.filter(a=>a.kind==='effect').length,250);
assert.equal(new Set(manifest.assets.map(a=>a.id)).size,251);
assert.equal(new Set(manifest.assets.filter(a=>a.kind==='effect').map(a=>a.sha256)).size,245);
for(const asset of manifest.assets){
 const path=resolve(root,asset.file);assert(path.startsWith(root+sep));
 const bytes=readFileSync(path);assert.equal(bytes.length,asset.bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
}
assert.equal(manifest.assets.find(a=>a.id==='waiting-in-case')?.duration_ms,187298);
const config=JSON.parse(readFileSync('src-tauri/tauri.conf.json'));
assert.equal(config.bundle.resources['../assets/starter-audio/'],'starter-audio/');
console.log('PASS owned starter pack: 250 catalog sounds / 245 unique effects, IN CASE, bundled resource path and all media checksums.');
