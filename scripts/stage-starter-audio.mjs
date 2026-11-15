// Owner-supplied audio, packaged once; no user-profile paths enter the manifest.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const [source,music]=process.argv.slice(2);
if(!source||!music)throw Error('Usage: node scripts/stage-starter-audio.mjs <catalog directory> <IN CASE mp3>');
const output=resolve('assets/starter-audio');await mkdir(join(output,'files'),{recursive:true});
const previous=await readFile(join(output,'manifest.json'),'utf8').catch(error=>{
  if (error.code==='ENOENT') return '{"assets":[]}';
  throw error;
});
const previousAssets=JSON.parse(previous).assets;
const curated=previousAssets.filter(asset=>asset.source&&asset.purpose);
const catalogMetadata=new Map(previousAssets.filter(asset=>!asset.source&&asset.purpose).map(asset=>[asset.sha256,{purpose:asset.purpose,description:asset.description}]));
const assets=[];
async function add(id,kind,name,file,duration_ms=0){const bytes=await readFile(file);const sha256=createHash('sha256').update(bytes).digest('hex');await copyFile(file,join(output,'files',sha256+'.mp3'));assets.push({id,kind,name,file:'files/'+sha256+'.mp3',sha256,bytes:bytes.length,duration_ms,...catalogMetadata.get(sha256)});}
for(const row of JSON.parse(await readFile(join(source,'catalog.json'),'utf8')))await add('effect-'+String(row.rank).padStart(3,'0'),'effect',row.title,join(source,row.file));
await add('waiting-in-case','music','IN CASE',music,187298);
for (const asset of curated) {
  const bytes=await readFile(join(output,asset.file));
  if (bytes.length!==asset.bytes || createHash('sha256').update(bytes).digest('hex')!==asset.sha256) {
    throw Error(`Invalid curated cue: ${asset.name}`);
  }
  assets.push(asset);
}
const version=createHash('sha256').update(JSON.stringify(assets)).digest('hex');
await writeFile(join(output,'manifest.json'),JSON.stringify({schema:'producer.audio-library/1',version,owner:'Boomin',assets},null,2)+'\n');
console.log(JSON.stringify({entries:assets.length,uniqueFiles:new Set(assets.map(a=>a.sha256)).size,version}));
