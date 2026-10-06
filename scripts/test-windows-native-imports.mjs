import fs from 'node:fs';
import assert from 'node:assert/strict';
const ffi=fs.readFileSync('src-tauri/src/live/ffi.rs','utf8');
const imports=new Set([...ffi.matchAll(/pub fn (\w+)\s*\(/g)].map(m=>m[1]));
const missing=[];
for(const file of ['shim_win.c','source_appearance.c']) {
 const source=fs.readFileSync(`src-tauri/src/live/${file}`,'utf8')
  .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,'')
  .replace(/"(?:\\.|[^"\\])*"/g,'');
 const calls=new Set([...source.matchAll(/\b((?:obs_|gs_)\w+|blog|bfree)\s*\(/g)].map(m=>m[1]));
 for(const call of calls)if(!imports.has(call))missing.push(`${file}: ${call}`);
}
assert.deepEqual(missing,[],`C engine calls missing from Windows raw-dylib imports:\n${missing.join('\n')}`);
console.log('PASS: Windows native C calls are covered by raw-dylib imports.');
