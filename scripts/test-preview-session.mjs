import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../src/lib/previewSession.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText;
const { previewSession,closePreviewSessions,previewExit,afterPreviewWork } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const rect = { x: 20, y: 60, width: 640, height: 360 };
let resolve, events = [];
const delayed = previewSession({ attach: () => new Promise(r => { resolve = r; events.push('attach-old'); }), move: async () => events.push('move-old'), detach: async () => events.push('detach-old') }, value => events.push('stage-old:' + value));
const first = delayed.sync(() => rect);
await new Promise(r => setTimeout(r, 0));
const closed = delayed.close();
const next = previewSession({ attach: async () => { events.push('attach-new'); return true; }, move: async () => events.push('move-new'), detach: async () => events.push('detach-new') }, value => events.push('stage-new:' + value));
const second = next.sync(() => rect);
resolve(true); await Promise.all([first, closed, second]);
assert.ok(events.indexOf('detach-old') < events.indexOf('attach-new'));
assert.ok(!events.includes('move-old') && !events.includes('stage-old:true'));
await next.close();
let moves = 0;
const retryMove = previewSession({ attach: async () => true, move: async () => { if (++moves === 1) throw Error('engine busy'); }, detach: async () => {} }, () => {});
const realNow = Date.now;
await retryMove.sync(() => rect);
Date.now = () => realNow() + 2000;
await retryMove.sync(() => rect); Date.now = realNow;
assert.equal(moves, 2); await retryMove.close();
let attaches = 0;
const retryAttach = previewSession({ attach: async () => { if (++attaches === 1) throw Error('starting'); return true; }, move: async () => {}, detach: async () => {} }, () => {});
await retryAttach.sync(() => rect); Date.now = () => realNow() + 2000;
await retryAttach.sync(() => rect); Date.now = realNow;
assert.equal(attaches, 2); await retryAttach.close();
console.log('PASS: late attach teardown, mount ordering, failed move retry, and startup attach recovery.');

let refreshedMoves=0;
const geometry=previewSession({attach:async()=>true,move:async()=>{refreshedMoves++;},detach:async()=>{}},()=>{});
await geometry.sync(()=>rect);await geometry.sync(()=>rect);assert.equal(refreshedMoves,1);
await geometry.sync(()=>rect,true);assert.equal(refreshedMoves,2,'explicit geometry refresh reaches native placement for an unchanged DOM rect');await geometry.close();
console.log('PASS unchanged DOM bounds suppress routine moves but explicit native geometry refresh is retained.');

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));

// Two independently attached displays share one real native close receipt.
// Component cleanup cannot acknowledge, or queue duplicate native detaches,
// while that receipt is still outstanding.
{
 const events=[],ack=deferred();let detachCalls=0;
 const driver=id=>({attach:async()=>{events.push('attach:'+id);return true;},move:async()=>{},detach:async()=>{throw Error('per-component duplicate detach');}});
 const landscape=previewSession(driver('landscape'),on=>events.push('landscape:'+on));
 const portrait=previewSession(driver('portrait'),on=>events.push('portrait:'+on));
 await landscape.sync(()=>rect);await portrait.sync(()=>rect);
 const states=[],exit=previewExit(()=>{detachCalls++;events.push('native-close');return ack.promise;},state=>states.push(state));
 const closed=exit.close(()=>events.push('home'));
 await turn();
 assert.deepEqual(states,['closing']);
 assert.equal(detachCalls,1);
 assert.ok(events.indexOf('landscape:false')<events.indexOf('home'));
 assert.ok(events.indexOf('portrait:false')<events.indexOf('home'));
 const cleanups=Promise.all([landscape.close(),portrait.close()]);
 await turn();assert.deepEqual(states,['closing'],'routing Home/component cleanup is not a native hide receipt');
 ack.resolve();await Promise.all([closed,cleanups]);
 assert.deepEqual(states,['closing','idle']);assert.equal(detachCalls,1);
}

// A late old ACK must not dismiss a newer exit cover. An intermediate room
// closed before its queued attach runs must never attach to the old output.
{
 const firstAck=deferred(),secondAck=deferred(),states=[],events=[];let closes=0;
 const old=previewSession({attach:async()=>true,move:async()=>{},detach:async()=>{}},()=>{});
 await old.sync(()=>rect);
 const exit=previewExit(()=>++closes===1?firstAck.promise:secondAck.promise,state=>states.push(state));
 const firstClose=exit.close(()=>{});await turn();
 exit.cancel();
 const reopened=previewSession({attach:async()=>{events.push('reopened-attach');return true;},move:async()=>{},detach:async()=>{}},on=>events.push('reopened:'+on));
 const opening=reopened.sync(()=>rect);
 const secondClose=exit.close(()=>{});await turn();
 firstAck.resolve();await firstClose;await turn();
 assert.equal(states.at(-1),'closing','old close receipt must not remove a newer cover');
 assert.ok(!events.includes('reopened-attach'),'closed queued room must not attach after the old room retires');
 secondAck.resolve();await Promise.all([secondClose,opening]);
 assert.equal(states.at(-1),'idle');assert.equal(closes,2);
 await Promise.all([old.close(),reopened.close()]);
}

