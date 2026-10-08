/** CEF lacks Browser context management; use supported page CDP directly,
 * including separate sessions for opaque out-of-process frames. */
export async function connectPage(url, Socket = WebSocket) {
 const socket=new Socket(url),pending=new Map(),contexts=new Map();let serial=0;
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
  const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CEF command timed out: ${method}`));},8000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
 });
 socket.addEventListener('message',event=>{
  const msg=JSON.parse(event.data);
  if(msg.id){const p=pending.get(msg.id);if(!p)return;clearTimeout(p.timer);pending.delete(msg.id);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result);}
  if(msg.method==='Runtime.executionContextCreated'){const c=msg.params.context;contexts.set(`${msg.sessionId||''}/${c.id}`,{...c,sessionId:msg.sessionId});}
  if(msg.method==='Runtime.executionContextDestroyed')contexts.delete(`${msg.sessionId||''}/${msg.params.executionContextId}`);
  if(msg.method==='Target.attachedToTarget')call('Runtime.enable',{},msg.params.sessionId).catch(()=>{});
 });
 socket.addEventListener('close',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('CEF connection closed'));}pending.clear();});
 await call('Runtime.enable');
 await call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});
 const evaluate=async(fn,context)=>{
  const result=await call('Runtime.evaluate',{expression:`(${fn.toString()})()`,awaitPromise:true,returnByValue:true,...(context?{contextId:context.id}:{})},context?.sessionId);
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return result.result.value;
 };
 return {evaluate:fn=>evaluate(fn),contexts,close:()=>socket.close(),async child(){
  for(const c of contexts.values()){try{if(await evaluate(()=>window!==parent,c))return {evaluate:fn=>evaluate(fn,c)};}catch{}}
  return null;
 }};
}
