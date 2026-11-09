import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {test} from 'node:test';
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/features/presentation/publicationClient.ts',import.meta.url),'utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports,structuredClone,setTimeout,clearTimeout,require:()=>({guests:{request(){throw Error('Unexpected real IPC');}}})});
const {createPublicationClient,createPublicationUpload,PublicationError,publicationLinks,publicationMetadataIssue}=exports;
const row={id:'publication-1',handle:'kleveland',slug:'internetdj',title:'Internet DJ',description:'Configured Set',status:'published',visibility:'private',revision:3,version:2,sha256:'a'.repeat(64),byte_length:100,layout_count:2,orientations:['landscape','portrait']};
const value={title:'Internet DJ',description:'Configured Set',visibility:'private',package_text:'{"portable":true}',slug:'internetdj'};
const plain=value=>JSON.parse(JSON.stringify(value));
test('client fixes API-root routes and endpoint scope; create/version/status preserve revision and idempotency',async()=>{
 const calls=[],client=createPublicationClient('workspace-a',async(endpoint,method,path,body)=>{calls.push({endpoint,method,path,body});return {available:true,status:200,body:{publication:row}};});
 await client.upload(value,'retained-key');await client.upload({...value,slug:undefined,expected_revision:3},'version-key',row.id);await client.status(row,'withdrawn','status-key');
 assert(calls.every(c=>c.endpoint==='workspace-a'&&c.path.startsWith('/v1/app/producer/v1/sets/publications')));
 assert.equal(calls[0].body.idempotency_key,'retained-key');assert.equal(calls[1].path,'/v1/app/producer/v1/sets/publications/publication-1/versions');assert.equal(calls[1].body.expected_revision,3);
 assert.deepEqual(plain(calls[2].body),{status:'withdrawn',visibility:'private',expected_revision:3,idempotency_key:'status-key'});assert(!JSON.stringify(calls).includes('Bearer'));
});
test('failed upload retains immutable intent/key; double retry shares one in-flight write',async()=>{
 const calls=[];let first=true,resolve;
 const upload=createPublicationUpload({upload:async(body,key,id)=>{calls.push({body:plain(body),key,id});if(first){first=false;throw Error('synthetic response lost');}return new Promise(done=>{resolve=done;});}},()=> 'same-key');
 const original=structuredClone(value);await assert.rejects(upload.start(original));original.title='Changed after submission';
 const retry=upload.retry();assert.equal(upload.retry(),retry);assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);resolve(row);assert.equal(await retry,row);assert.equal(upload.hasPending(),false);
});
test('pending intent cannot be silently replaced; explicit discard permits a new request key',async()=>{
 let sequence=0;const calls=[],upload=createPublicationUpload({upload:async(body,key)=>{calls.push({body,key});throw Error('failed');}},()=>String(++sequence));
 await assert.rejects(upload.start(value));await assert.rejects(upload.start({...value,title:'Other'}),PublicationError);assert.equal(calls.length,1);
 upload.discard();await assert.rejects(upload.start({...value,title:'Other'}));assert.equal(calls[1].key,'2');
});
test('ambiguous status mutation retains the same key, revision, visibility and selected publication',async()=>{
 let first=true;const calls=[],upload=createPublicationUpload({status:async(item,status,key,visibility)=>{calls.push({item:plain(item),status,key,visibility});if(first){first=false;throw Error('reply lost');}return {...row,status};}},()=> 'same-status-key');
 const original=structuredClone(row);await assert.rejects(upload.changeStatus(original,'withdrawn'));original.revision=99;await upload.retry();assert.deepEqual(calls[0],calls[1]);assert.equal(calls[1].item.revision,3);assert.equal(upload.hasPending(),false);
});
test('private draft receipt is admitted without claiming a published Set',async()=>{
 const client=createPublicationClient('scope',async()=>({available:true,status:201,body:{publication:{...row,status:'draft'}}}));assert.equal((await client.upload(value,'draft-key')).status,'draft');
});
test('shared metadata admission permits title160/description2000 and rejects over-boundary requests before transport',async()=>{
 let calls=0;const client=createPublicationClient('scope',async()=>{calls++;return {available:true,status:201,body:{publication:row}};});
 const boundary={...value,title:'t'.repeat(160),description:'d'.repeat(2000)};assert.equal(publicationMetadataIssue(boundary),null);await client.upload(boundary,'boundary-key');assert.equal(calls,1);
 for(const broken of [{...value,title:'t'.repeat(161)},{...value,title:'   '},{...value,description:'d'.repeat(2001)}]){
  assert(publicationMetadataIssue(broken));await assert.rejects(client.upload(broken,'rejected-key'),error=>error.code==='rejected');
 }
 assert.equal(calls,1);
});
test('observable400/422 admission rejections release retry locks for explicit corrected submissions',async()=>{
 for(const status of [400,422]){
  let reject=true,sequence=0;const calls=[],client=createPublicationClient('scope',async(_endpoint,_method,_path,body)=>{
   calls.push(body);return reject?{available:true,status,body:{error:'PRIVATE_REJECTION'}}:{available:true,status:201,body:{publication:row}};
  });
  const upload=createPublicationUpload(client,()=>String(++sequence));await assert.rejects(upload.start(value),error=>error.code==='rejected'&&!error.message.includes('PRIVATE'));
  assert.equal(upload.hasPending(),false);reject=false;await upload.start({...value,title:'Corrected'});assert.equal(calls.length,2);assert.notEqual(calls[0].idempotency_key,calls[1].idempotency_key);
 }
});
test('unsupported, denied, revision conflict and private upstream errors are sanitized',async()=>{
 for(const [status,code]of [[404,'unavailable'],[403,'denied'],[409,'conflict'],[500,'failed']]){
  const client=createPublicationClient('scope',async()=>({available:status!==404,status,body:{error:{message:'PRIVATE_SECRET'}}}));
  await assert.rejects(client.list(),error=>error.code===code&&!error.message.includes('PRIVATE'));
 }
 await assert.rejects(createPublicationClient('scope',async()=>{throw Error('PRIVATE_TOKEN');}).list(),error=>error.code==='failed'&&!error.message.includes('PRIVATE'));
});
test('response admission rejects malformed URLs/metadata and only constructs canonical Producer links',async()=>{
 for(const broken of [{...row,handle:'evil.example/x'},{...row,handle:'not_canonical'},{...row,slug:'../secret'},{...row,sha256:'token'},{...row,version:null}]){
  const client=createPublicationClient('scope',async()=>({available:true,status:200,body:{publications:[broken]}}));await assert.rejects(client.list(),error=>error.code==='invalid_response');
 }
 assert.deepEqual(plain(publicationLinks({...row,url:'https://evil.example'})),{url:'https://producer.dev/kleveland/set/internetdj',download_url:'https://producer.dev/kleveland/set/internetdj/download'});
});
test('profile/list reads expose only typed metadata and no publication action',async()=>{
 const calls=[],client=createPublicationClient('scope',async(_endpoint,method,path)=>{calls.push({method,path});return {available:true,status:200,body:path.endsWith('/profile')?{handle:'kleveland',name:'Kleveland',editable:true,private_token:'SECRET'}:{publications:[row],limits:{package_bytes:8388608,thumbnail_bytes:524288}}};});
 assert.deepEqual(plain(await client.profile()),{handle:'kleveland',name:'Kleveland',editable:true});assert.equal((await client.list()).length,1);assert(calls.every(c=>c.method==='GET'));
});
