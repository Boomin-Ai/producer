import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({stdin:{contents:"export * from './shared/set-runtime/runtime';export * from './shared/set-runtime/contract';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {SetRuntime,parseRuntimeDefinition}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const cap=['audience.vote@1','audience.text@1','data.weather@1'];
const base={label:'Debate',state:{score:{type:'number',default:0,min:0,max:100},privateNote:{type:'text',default:'Operator-only',maxLength:80}},publicFields:['score'],actions:{point:{roles:['operator'],steps:[{op:'add',field:'score',value:1}]},bad:{roles:['operator'],steps:[{op:'add',field:'score',value:1},{op:'set',field:'score',value:1000}]}},controls:[{id:'scoring',label:'Scoring',audience:'operator',controls:[{id:'point',type:'button',label:'Add point',action:'point'}]}],capabilities:[]};
const instance=(id,definition,owner='set')=>({id,definition,owner,...(owner==='segment'?{segment:id}:{}),hidden:'continue',onExit:'stop',reenter:'resume'});
const definition={schema:'producer.modules/1',definitions:{debate:base,voting:{...base,label:'Voting',capabilities:['audience.vote@1'],behavior:{type:'vote',question:'Do agents create opportunity?',options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],maxParticipants:2,allowChange:false}},submissions:{...base,label:'Questions',capabilities:['audience.text@1'],behavior:{type:'submissions',prompt:'Ask the panel',maxLength:200,capacity:3}},weather:{...base,label:'Weather',capabilities:['data.weather@1'],behavior:{type:'weather',integrationRole:'weather'}}},instances:[instance('host','debate','segment'),instance('guest','debate','segment'),instance('vote','voting'),instance('text','submissions'),instance('sky','weather')]};
let tests=0;const test=(label,fn)=>{fn();tests++;console.log('PASS',label);};
const make=()=>new SetRuntime(definition,{epoch:10,domain:'rehearsal',capabilities:cap});
const principal=(role='operator',id='host')=>({role,id,modules:['host','guest','vote','text','sky']});
let id=0;const send=(r,module,op,input={},p=principal(),extra={})=>r.dispatch({id:'command-'+(++id),setEpoch:10,module,epoch:r.snapshot().modules[module].epoch,op,input,...extra},p,10000);
const ok=(...args)=>{const res=send(...args);assert.equal(res.status,'committed',JSON.stringify(res));return res;};
const no=(...args)=>{const res=send(...args);assert.equal(res.status,'rejected',JSON.stringify(res));return res;};
test('strict package capability validation and unambiguous instance identity',()=>{
 assert.equal(parseRuntimeDefinition(definition).instances.length,5);
 assert.throws(()=>new SetRuntime(definition,{epoch:10,domain:'live',capabilities:[]}));
 for(const change of [d=>d.extra=true,d=>d.definitions.debate.extra='bad',d=>d.instances.push(d.instances[0]),d=>d.instances[0].initialState={missing:1},d=>d.definitions.debate.actions.point.steps[0].field='missing',d=>d.definitions.debate.actions.point.steps[0].value={read:'set.ungranted'},d=>d.definitions.debate.controls[0].controls[0].when={read:'local.missing'}]){const bad=structuredClone(definition);change(bad);assert.throws(()=>parseRuntimeDefinition(bad));}
});
test('independent segment modules, monotonic commits and relative increments',()=>{
 const r=make();ok(r,'host','start');ok(r,'guest','start');ok(r,'host','point');ok(r,'host','point');assert.equal(r.snapshot().modules.host.values.score,2);assert.equal(r.snapshot().modules.guest.values.score,0);assert.equal(r.snapshot().revision,4);
});
test('a failed workflow leaves every staged local write uncommitted',()=>{const r=make();ok(r,'host','start');const before=r.snapshot();no(r,'host','bad');assert.deepEqual(r.snapshot(),before);});
test('authority comes from execution context; audience cannot edit fields or operate modules',()=>{const r=make();no(r,'host','start',{},principal('audience','viewer'));no(r,'host','field',{field:'score',value:2},principal('audience','viewer'));no(r,'host','start',{}, {...principal(),modules:['vote']});});
test('stale absolute edits conflict, repeated command IDs are idempotent',()=>{
 const r=make();const command={id:'repeat',setEpoch:10,module:'host',epoch:1,op:'start'};const first=r.dispatch(command,principal(),10000);assert.deepEqual(r.dispatch(command,principal(),10001),first);assert.equal(r.snapshot().revision,1);no(r,'host','field',{field:'score',value:2},principal(),{expectedRevision:0});
 assert.equal(r.dispatch({...command,op:'dispose'},principal(),10002).status,'rejected');
});
test('reset fences old inputs without resetting global revision or another module',()=>{
 const r=make();ok(r,'host','start');ok(r,'guest','start');ok(r,'guest','point');const previous=r.snapshot().revision;ok(r,'host','reset');assert.ok(r.snapshot().revision>previous);assert.equal(r.snapshot().modules.host.epoch,2);no(r,'host','start',{},principal(),{epoch:1});assert.equal(r.snapshot().modules.guest.values.score,1);
});
test('hidden modules can continue while visibility pause cannot clear operator pause',()=>{
 const d=structuredClone(definition);d.instances[0].hidden='pause';const r=new SetRuntime(d,{epoch:10,domain:'rehearsal',capabilities:cap});ok(r,'host','start');ok(r,'host','pause');ok(r,'host','unmount');ok(r,'host','mount');assert.equal(r.snapshot().modules.host.execution,'paused');ok(r,'host','resume');assert.equal(r.snapshot().modules.host.execution,'running');ok(r,'vote','start');ok(r,'vote','unmount');assert.equal(r.snapshot().modules.vote.execution,'running');
});
test('poll publication, round targeting, strict duplicate prevention and hidden results',()=>{
 const r=make();ok(r,'vote','start');no(r,'vote','open');ok(r,'vote','publish');ok(r,'vote','open');ok(r,'vote','vote',{round:1,choice:'yes'},principal('audience','one'));no(r,'vote','vote',{round:1,choice:'no'},principal('audience','one'));assert.equal(r.public().modules[0].vote.results,null);assert(!JSON.stringify(r.public()).includes('Operator-only'));ok(r,'vote','close');no(r,'vote','vote',{round:1,choice:'yes'},principal('audience','late'));ok(r,'vote','reveal');assert.deepEqual(r.public().modules[0].vote.results,{counts:{yes:1,no:0},total:1});ok(r,'vote','round.new');ok(r,'vote','open');no(r,'vote','vote',{round:1,choice:'yes'},principal('audience','one'));ok(r,'vote','vote',{round:2,choice:'no'},principal('audience','one'));
});
test('participant capacity rejects extra voters instead of disabling deduplication',()=>{const r=make();for(const op of ['start','publish','open'])ok(r,'vote',op);for(const name of ['one','two'])ok(r,'vote','vote',{round:1,choice:'yes'},principal('audience',name));no(r,'vote','vote',{round:1,choice:'yes'},principal('audience','three'));assert.equal(r.snapshot().modules.vote.total,2);});
test('pending/rejected submissions never reach public projection; feature requires approval',()=>{
 const r=make();for(const op of ['start','publish','open'])ok(r,'text',op);ok(r,'text','submit',{round:1,text:'Private pending question',name:'Viewer'},principal('audience','one'));assert(!JSON.stringify(r.public()).includes('Private pending question'));no(r,'text','feature',{item:'item-1-r1'});ok(r,'text','approve',{item:'item-1-r1'});ok(r,'text','feature',{item:'item-1-r1'});assert.equal(r.public().modules[0].text.featured.text,'Private pending question');ok(r,'text','reject',{item:'item-1-r1'});assert.equal(r.public().modules[0].text.featured,null);
});
test('weather connector authority, normalized bounds, stale observation and reset fences',()=>{
 const r=make(),p=principal('connector','weather-service'),input={observedAt:9000,temperature:22,condition:'rain',isDay:true,wind:18,precipitation:3,provider:'Test weather'};
 no(r,'sky','weather.update',input);ok(r,'sky','weather.update',input,p);assert.equal(r.snapshot().modules.sky.weather.condition,'rain');no(r,'sky','weather.update',{...input,observedAt:8000},p);no(r,'sky','weather.update',{...input,temperature:10000},p);ok(r,'sky','weather.error',{message:'Offline'},p);assert.equal(r.snapshot().modules.sky.dataStatus,'stale');ok(r,'sky','reset');no(r,'sky','weather.update',input,p,{epoch:1});
});
test('observers cannot convert a committed state update into a failed transaction',()=>{const r=make();r.subscribe(()=>{throw Error('UI observer failed');});ok(r,'host','start');assert.equal(r.snapshot().revision,1);});
test('Just Facts agent requests are fenced and responses require explicit on-output selection',()=>{
 const d=structuredClone(definition);d.definitions.research={...base,label:'Research',capabilities:['data.agent@1'],behavior:{type:'agent',integrationRole:'research',prompt:'Explain the evidence',mode:'factCheck',maxLength:16000}};d.instances.push(instance('facts','research'));
 const r=new SetRuntime(d,{epoch:10,domain:'rehearsal',capabilities:[...cap,'data.agent@1']}),host={...principal(),modules:['facts']},connector={role:'connector',id:'llm',modules:['facts']};
 ok(r,'facts','start',{},host);const first='question-one',second='question-two';
 for(const request of [first,second])assert.equal(r.dispatch({id:request,setEpoch:10,module:'facts',epoch:1,op:'agent.ask',input:{question:request}},host,10000).status,'committed');
 no(r,'facts','agent.complete',{requestId:first,response:'Old answer'},connector);
 ok(r,'facts','agent.complete',{requestId:second,response:'A'.repeat(2000),citations:JSON.stringify([{title:'Evidence',url:'https://example.com/evidence'}])},connector);
 assert.equal(r.publicModule(r.snapshot().modules.facts).agent.response,'');
 ok(r,'facts','agent.show',{},host);assert.equal(r.publicModule(r.snapshot().modules.facts).agent.response.length,2000);
 no(r,'facts','agent.embed',{response:'Injected',citations:JSON.stringify([{title:'Bad',url:'javascript:alert(1)'}])},host);
 ok(r,'facts','agent.embed',{question:'Pasted question',response:'An existing agent response'},host);assert.equal(r.publicModule(r.snapshot().modules.facts).agent.response.length,2000);
 ok(r,'facts','agent.show',{},host);assert.equal(r.publicModule(r.snapshot().modules.facts).agent.response,'An existing agent response');
 ok(r,'facts','stop',{},host);assert.equal(r.snapshot().modules.facts.epoch,2);no(r,'facts','agent.complete',{requestId:second,response:'Late'},connector,{epoch:1});
});
test('segment orchestration commits once, preserves set modules, and isolates reentry policy',()=>{
 const d=structuredClone(definition);d.instances[0].onExit='pause';d.instances[0].reenter='reset';const r=new SetRuntime(d,{epoch:10,domain:'rehearsal',capabilities:cap});
 ok(r,'vote','start');let notifications=0;r.subscribe(()=>notifications++);
 const orchestrate=(segment,running=true,paused=false)=>r.orchestrate({setEpoch:10,segment,running,paused},{role:'show',id:'runner',modules:d.instances.map(i=>i.id)},10000);
 const before=r.snapshot().revision;assert.equal(orchestrate('host').status,'committed');assert.equal(r.snapshot().revision,before+1);assert.equal(notifications,1);ok(r,'host','point');
 assert.equal(orchestrate('guest').status,'committed');assert.equal(r.snapshot().modules.host.execution,'paused');assert.equal(r.snapshot().modules.guest.execution,'running');assert.equal(r.snapshot().modules.vote.execution,'running');
 assert.equal(orchestrate('host').status,'committed');assert.equal(r.snapshot().modules.host.values.score,0);assert.equal(r.snapshot().modules.host.epoch,2);assert.equal(r.snapshot().modules.guest.execution,'stopped');
 const revision=r.snapshot().revision;assert.equal(orchestrate('host').revision,revision);assert.equal(r.snapshot().revision,revision);
});
test('show pause reasons do not clear operator suspension, including leave and resume',()=>{
 const d=structuredClone(definition);d.instances[0].onExit='pause';const r=new SetRuntime(d,{epoch:10,domain:'rehearsal',capabilities:cap});
 const run=(segment,running,paused)=>r.orchestrate({setEpoch:10,segment,running,paused},{role:'show',id:'runner',modules:d.instances.map(i=>i.id)},10000);
 run('host',true,false);ok(r,'host','pause');run('host',true,true);run('guest',true,false);run('host',true,false);
 assert.deepEqual(r.snapshot().modules.host.pauseReasons,['operator']);assert.equal(r.snapshot().modules.host.execution,'paused');ok(r,'host','resume');assert.equal(r.snapshot().modules.host.execution,'running');
});
test('ungranted show orchestration cannot partially activate any module',()=>{
 const r=make(),before=r.snapshot();assert.equal(r.orchestrate({setEpoch:10,segment:'host',running:true,paused:false},{role:'show',id:'runner',modules:['host']},10000).status,'rejected');assert.deepEqual(r.snapshot(),before);
});
test('audience exposure follows optional show orchestration without owning module execution',()=>{
 const d=structuredClone(definition);d.instances.find(i=>i.id==='vote').audiencePolicy='whileRunning';d.instances.find(i=>i.id==='vote').audienceSegments=['host'];
 const r=new SetRuntime(d,{epoch:10,domain:'live',capabilities:cap}),show={role:'show',id:'runner',modules:d.instances.map(i=>i.id)};
 const run=(segment,running,paused=false)=>{const result=r.orchestrate({setEpoch:10,segment,running,paused,showAttached:true},show,10000);assert.equal(result.status,'committed',JSON.stringify(result));};
 run('host',false);assert.equal(r.snapshot().modules.vote.published,false);run('host',true);assert.equal(r.snapshot().modules.vote.admission,'open');ok(r,'vote','vote',{round:1,choice:'yes'},principal('audience','voter'));
 run('guest',true);assert.equal(r.snapshot().modules.vote.execution,'running');assert.equal(r.snapshot().modules.vote.published,false);assert.equal(r.snapshot().modules.vote.total,1);run('host',true);assert.equal(r.snapshot().modules.vote.admission,'open');run('host',true,true);assert.equal(r.snapshot().modules.vote.published,false);run('host',true);assert.equal(r.snapshot().modules.vote.total,1);
 const standalone=structuredClone(d);delete standalone.instances.find(i=>i.id==='vote').audienceSegments;const solo=new SetRuntime(standalone,{epoch:10,domain:'live',capabilities:cap});assert.equal(solo.orchestrate({setEpoch:10,segment:'',running:false,paused:false,showAttached:false},show,10000).status,'committed');assert.equal(solo.snapshot().modules.vote.admission,'open');
});
test('room chat requires an explicit capability, is deduplicated, and stays private until moderated',()=>{
 const d=structuredClone(definition);d.definitions.submissions.behavior.sources=['submissions','chat'];assert.throws(()=>parseRuntimeDefinition(d));d.definitions.submissions.capabilities.push('room.chat@1');
 const r=new SetRuntime(d,{epoch:10,domain:'live',capabilities:[...cap,'room.chat@1']});for(const op of ['start','publish','open'])ok(r,'text',op);
 const input={messageId:'message-one',text:'A room chat question',name:'Viewer',at:10000};no(r,'text','chat.ingest',input);ok(r,'text','chat.ingest',input,principal('connector','chat'));no(r,'text','chat.ingest',input,principal('connector','chat'));assert.equal(r.snapshot().modules.text.total,1);assert(!JSON.stringify(r.public()).includes(input.text));
 ok(r,'text','approve',{item:'item-1-r1'});ok(r,'text','feature',{item:'item-1-r1'});assert.equal(r.public().modules.find(m=>m.id==='text').text.featured.source,'chat');
 const command={id:'new-intake',setEpoch:10,module:'text',epoch:1,op:'close'};for(const op of ['close','round.new','open'])assert.equal(r.dispatch({...command,id:op,op},principal(),20000).status,'committed');
 assert.equal(r.dispatch({...command,id:'late-chat',op:'chat.ingest',input:{...input,messageId:'late-message'}},principal('connector','chat'),20000).status,'rejected');
});
console.log('Module runtime:',tests,'checks passed');
