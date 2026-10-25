/** Structural interchange schema; parseRuntimeDefinition also validates references,
 * authority, expression scope and lifecycle invariants that JSON Schema cannot. */
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const text=(maxLength:number)=>({type:'string',maxLength});
const id={type:'string',pattern:'^[a-zA-Z][a-zA-Z0-9_-]{0,63}$',not:{enum:['constructor','prototype','__proto__']}};
const array=(items:unknown,maxItems:number)=>({type:'array',items,maxItems});
const ref=(name:string)=>({$ref:'#/$defs/module'+name});
const dictionary=(value:unknown,maxProperties:number)=>({type:'object',additionalProperties:value,maxProperties,propertyNames:id});
const scalar={anyOf:[text(1024),{type:'number',minimum:-1e9,maximum:1e9},{type:'boolean'}]};
const role={enum:['operator','audience','connector','show']};
const option=object({id,label:{...text(120),minLength:1}});
const expression={anyOf:[scalar,object({read:{type:'string',maxLength:160,pattern:'^(local|input|set)\\.[a-zA-Z][a-zA-Z0-9_-]{0,63}$'}}),object({op:{enum:['eq','not','and','add','concat','if']},args:array(ref('Expression'),8)})]};
const field={oneOf:[object({type:{const:'text'},default:text(1024),maxLength:{type:'number',minimum:1,maximum:1024}}),object({type:{const:'number'},default:{type:'number'},min:{type:'number',minimum:-1e9,maximum:1e9},max:{type:'number',minimum:-1e9,maximum:1e9}}),object({type:{const:'boolean'},default:{type:'boolean'}})]};
const step={oneOf:[object({op:{enum:['set','add']},field:id,value:ref('Expression')}),object({op:{const:'view'},view:id})]};
const control=object({id,type:{enum:['button','toggle','text','number','choice','readout']},label:text(80),action:id,field:id,options:array(option,12),when:ref('Expression'),enabled:ref('Expression')},['id','type','label']);
const behavior={oneOf:[
 object({type:{const:'vote'},question:text(240),options:{...array(option,12),minItems:2},maxParticipants:{type:'integer',minimum:1,maximum:100000},allowChange:{type:'boolean'}}),
 object({type:{const:'submissions'},prompt:text(240),maxLength:{type:'integer',minimum:1,maximum:1000},capacity:{type:'integer',minimum:1,maximum:500}}),
 object({type:{const:'weather'},integrationRole:id}),
 object({type:{const:'agent'},integrationRole:id,prompt:text(1000),mode:{enum:['answer','factCheck']},maxLength:{type:'number',minimum:240,maximum:16000}}),
]};
const definition=object({label:text(80),state:dictionary(ref('Field'),64),publicFields:array(id,64),initialView:id,views:array(id,32),actions:dictionary(object({roles:array(role,4),steps:array(step,32),when:ref('Expression')},['roles','steps']),64),controls:array(object({id,label:text(80),audience:role,controls:array(control,32)}),16),capabilities:array({type:'string',maxLength:80,pattern:'^[a-z][a-z0-9.-]+@[1-9][0-9]*$'},16),behavior},['label','state','actions','controls','capabilities']);
const instance=object({id,definition:id,owner:{enum:['set','segment']},segment:id,initialState:dictionary(scalar,64),hidden:{enum:['continue','pause']},onExit:{enum:['continue','pause','stop','dispose']},reenter:{enum:['resume','reset','new']}},['id','definition','owner','hidden','onExit','reenter']);
export const runtimeSchemaDefs={moduleExpression:expression,moduleField:field,moduleDefinition:definition,moduleInstance:instance};
export const runtimeSchemaBody=object({schema:{const:'producer.modules/1'},definitions:dictionary(ref('Definition'),32),instances:array(ref('Instance'),32)});
export const runtimeJsonSchema={$schema:'https://json-schema.org/draft/2020-12/schema',...runtimeSchemaBody,$defs:runtimeSchemaDefs};
