import { describe, it, expect } from 'vitest';
import { defaultConfig, parseConfig, serializeConfig } from '../../src/lib/roomConfig';
import { withSourceFilters, filterEditQueue } from '../../src/lib/sourceFilters';
import { roomSession } from '../../src/lib/roomSession';
import type { FilterState } from '../../src/lib/filters';
const chain: FilterState[] = [
  {name:'Cutout',kind:'producer_person_mask',enabled:true,settings:{mode:'cut',quality:'balanced',feather:0.35,erode:0.25,edge_refine:0.65}},
  {name:'Green screen',kind:'chroma_key_filter_v2',enabled:false,settings:{similarity:412,smoothness:91}},
];
describe('room source filters', () => {
  it('keeps exact settings, enable state, order and explicit removal across room round trips', () => {
    const room=defaultConfig();
    room.sources.extras=[{id:'camera-2',label:'Camera 2',spec:{kind:'camera'}},{id:'mic',label:'Mic',spec:{kind:'mic'}}];
    room.active_scene='scene-2';
    const saved=withSourceFilters(room,'camera-2',chain);
    expect(parseConfig(serializeConfig(saved)).sources.extras?.[0].filters).toEqual(chain);
    expect(saved.active_scene).toBe('scene-2');
    expect(saved.sources.extras?.[1]).toBe(room.sources.extras[1]);
    expect(room.sources.extras[0].filters).toBeUndefined();
    expect(parseConfig(serializeConfig(withSourceFilters(saved,'camera-2',[]))).sources.extras?.[0].filters).toEqual([]);
    expect(withSourceFilters(saved,'deleted',chain)).toBe(saved);
    expect(parseConfig(serializeConfig(room)).sources.extras?.[0].filters).toBeUndefined();
  });
  it('serializes rapid edits through persistence, survives an error, and room exit waits for a running save', async () => {
    const events:string[]=[];
    const session=roomSession();
    let finish!:()=>void;
    const saving=new Promise<void>(resolve=>{finish=resolve;});
    const run=filterEditQueue(async op=> {
      await session.run(async()=>{
        events.push(op.op);
        if(op.op==='update') {await saving;events.push('saved');}
        if(op.op==='remove') throw new Error('save failed');
      });
      return chain;
    });
    const first=run({op:'update',name:'Cutout',settings:{edge_refine:0.8}});
    await new Promise(resolve=>setTimeout(resolve,0));
    const failure=run({op:'remove',name:'Cutout'});
    const caught=expect(failure).rejects.toThrow('save failed');
    const last=run({op:'list'});
    expect(events).toEqual(['update']);
    finish();await first;await caught;await last;
    expect(events).toEqual(['update','saved','remove','list']);
    // Exit must run after the active native edit + database write.
    const second=session.run(async()=>{events.push('save started');await new Promise(resolve=>setTimeout(resolve,10));events.push('save finished');});
    await new Promise(resolve=>setTimeout(resolve,0));
    const exit=session.close(async()=>{events.push('unload');});
    await second;await exit;
    expect(events.slice(-3)).toEqual(['save started','save finished','unload']);
  });
});
