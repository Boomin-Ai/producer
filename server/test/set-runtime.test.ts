import {describe,it,expect} from 'vitest';
import {SetRuntimeService} from '../src/setRuntimeService';
import {moduleTemplate,moduleInstance} from '../../shared/set-runtime/templates';
import {FakeState} from './do';
const definition={schema:'producer.modules/1',definitions:{poll:moduleTemplate('vote')},instances:[moduleInstance('poll','poll')]};
const call=(service:SetRuntimeService,path:string,body?:unknown)=>service.fetch(new Request('https://do/set-runtime/'+path,body?{method:'POST',body:JSON.stringify(body)}:{}));
async function install(service:SetRuntimeService){const response=await call(service,'install',{deployment:'test',expectedEpoch:0,definition});expect(response.status).toBe(200);return (await response.json() as any).snapshot;}
let seq=0;
const command=(op:string,input={},role='operator',id='host',epoch=1)=>({command:{id:'c'+(++seq),setEpoch:epoch,module:'poll',epoch:1,op,input},principal:{role,id,modules:['poll']}});
describe('durable set authority',()=>{
 it('restores private ballot identities and public projections after eviction',async()=>{
  const state=new FakeState();let service=new SetRuntimeService(state.storage);await install(service);
  for(const op of ['start','publish','open'])await call(service,'command',command(op));
  await call(service,'command',command('vote',{choice:'yes',round:1},'audience','hashed-viewer'));
  service=new SetRuntimeService(state.storage);
  const duplicate=await (await call(service,'command',command('vote',{choice:'no',round:1},'audience','hashed-viewer'))).json() as any;expect(duplicate.result.status).toBe('rejected');
  const pub=await (await call(service,'public')).json() as any;expect(pub.snapshot.modules[0].vote.results).toBeNull();expect(JSON.stringify(pub)).not.toContain('hashed-viewer');expect(JSON.stringify(pub)).not.toContain('definitions');
  await call(service,'command',command('close'));await call(service,'command',command('reveal'));
  const revealed=await (await call(service,'public')).json() as any;expect(revealed.snapshot.modules[0].vote.results.total).toBe(1);
 });
 it('serializes concurrent commands and retains idempotency across service instances',async()=>{
  const state=new FakeState(),service=new SetRuntimeService(state.storage);await install(service);for(const op of ['start','publish','open'])await call(service,'command',command(op));
  const one=command('vote',{choice:'yes',round:1},'audience','one'),two=command('vote',{choice:'no',round:1},'audience','two');
  await Promise.all([call(service,'command',one),call(service,'command',two)]);
  const restored=new SetRuntimeService(state.storage);const retried=await (await call(restored,'command',one)).json() as any;expect(retried.result.status).toBe('committed');
  const host=await (await call(restored,'operator')).json() as any;expect(host.snapshot.modules.poll.total).toBe(2);
 });
 it('fences stale deployments and never publishes controls on package installation',async()=>{
  const state=new FakeState(),service=new SetRuntimeService(state.storage);await install(service);expect((await call(service,'install',{deployment:'other',expectedEpoch:0,definition})).status).toBe(409);
  expect((await call(service,'install',{deployment:'other',expectedEpoch:1,definition})).status).toBe(200);
  const stale=await (await call(service,'command',command('start'))).json() as any;expect(stale.result.status).toBe('rejected');
  const pub=await (await call(service,'public')).json() as any;expect(pub.snapshot.modules).toEqual([]);
 });
 it('does not acknowledge or retain mutations when durable storage fails',async()=>{
  const state=new FakeState(),service=new SetRuntimeService(state.storage);await install(service);const put=state.storage.put;state.storage.put=async()=>{throw Error('Disk unavailable');};
  expect((await call(service,'command',command('start'))).status).toBe(400);state.storage.put=put;
  const host=await (await call(service,'operator')).json() as any;expect(host.snapshot.modules.poll.execution).toBe('created');expect(host.snapshot.revision).toBe(0);
 });
});
