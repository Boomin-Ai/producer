import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PRODUCER_PLAYWRIGHT_MODULE??'../target/browser-check/node_modules/playwright-core/index.mjs');
const browser=await chromium.launch({channel:'chrome'});
try{
 const p=await browser.newPage();await p.goto('http://127.0.0.1:1436/');await p.addStyleTag({content:'.set-preview{position:relative;width:960px;overflow:hidden}.set-preview iframe{position:absolute;inset:0;width:100%;height:100%;border:0}'});
 await p.evaluate(async()=>{
  const callbacks=new Map(),events=new Map();let n=0,id=0;window.stops=[];
  window.__TAURI_INTERNALS__={transformCallback:cb=>{callbacks.set(++n,cb);return n;},invoke:async(cmd,args)=>{if(cmd==='plugin:event|listen'){events.set(args.event,args.handler);return 1;}if(cmd==='live_transcription_start')return ++id;if(cmd==='live_transcription_stop'){window.stops.push(args.session);return;} }};window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};
  window.transcript=payload=>callbacks.get(events.get('live://transcript'))?.({payload});
  const M=await import('/node_modules/.vite/deps/react.js'),R=M.default??M,D=await import('/node_modules/.vite/deps/react-dom_client.js'),{LiveCaptions}=await import('/src/features/transcription/LiveCaptions.tsx'),{SetPreview}=await import('/src/features/presentation/SetPreview.tsx'),{RehearsalSession}=await import('/src/features/presentation/rehearsal.ts');
  const doc=await(await fetch('/docs/shows/road-to-v1.json')).json();window.session=new RehearsalSession(doc);const host=document.createElement('main');document.body.replaceChildren(host);
  function View(){const state=R.useSyncExternalStore(window.session.subscribe,window.session.snapshot);return R.createElement(R.Fragment,null,R.createElement(LiveCaptions,{enabled:true,onText:text=>window.session.send({type:'field',key:'liveCaption',value:text})}),R.createElement(SetPreview,{doc,state}));}
  (D.createRoot??D.default.createRoot)(host).render(R.createElement(View));
 });
 await p.getByRole('button',{name:'Captions',exact:true}).click();await p.getByRole('button',{name:'Stop captions'}).waitFor();
 await p.evaluate(()=>window.transcript({session:1,state:'listening',text:'Road to version one',is_final:false}));
 await p.frameLocator('iframe').getByText('Road to version one',{exact:true}).waitFor();
 assert.equal(await p.evaluate(()=>window.session.exportPreparedPackage().set.values.liveCaption.default),'','transient speech never persists into Set JSON');
 await p.getByRole('button',{name:'Stop captions'}).click();assert.equal(await p.evaluate(()=>window.session.snapshot().values.liveCaption),'');assert.deepEqual(await p.evaluate(()=>window.stops),[1]);
 await p.evaluate(()=>window.transcript({session:1,state:'listening',text:'stale text',is_final:true}));assert.equal(await p.evaluate(()=>window.session.snapshot().values.liveCaption),'');
 console.log('PASS: caption start/stop, partial text reaches actual SetPreview, caption excluded from saved JSON, stop clears and stale sessions ignored.');
}finally{await browser.close();}
