import assert from 'node:assert/strict';
import {build} from 'esbuild';
const result=await build({entryPoints:['src/features/presentation/layoutFields.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {layoutFieldKeys}=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const doc={set:{components:{caption:{root:{type:'text',text:{get:'props.title'}}}},layouts:[
 {id:'intro',root:{type:'box',children:[{type:'text',text:{get:'values.hostName'}},{type:'text',text:{get:'values.opening'}}]}},
 {id:'chips',root:{type:'box',children:[{type:'text',text:{get:'values.hostName'}},{type:'component',component:'caption',props:{title:{op:'concat',args:['Discuss: ',{get:'values.chipsQuestion'}]}}}]}},
 {id:'panel',root:{type:'box',children:[{type:'text',text:{op:'concat',args:[{get:'values.analystOneName'},{get:'values.analystTwoName'}]}}]}}
]}};
assert.deepEqual([...layoutFieldKeys(doc,'intro')].sort(),['hostName','opening']);
assert.deepEqual([...layoutFieldKeys(doc,'chips')].sort(),['chipsQuestion','hostName']);
assert.deepEqual([...layoutFieldKeys(doc,'panel')].sort(),['analystOneName','analystTwoName']);
assert.equal(layoutFieldKeys(doc,'unknown').size,0);
console.log('PASS: each layout exposes its bound fields, including expressions and reusable component props.');