// Reopening is independent of a stale close's UI callback, while actual
// native attachment remains serialized after that old close's receipt.
{
 const ack=deferred(),states=[],events=[];
 const old=previewSession({attach:async()=>true,move:async()=>{},detach:async()=>{}},()=>{});await old.sync(()=>rect);
 const exit=previewExit(()=>ack.promise,state=>states.push(state));
 const closing=exit.close(()=>{});exit.cancel();
 const next=previewSession({attach:async()=>{events.push('new-attach');return true;},move:async()=>{},detach:async()=>{}},on=>events.push('new:'+on));
 const opening=next.sync(()=>rect);await turn();assert.ok(!events.includes('new-attach'));
 ack.resolve();await Promise.all([closing,opening]);
 assert.deepEqual(states,['closing','idle'],'stale receipt does not publish another state after reopen');
 await old.close();assert.equal(events.at(-1),'new:true','stale cleanup cannot make the new stage opaque');
 await next.close();
}

// A rejected native receipt keeps the cover. Forced retry still reaches the
// native window after all outgoing controllers have been unregistered.
{
 let attempts=0;const states=[];
 const old=previewSession({attach:async()=>true,move:async()=>{},detach:async()=>{}},()=>{});await old.sync(()=>rect);
 const exit=previewExit(async()=>{if(++attempts===1)throw Error('bridge failed');},state=>states.push(state));
 await assert.rejects(exit.close(()=>{}));await old.close();
 assert.equal(states.at(-1),'error');await exit.retry();
 assert.deepEqual(states,['closing','error','closing','idle']);assert.equal(attempts,2);
}

// Use the real room-owner queue: source/Set teardown must wait for the
// captured outgoing preview receipt, not a future room's attachment work.
{
 const roomSource=await fs.readFile(new URL('../src/lib/roomSession.ts',import.meta.url),'utf8');
 const roomJs=ts.transpileModule(roomSource,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ES2020}}).outputText;
 const {roomSession}=await import('data:text/javascript;base64,'+Buffer.from(roomJs).toString('base64'));
 const events=[],ack=deferred(),owner=roomSession();await owner.run(async()=>events.push('restore'));
 const preview=previewSession({attach:async()=>true,move:async()=>{},detach:async()=>{}},()=>{});await preview.sync(()=>rect);
 const concealed=closePreviewSessions(async()=>{await ack.promise;events.push('native-hidden');});
 const retired=owner.close(async()=>{await concealed;events.push('clear-set-and-camera');});
 await turn();assert.ok(!events.includes('clear-set-and-camera'));
 ack.resolve();await retired;await preview.close();
 assert.ok(events.indexOf('native-hidden')<events.indexOf('clear-set-and-camera'));
}
console.log('PASS: both-preview ACK, stale exits/reopens, failed-ACK retry, and preview-before-room teardown.');

// Native hide can finish before RTC/old graph retirement. The cover should
// disappear then, while a new native attach must still wait for old cleanup
// so its defensive hide cannot conceal the new room's view.
{
 const hide=deferred(),release=deferred(),events=[],states=[];
 const old=previewSession({attach:async()=>true,move:async()=>{},detach:async()=>{}},()=>{});await old.sync(()=>rect);
 const exit=previewExit(()=>hide.promise,state=>states.push(state));
 const concealed=exit.close(()=>events.push('home'));
 const retired=concealed.then(async()=>{events.push('old-release-start');await release.promise;events.push('old-release-hidden-and-clear');});
 const reserved=afterPreviewWork(()=>retired);
 exit.cancel();
 const next=previewSession({attach:async()=>{events.push('new-attach');return true;},move:async()=>{},detach:async()=>{}},()=>{});
 const opening=next.sync(()=>rect);
 hide.resolve();await concealed;await turn();
 assert.equal(states.at(-1),'idle');assert.ok(!events.includes('new-attach'),'new preview cannot overtake retiring old graph');
 release.resolve();await Promise.all([retired,reserved,opening]);
 assert.ok(events.indexOf('old-release-hidden-and-clear')<events.indexOf('new-attach'));
 await Promise.all([old.close(),next.close()]);
}
console.log('PASS: new preview waits for old room retirement while the close cover ends at native hide ACK.');

// Backing out of an opening that never attached a preview should not wait
// behind unrelated RTC retirement already reserved on the work queue.
{
 const release=deferred(),states=[];let nativeCalls=0;
 const reserved=afterPreviewWork(()=>release.promise);
 const exit=previewExit(async()=>{nativeCalls++;},state=>states.push(state));
 await exit.close(()=>{});
 assert.deepEqual(states,['closing','idle']);assert.equal(nativeCalls,0);
 release.resolve();await reserved;
}
console.log('PASS: an unattached room exit waits only for native conceal receipts, not unrelated retirement.');
