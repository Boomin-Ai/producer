import {describe,it,expect} from 'vitest';
import {cachedObject,readObjects,writeObjects} from '../src/dataIntegrations/objectCache';
describe('bounded data object cache',()=>{
 const policy={freshMs:100,staleMs:200,maxEntries:3,maxBytes:800};
 it('evicts oldest objects, bounds bytes, and does not extend age on reads',()=>{
  let raw:string|null=null;for(let i=1;i<=20;i++)raw=writeObjects(readObjects(raw,null),{key:String(i),fetchedAt:i,value:{text:'x'.repeat(80)}},policy,20);
  const entries=readObjects(raw,null);expect(entries.map(e=>e.key)).toEqual(['18','19','20']);expect(new TextEncoder().encode(raw!).byteLength).toBeLessThanOrEqual(policy.maxBytes);
  expect(cachedObject(entries,'20',policy,120)).toMatchObject({fetchedAt:20,stale:true});expect(cachedObject(entries,'20',policy,321)).toBeUndefined();
  expect(()=>writeObjects([],{key:'huge',fetchedAt:20,value:'x'.repeat(1000)},policy,20)).toThrow('budget');
 });
 it('adopts the legacy latest-response format and tolerates invalid stored JSON',()=>{
  expect(readObjects('{',1)).toEqual([]);expect(readObjects(JSON.stringify({requestKey:'city',temperature:22}),50)).toMatchObject([{key:'city',fetchedAt:50}]);
 });
});
