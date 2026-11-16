// Independent JS canonicalization check; native raw/semantic admission remains mandatory.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const binary=process.argv[2];
const document=JSON.parse(execFileSync(binary,['fixture'],{encoding:'utf8'}));
function canonical(x){if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';return JSON.stringify(x);}
const hash=createHash('sha256').update('producer.production/1\0').update(canonical(document)).digest('hex');
const path=new URL('../generated/classic-like.json',import.meta.url);
const native=JSON.parse(execFileSync(binary,['validate',path.pathname],{encoding:'utf8'}));
if(hash!==native.digest)throw Error('JavaScript/Rust canonical hash mismatch');
const types=readFileSync(new URL('../generated/contract.d.ts',import.meta.url),'utf8');
if(!types.includes('export type Request')||!types.includes('export type Document'))throw Error('Missing generated models');
console.log(`JavaScript/Rust canonical hash agrees: ${hash}`);
