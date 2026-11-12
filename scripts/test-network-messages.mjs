import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../src/features/network/controller.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2020}}).outputText;
const {NetworkMessagesController,MessagesUnavailable}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
const message=(sequence,connection='a',text='Message '+sequence)=>({id:connection+'-'+sequence,connection_id:connection,sequence,sender_brand_id:'other-'+connection,client_message_id:'client-'+sequence,text,created_at:'2026-11-08T15:00:00Z'});
const conversation=id=>({id,status:'active',counterparty:{id:'other-'+id,name:'Producer '+id,slug:'producer-'+id,avatar_url:null},blocked_by_you:false,messaging_blocked:false,can_send:true,can_manage:true,unread_count:1,last_message:message(1,id)});
const until=async read=>{for(let i=0;i<100;i++){if(read())return;await new Promise(r=>setTimeout(r,2));}throw Error('Check did not settle');};
function fake(){const f={rows:[conversation('a')],messages:[message(1)],lists:0,reads:[],sends:[],acks:[],subscriptions:0,closes:0};f.client={list:async()=>{f.lists++;return f.rows;},read:async(id,cursor)=>{f.reads.push({id,cursor});return {messages:f.messages.filter(m=>m.connection_id===id&&(cursor?.after===undefined||m.sequence>cursor.after)&&(cursor?.before===undefined||m.sequence<cursor.before)),has_more:false};},send:async(id,clientId,text)=>{f.sends.push({id,clientId,text});return message(2,id,text);},markRead:async(id,messageId)=>{f.acks.push({id,messageId});},block:async()=>{},subscribe:(changed,status)=>{f.changed=changed;f.status=status;f.subscriptions++;return()=>{f.closes++;};}};return f;}

// A timeout after durable delivery retains one intent, even if the draft is edited.
{
 const f=fake(),c=new NetworkMessagesController(f.client,()=> 'intent-retained');let first=true;
 f.client.send=async(id,clientId,text)=>{f.sends.push({id,clientId,text});if(first){first=false;throw Error('Reply lost after delivery');}return message(2,id,text);};
 try{c.start();await until(()=>!c.snapshot().loadingThread&&c.snapshot().selected==='a');c.setDraft('The original message');await c.send();assert.equal(c.snapshot().pending.status,'failed');c.setDraft('A newer draft');await Promise.all([c.retrySend(),c.retrySend()]);assert.equal(f.sends.length,2);assert.deepEqual(f.sends[0],f.sends[1]);assert.equal(c.snapshot().draft,'A newer draft');assert.equal(c.snapshot().messages.filter(m=>m.sequence===2).length,1);}finally{c.close();}
}
// Reconnect uses sequence deltas, dedupes repeated delivery, and never reads hidden threads.
{
 const f=fake(),c=new NetworkMessagesController(f.client);
 try{c.start();await until(()=>c.snapshot().messages.length===1);assert.equal(f.acks.length,0);c.setReadVisible(true);await until(()=>f.acks.length===1);f.messages=[message(1),message(2),message(2)];f.rows=[{...conversation('a'),unread_count:1,last_message:message(2)}];await c.refresh();await until(()=>f.acks.length===2);assert.deepEqual(c.snapshot().messages.map(m=>m.sequence),[1,2]);assert(f.reads.some(r=>r.cursor?.after===1));c.setVisible(false);const requests=f.lists,acks=f.acks.length;await c.refresh();c.setReadVisible(true);await new Promise(r=>setTimeout(r,5));assert.equal(f.lists,requests);assert.equal(f.acks.length,acks);assert.equal(f.closes,1);c.setVisible(true);await until(()=>f.subscriptions===2);assert.equal(f.subscriptions-f.closes,1);}finally{c.close();}
}
// An old conversation / workspace response cannot overwrite the newly selected thread.
{
 const f=fake();f.rows=[conversation('a'),conversation('b')];let resolveA;
 f.client.read=async id=>id==='a'?await new Promise(resolve=>{resolveA=resolve;}):{messages:[message(1,'b')],has_more:false};
 const c=new NetworkMessagesController(f.client);
 try{c.start();await until(()=>!!resolveA);c.select('b');await until(()=>c.snapshot().messages[0]?.connection_id==='b');resolveA({messages:[message(1,'a')],has_more:false});await new Promise(r=>setTimeout(r,5));assert.equal(c.snapshot().selected,'b');assert(c.snapshot().messages.every(m=>m.connection_id==='b'));}finally{c.close();}
}
// Earlier pages prepend once; visibility acknowledgements never run on selection alone.
{
 const f=fake();f.client.read=async(id,cursor)=>cursor?.before?{messages:[message(1),message(2)],has_more:false}:{messages:[message(3),message(4)],has_more:true};const c=new NetworkMessagesController(f.client);
 try{c.start();await until(()=>c.snapshot().messages.length===2);assert.equal(f.acks.length,0);await c.older();assert.deepEqual(c.snapshot().messages.map(m=>m.sequence),[1,2,3,4]);assert.equal(c.snapshot().hasOlder,false);}finally{c.close();}
}
// Tauri serializes native failures as strings; retain their actionable reason
// and let the same workspace recover without hiding it behind a generic error.
{
 const f=fake();f.client.list=async()=>{throw 'Reconnect this workspace to restore access.';};const c=new NetworkMessagesController(f.client);
 try{c.start();await until(()=>c.snapshot().status==='error');assert.equal(c.snapshot().error,'Reconnect this workspace to restore access.');assert.equal(f.subscriptions,0);f.client.list=async()=>f.rows;await c.refresh();await until(()=>c.snapshot().status==='ready');assert.equal(c.snapshot().error,'');assert.equal(c.snapshot().selected,'a');}finally{c.close();}
}
// Arbitrary non-error objects are still not rendered as provider diagnostics.
{
 const f=fake();f.client.list=async()=>{throw {internal:'private fixture'};};const c=new NetworkMessagesController(f.client);
 try{c.start();await until(()=>c.snapshot().status==='error');assert.equal(c.snapshot().error,'Messages could not load. Try again.');}finally{c.close();}
}
// An unavailable self-hosted server is not replaced with a Boomin account.
{
 const f=fake();f.client.list=async()=>{throw new MessagesUnavailable('No local messages capability');};const c=new NetworkMessagesController(f.client);try{c.start();await until(()=>c.snapshot().status==='unavailable');assert.equal(f.subscriptions,0);assert.equal(c.snapshot().conversations.length,0);}finally{c.close();}
}
// Closing a workspace discards late callbacks and its private draft/outbox.
{
 const f=fake();let resolveList;f.client.list=()=>new Promise(resolve=>{resolveList=resolve;});const c=new NetworkMessagesController(f.client);let events=0;c.subscribe(()=>events++);c.start();c.close();resolveList([conversation('a')]);await new Promise(r=>setTimeout(r,5));assert.equal(events,0);assert.equal(c.snapshot().selected,null);assert.equal(f.subscriptions,0);
}
console.log('PASS: message retry idempotency, delta reconciliation/deduplication, visibility-only read receipts, bounded single subscription, workspace/thread race isolation, earlier history and unsupported-server behavior. No real messages sent.');
