import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const directory=await mkdtemp(join(tmpdir(),'producer-authoring-cli-'));
const run=(...args)=>spawnSync(process.execPath,['scripts/generate-set.mjs',...args],{encoding:'utf8'});
try{
 const cap=run('capabilities');assert.equal(cap.status,0,cap.stderr);assert.equal(JSON.parse(cap.stdout).catalog.revision,2);assert.equal(JSON.parse(cap.stdout).catalog.limits.controls,128);
 const plan={schema:'producer.design-plan/1',id:'cli-studio',name:'CLI studio',background:'#101010',layouts:[{id:'main',name:'Main',orientation:'landscape',elements:[{id:'title',kind:'text',bounds:[40,40,1200,120],text:'Producer',field:'title'}]}]};
 const input=join(directory,'plan.json'),out=join(directory,'studio.set.json');await writeFile(input,JSON.stringify(plan));
 const compiled=run('compile','--plan',input,'--out',out);assert.equal(compiled.status,0,compiled.stderr);const metadata=JSON.parse(compiled.stdout);assert.equal(metadata.nativeReadiness,'not-tested');
 const original=await readFile(out,'utf8');assert.equal(run('compile','--plan',input,'--out',out).status,1);assert.equal(await readFile(out,'utf8'),original,'CLI never overwrites a Set');
 const edit=join(directory,'edit.json'),edited=join(directory,'edited.set.json');await writeFile(edit,JSON.stringify({schema:'producer.set-edit/2',baseRevision:metadata.revision,operations:[{op:'replace',path:'/set/values/title/default',value:'Edited through CLI'}]}));
 const changed=run('edit','--base',out,'--edit',edit,'--out',edited);assert.equal(changed.status,0,changed.stderr);assert.equal(JSON.parse(await readFile(edited,'utf8')).set.values.title.default,'Edited through CLI');
 assert.equal(run('edit','--base',edited,'--edit',edit,'--out',join(directory,'stale.set.json')).status,1);
 assert.deepEqual(JSON.parse(run('requirements','--file',out).stdout).integrations,[]);
 const html=join(directory,'preview.html');const preview=run('preview','--file',out,'--out',html);assert.equal(preview.status,0,preview.stderr);assert.match(await readFile(html,'utf8'),/Browser preview only/);
 console.log('PASS: CLI discovery, compilation, immutable outputs, canonical edits, stale revision rejection, requirement reports and real-renderer preview generation');
}finally{await rm(directory,{recursive:true,force:true});}
