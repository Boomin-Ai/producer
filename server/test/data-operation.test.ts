import { describe, it, expect, vi } from 'vitest';
import { executeDataOperation, parseDataValue } from '../../shared/set-runtime/dataOperation';
import { weatherQueryContract, weatherObservationContract, agentQuestionContract, agentAnswerContract } from '../../shared/set-runtime/providerContracts';
import { weatherPayload } from '../../shared/set-runtime/weather';
const operation = {id:'forecast',input:weatherQueryContract.id,output:weatherObservationContract.id,delivery:'snapshot' as const,refresh:true};
const observation = {observedAt:1000,temperature:20,condition:'clear',isDay:true,wind:5,precipitation:0,provider:'Synthetic',location:'Atlanta',units:'celsius'};
describe('executable data ingestion',()=>{
 it('rejects invalid input before calling an adapter',async()=>{
  const perform=vi.fn(async()=>observation);
  for(const value of [null,{url:'https://example.com'},{location:{latitude:999}}])
   await expect(executeDataOperation(operation,weatherQueryContract,weatherObservationContract,value,perform)).rejects.toMatchObject({stage:'input'});
  expect(perform).not.toHaveBeenCalled();
 });
 it('rejects malformed normalized results before they become Set data',async()=>{
  for(const change of [{temperature:NaN},{units:'kelvin'},{condition:'invented'},{isDay:1},{wind:-1},{privateKey:'secret'},{forecast:{}}]) {
   const perform=vi.fn(async()=>({...observation,...change}));
   await expect(executeDataOperation(operation,weatherQueryContract,weatherObservationContract,{},perform)).rejects.toMatchObject({stage:'output'});
   expect(perform).toHaveBeenCalledTimes(1);
  }
 });
 it('rejects incompatible operation registration without making a request',async()=>{
  const perform=vi.fn();
  await expect(executeDataOperation({...operation,output:'weather.observation@2'},weatherQueryContract,weatherObservationContract,{},perform)).rejects.toThrow('contracts');
  expect(perform).not.toHaveBeenCalled();
 });
 it('allows different trusted adapters to produce the same renderer-facing shape',async()=>{
  const first=await executeDataOperation(operation,weatherQueryContract,weatherObservationContract,{},async()=>observation);
  const second=await executeDataOperation({...operation,id:'another-forecast'},weatherQueryContract,weatherObservationContract,{},async()=>({...observation,provider:'Second synthetic adapter'}));
  const a=weatherPayload(first),b=weatherPayload(second);
  expect({...a,provider:undefined}).toEqual({...b,provider:undefined});
 });
 it('never retries failed or paid operations',async()=>{
  const perform=vi.fn(async()=>{throw Error('rate limited');});
  await expect(executeDataOperation(operation,weatherQueryContract,weatherObservationContract,{},perform)).rejects.toThrow('rate limited');
  expect(perform).toHaveBeenCalledTimes(1);
 });
 it('bounds malicious object graphs and redacts their content',()=>{
  const cyclic:any={};cyclic.self=cyclic;
  for(const value of [cyclic,{secret:'s'.repeat(33000)},Array(9000).fill(1),{temperature:Infinity}]) {
   expect(()=>parseDataValue(weatherObservationContract,value,'output')).toThrow('Data output does not satisfy weather.observation@1');
  }
 });
 it('validates generic LLM answers and citation ranges independently of provider',()=>{
  const answer={response:'Evidence',citations:[{title:'Source',url:'https://example.com',start:0,end:8}],researched:true,model:'test'};
  expect(parseDataValue(agentAnswerContract,answer,'output').response).toBe('Evidence');
  for(const change of [{response:''},{researched:true,citations:[]},{citations:[{title:'Source',url:'javascript:alert(1)'}]},{citations:[{...answer.citations[0],end:9}]},{citations:[{...answer.citations[0],start:0.5}]}])
   expect(()=>parseDataValue(agentAnswerContract,{...answer,...change},'output')).toThrow();
  expect(()=>parseDataValue(agentQuestionContract,{question:'Test',mode:'execute-code'},'input')).toThrow();
 });
});
