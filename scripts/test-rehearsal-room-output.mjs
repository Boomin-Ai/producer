import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const renderer = process.env.PRODUCER_REACT_TEST_RENDERER ?? '/private/tmp/producer-rehearsal-tests/node_modules/react-test-renderer/index.js';
const temp = await mkdtemp(join(tmpdir(), 'rehearsal-output-'));
try {
const result = await build({stdin:{resolveDir:process.cwd(),contents:`
import assert from 'node:assert/strict';
import React from 'react';
import {create,act} from ${JSON.stringify(renderer)};
import {ipc} from './src/lib/ipc';
import {useSetOutput,setOutputProjection} from './src/features/presentation/useSetOutput';
import {RehearsalSession} from './src/features/presentation/rehearsal';
import {HEAD_TO_HEAD} from './src/features/presentation/fixtures';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const doc=structuredClone(HEAD_TO_HEAD);
// Give every segment a distinct visual so an unchanged output cannot pass.
doc.show.phases.forEach((phase,i)=>{const layout=structuredClone(doc.set.layouts[0]);layout.id='phase-'+i;layout.root.id='root-'+i;doc.set.layouts.push(layout);phase.layoutId=layout.id;});
const session=new RehearsalSession(doc,'output-test','prepare');
let native={generation:1,lease:null,revision:0};let applied=[];let fail=false;let release;
ipc.liveSetStatus=async()=>({...native});
ipc.liveSetApply=async(request)=>{if(release)await new Promise(resolve=>{release=resolve});if(fail)throw Error('graphics not ready');native={...native,lease:request.lease,revision:request.projection.revision};applied.push(request);};
ipc.liveSetReturn=async()=>{native={generation:native.generation+1,lease:null,revision:0};return {...native}};
let output;
function Harness(){output=useSetOutput(session,'test-room',{},true,{host:'camera',guest:'phone'});return null;}
let root;await act(async()=>{root=create(React.createElement(Harness));});
const wait=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,200));});
const send=async(type)=>{await act(async()=>{assert.ok(session.send({type:'control',action:{type}}));});await wait();};
await act(async()=>{await output.apply();});assert.equal(output.active,true);const prepared=JSON.stringify({...applied.at(-1).projection,revision:0});
await act(async()=>session.enterRehearsal());await send('show.start');
assert.equal(applied.at(-1).projection.root.id,'output/root-0');
await send('show.next');assert.equal(applied.at(-1).projection.root.id,'output/root-1');
assert.deepEqual(applied.at(-1).bindings,{host:'camera',guest:'phone'});
await act(async()=>{session.send({type:'vote',playerId:'private-player',choiceId:doc.show.choices[0].id});session.send({type:'tick',milliseconds:60000});});await wait();
assert.ok(!JSON.stringify(applied.at(-1).projection).includes('private-player'));
await send('show.reveal');await send('show.next');assert.equal(applied.at(-1).projection.root.id,'output/root-2');
await act(async()=>session.exitRehearsal());await wait();assert.equal(JSON.stringify({...applied.at(-1).projection,revision:0}),prepared);
// A slow native preparation must converge to the latest segment after queued Next.
release=()=>{};let pending;await act(async()=>{pending=output.apply();});await wait();
await act(async()=>session.enterRehearsal());await send('show.start');await send('show.next');
const unblock=release;release=undefined;await act(async()=>{unblock();await pending;});await wait();
assert.equal(applied.at(-1).projection.root.id,'output/root-1');
await act(async()=>session.exitRehearsal());await wait();
// Failed preparation keeps the native composition and permits a retry.
const last=applied.at(-1);fail=true;await act(async()=>session.enterRehearsal());await send('show.start');assert.ok(output.error.includes('graphics not ready'));assert.equal(applied.at(-1),last);assert.equal(output.active,true);
fail=false;await act(async()=>output.apply());assert.equal(applied.at(-1).projection.root.id,'output/root-0');
await act(async()=>output.returnToRoom());await send('show.next');assert.equal(output.active,false);assert.equal(native.lease,null);
// A rehearsal alone must never take room output without Apply set.
const count=applied.length;await wait();assert.equal(applied.length,count);
await act(async()=>root.unmount());
console.log('PASS: attached shows apply; rehearsal segments drive room layouts and retain sources; results stay public; exit restores prepared output; failures preserve output; return to room stops updates.');
`},bundle:true,platform:'node',format:'esm',write:false,alias:{react:join(process.cwd(),'node_modules/react/index.js')},define:{'process.env.NODE_ENV':'"development"'}});
const file=join(temp,'test.mjs');await writeFile(file,result.outputFiles[0].text);await import(pathToFileURL(file));
} finally {await rm(temp,{recursive:true,force:true});}

// React scheduler keeps a MessagePort alive in this standalone Node runner.
process.exit(0);
