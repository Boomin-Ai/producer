import fs from 'node:fs';import assert from 'node:assert/strict';
import {loadRuntime} from './presentation-proof/runtime.mjs';
const {RehearsalSession,outputProjection}=await loadRuntime();
const session=new RehearsalSession(JSON.parse(fs.readFileSync('docs/shows/ai-signal.show.json')));
session.send({type:'control',action:{type:'show.start'}});
const clock=session.snapshot().animationClock;assert.ok(Object.isFrozen(clock));assert.equal(clock.running,true);
const warm=outputProjection(session.package,session.snapshot());assert.notEqual(warm.timeline.clock,clock);assert.doesNotThrow(()=>{warm.timeline.clock.running=false});assert.equal(clock.running,true);assert.equal(outputProjection(session.package,session.snapshot()).timeline.clock.running,true);
console.log('PASS portrait warm-up can pause its projection without mutating the frozen running rehearsal clock.');
