// JS structural checks and the required native semantic companion are tested
// separately. A parsed JSON Schema validator cannot detect raw duplicate keys.
import Ajv2020 from 'ajv/dist/2020.js';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
const binary=process.argv[2], schema=JSON.parse(readFileSync(new URL('../generated/document.schema.json',import.meta.url)));
const ajv=new Ajv2020({strict:false,allErrors:true});
ajv.addFormat('uint32',{type:'number',validate:value=>Number.isInteger(value)&&value>=0&&value<=4294967295});
ajv.addFormat('double',{type:'number',validate:Number.isFinite});
ajv.addKeyword({keyword:'x-maxUtf8Bytes',type:'string',schemaType:'number',validate:(limit,value)=>Buffer.byteLength(value,'utf8')<=limit});
ajv.addKeyword({keyword:'x-nativeRange',type:'string',schemaType:'string',validate:(kind,value)=>{try{return kind!=='u64'||(BigInt(value)>=0n&&BigInt(value)<=18446744073709551615n);}catch{return false;}}});
const structural=ajv.compile(schema), fixture=JSON.parse(execFileSync(binary,['fixture'],{encoding:'utf8'}));
const badShape=structuredClone(fixture);badShape.extra=true;
const badSemantic=structuredClone(fixture);badSemantic.sequences.opener.placements[0].source='missing';
const byteLimit=structuredClone(fixture);byteLimit.title='é'.repeat(32769);
const duplicate=JSON.stringify(fixture).replace('"id":"classic-lab"','"id":"ignored","id":"classic-lab"');
const cases=[['valid',JSON.stringify(fixture),true,null],['shape',JSON.stringify(badShape),false,'STRUCTURE'],['semantic',JSON.stringify(badSemantic),true,'SEMANTIC'],['utf8',JSON.stringify(byteLimit),false,'RAW_JSON'],['duplicate',duplicate,true,'RAW_JSON']];
const nested=JSON.parse(execFileSync(binary,['nested-fixture'],{encoding:'utf8'}));
const nestedConflict=structuredClone(nested);nestedConflict.sequences.timeline.instances[1].sourceBindings=[];
const unknownInstance=structuredClone(nested);unknownInstance.sequences.timeline.instances[0].unchecked=true;
const cyclic=structuredClone(nested);cyclic.sequences.timeline.instances[0].sequence='timeline';
cases.push(['nested',JSON.stringify(nested),true,null],['nested-driver',JSON.stringify(nestedConflict),true,'DRIVER_CONFLICT'],['nested-shape',JSON.stringify(unknownInstance),false,'STRUCTURE'],['nested-cycle',JSON.stringify(cyclic),true,'TEMPORAL']);
const directory=mkdtempSync(join(tmpdir(),'producer-schema-'));
try{for(const[name,raw,shape,code]of cases){if(Boolean(structural(JSON.parse(raw)))!==shape)throw Error(`structural mismatch ${name}: ${JSON.stringify(structural.errors)}`);const path=join(directory,`${name}.json`);writeFileSync(path,raw);const result=spawnSync(binary,['validate',path],{encoding:'utf8'});if(code){if(result.status===0||JSON.parse(result.stderr).code!==code)throw Error(`native stage mismatch ${name}: ${result.stderr}`);}else if(result.status!==0)throw Error(result.stderr);}}
finally{rmSync(directory,{recursive:true,force:true});}
console.log(`JS structural / native companion conformance: ${cases.length} cases passed`);
