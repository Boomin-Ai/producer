import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {test} from 'node:test';
const source=readFileSync(new URL('../src/lib/guestAdmission.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
const exports={};vm.runInNewContext(compiled,{exports});
const {admitGuestThroughTransport}=exports;
const base={host:true,virtualCameraOn:false,virtualCameraInstalled:true};
test('native admission skips virtual-camera startup even when its driver is installed',async()=>{
 const calls=[];
 await admitGuestThroughTransport({...base,nativeRtc:true,startVirtualCamera:async()=>{calls.push('vcam');throw Error('Unavailable');},admit:async()=>{calls.push('admit');}});
 assert.deepEqual(calls,['admit']);
});
test('legacy admission retains virtual-camera startup before admission',async()=>{
 const calls=[];
 await admitGuestThroughTransport({...base,nativeRtc:false,startVirtualCamera:async()=>{calls.push('vcam');},admit:async()=>{calls.push('admit');}});
 assert.deepEqual(calls,['vcam','admit']);
});
test('admission failures propagate for pending-button and error feedback',async()=>{
 await assert.rejects(admitGuestThroughTransport({...base,nativeRtc:true,startVirtualCamera:async()=>{},admit:async()=>{throw Error('Host session expired');}}),/Host session expired/);
});

test('committed removal with a lost response reconciles without retrying revoke',async()=>{
 let calls=0;
 await exports.revokeGuestAndConfirm({revoke:async()=>{calls++;throw Error('Response timed out');},isRemoved:async()=>true});
 assert.equal(calls,1);
});
test('unconfirmed removal preserves the original failure',async()=>{
 await assert.rejects(exports.revokeGuestAndConfirm({revoke:async()=>{throw Error('Denied');},isRemoved:async()=>false}),/Denied/);
 await assert.rejects(exports.revokeGuestAndConfirm({revoke:async()=>{throw Error('Timed out');},isRemoved:async()=>{throw Error('Offline');}}),/Timed out/);
});
