import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { build } from 'esbuild';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const result = await build({ stdin: { contents: `export * from './src/features/presentation/schema';
export * from './src/features/presentation/fixtures';
export * from './src/features/presentation/rehearsal';
export * from './src/features/presentation/rundown';
export * from './src/features/presentation/animation';
export * from './src/features/presentation/projection';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const temp = await mkdtemp(join(tmpdir(), 'producer-presentation-'));
const file = join(temp, 'runtime.mjs');
await writeFile(file, result.outputFiles[0].text);
const { parsePackage, presentationJsonSchema, AFTER_HOURS, HEAD_TO_HEAD, RehearsalSession, outputProjection, rundown, timeLabel, authoredCrossfadeMs } = await import(pathToFileURL(file));
await unlink(file); await rmdir(temp);
let checks = 0;
const test = (name, fn) => { fn(); checks++; console.log('PASS:', name); };
const edit = fn => { const doc = structuredClone(AFTER_HOURS); fn(doc); return doc; };
const texts = projection => JSON.stringify(projection);
const control = (session, type, args = {}) => session.send({ type: 'control', action: { type, ...args } });
const round = () => { const s = new RehearsalSession(HEAD_TO_HEAD, 'test'); assert.ok(control(s, 'show.start')); assert.ok(control(s, 'show.next')); return s; };

test('presentation/2 rejects old packages and private module output references',()=>{
 const doc=JSON.parse(readFileSync('docs/shows/just-facts.json','utf8'));assert.throws(()=>parsePackage({...doc,schema:'producer.presentation/1'}));
 const bad=structuredClone(doc);bad.set.layouts[0].root.children.push({id:'private-response',type:'text',text:{get:'modules.research.response'}});assert.throws(()=>parsePackage(bad));
 const wrong=structuredClone(doc);wrong.set.viewController='missing';assert.throws(()=>parsePackage(wrong));
});
test('prepared canvas variants export a matching initial view and isolate simulated answers',()=>{
 const doc=JSON.parse(readFileSync('docs/shows/just-facts.json','utf8')),s=new RehearsalSession(doc,undefined,'prepare');control(s,'layout.select',{layoutId:'view1-portrait'});const exported=s.exportPreparedPackage();assert.equal(exported.set.initialView,'view1');assert.equal(exported.set.initialLayout,'view1-portrait');
 assert.ok(s.enterRehearsal());const snap=s.moduleSnapshot();const result=s.receiveModuleData({id:'unrequested-answer',setEpoch:snap.setEpoch,module:'research',epoch:snap.modules.research.epoch,op:'agent.complete',input:{requestId:'unknown',response:'Unexpected answer'}});assert.equal(result.status,'rejected');s.exitRehearsal();assert(!JSON.stringify(s.exportPreparedPackage()).includes('Unexpected answer'));
});

test('Standalone module views morph both output variants, preserve scores and sample interrupted motion',()=>{
 const doc=parsePackage(JSON.parse(readFileSync('docs/shows/grand-arena-3d-study.json','utf8'))),realNow=Date.now;let now=1_000_000;Date.now=()=>now;
 try{
  const session=new RehearsalSession(doc,undefined,'prepare');session.enterRehearsal();void session.sendModule('studio','start');void session.sendModule('scoring','start');void session.sendModule('scoring','hostPoint');
  void session.sendModule('studio','hostFloor');assert.equal(session.snapshot().layoutId,'hostFocus-landscape');
  const width=(id)=>outputProjection(doc,{...session.snapshot(),layoutId:id}).timeline.tracks.find(t=>t.target.endsWith('/camera-0')&&t.property==='width');
  const landscape=width('hostFocus-landscape'),portrait=width('hostFocus-portrait');assert(landscape&&portrait);assert.equal(landscape.keyframes.at(-1).value,1075.2);assert.equal(portrait.keyframes.at(-1).value,918);
  assert(outputProjection(doc,session.snapshot()).timeline.tracks.length<=32);
  now+=325;void session.sendModule('studio','guestFloor');
  const interrupted=width('guestFocus-landscape');assert(interrupted.keyframes[0].value>739.2&&interrupted.keyframes[0].value<1075.2);
  void session.sendModule('studio','neutral');assert.equal(session.snapshot().layoutId,'studio-landscape');
  control(session,'layout.select',{layoutId:'hostFocus-landscape'});void session.sendModule('scoring','guestPoint');assert.equal(session.snapshot().layoutId,'hostFocus-landscape');
  void session.sendModule('studio','neutral');assert.equal(session.snapshot().layoutId,'studio-landscape');
  assert.equal(session.snapshot().modules.scoring.hostScore,1);assert.equal(session.snapshot().modules.scoring.guestScore,1);
  const cut=structuredClone(doc);for(const layout of cut.set.layouts)layout.animation.transition.durationMs=0;
  const immediate=new RehearsalSession(cut,undefined,'prepare');immediate.enterRehearsal();void immediate.sendModule('studio','start');void immediate.sendModule('studio','hostFloor');assert(!immediate.snapshot().layoutMotion);
 }finally{Date.now=realNow;}
});

test('Grand Arena segment morphs keep text visible unless its opacity is explicitly authored',()=>{
 const doc=parsePackage(JSON.parse(readFileSync('docs/shows/head-to-head-grand-arena.json','utf8')));
 for(const portrait of [false,true]){
  const session=new RehearsalSession(doc,undefined,'prepare');session.enterLive();control(session,'show.start');
  if(portrait)control(session,'layout.select',{layoutId:'faceoff-portrait'});
  const phases=doc.show.phases;
  for(const phase of phases.slice(1)){
   // Exercise each adjacent layout pair, including the vote->verdict edge.
   const layoutId=phase.layoutId.replace(/-landscape$/,portrait?'-portrait':'-landscape');
   control(session,'layout.select',{layoutId});
   const projection=outputProjection(doc,session.snapshot());
   const textIds=new Set();const visit=n=>{if(n.type==='text')textIds.add(n.id);n.children.forEach(visit);};visit(projection.root);
   const authored=doc.set.layouts.find(l=>l.id===layoutId).animation.tracks;
   for(const track of projection.timeline.tracks.filter(t=>textIds.has(t.target)&&t.property==='opacity')){
    assert.ok(authored.some(t=>t.target===track.target.split('/').slice(2).join('/')&&t.property==='opacity'),`Unexpected text blackout in ${layoutId}: ${track.target}`);
   }
  }
 }
 const authored=structuredClone(doc),layout=authored.set.layouts.find(l=>l.id==='host-case-landscape');
 layout.animation.tracks.push({target:'stage-label',property:'opacity',keyframes:[{atMs:0,value:0},{atMs:650,value:1}],clock:'segment'});
 const session=new RehearsalSession(parsePackage(authored),undefined,'prepare');session.enterLive();control(session,'show.start');control(session,'show.next');
 assert.deepEqual(outputProjection(session.package,session.snapshot()).timeline.tracks.find(t=>t.target.endsWith('/stage-label')&&t.property==='opacity').keyframes,layout.animation.tracks[0].keyframes);
});

test('prepare/rehearse boundary restores setup and discards practice state and private identities', () => {
  const withFeeds = structuredClone(HEAD_TO_HEAD);
  withFeeds.set.feeds = structuredClone(AFTER_HOURS.set.feeds);
  const s = new RehearsalSession(withFeeds, 'boundary', 'prepare');
  assert.equal(s.snapshot().workspaceMode, 'prepare');
  assert.equal(control(s, 'show.start'), false);
  assert.equal(s.send({ type: 'vote', playerId: 'p', choiceId: 'a' }), false);
  assert.ok(s.send({ type: 'field', key: 'hostName', value: 'Prepared host' }));
  assert.ok(s.send({ type: 'feed', key: 'headline', value: 'Prepared headline' }));
  assert.ok(control(s, 'layout.select', { layoutId: 'solo' }));
  assert.ok(s.enterRehearsal()); const firstSandbox = s.snapshot().sandboxId;
  assert.equal(s.enterRehearsal(), false);
  assert.equal(s.snapshot().values.hostName, 'Prepared host');
  assert.ok(s.send({ type: 'field', key: 'hostName', value: 'Practice host' }));
  assert.ok(s.send({ type: 'feed', key: 'headline', value: 'Practice headline' }));
  assert.ok(control(s, 'show.start')); assert.ok(control(s, 'show.next'));
  assert.ok(s.send({ type: 'vote', playerId: 'p', choiceId: 'a' }));
  assert.ok(s.send({ type: 'reaction', playerId: 'p' }));
  assert.ok(s.send({ type: 'tick', milliseconds: 60_000 })); assert.ok(control(s, 'show.reveal'));
  assert.ok(s.exitRehearsal());
  const prepared = s.snapshot();
  assert.equal(prepared.workspaceMode, 'prepare'); assert.equal(prepared.running, false);
  assert.equal(prepared.elapsedMs, 0); assert.equal(prepared.show.total, 0); assert.equal(prepared.show.heat, 0);
  assert.equal(prepared.show.winner, ''); assert.equal(prepared.show.revealed, false);
  assert.equal(prepared.show.phase, 'intro'); assert.equal(prepared.layoutId, 'solo');
  assert.equal(prepared.values.hostName, 'Prepared host'); assert.equal(prepared.feeds.headline, 'Prepared headline');
  assert.notEqual(prepared.sandboxId, firstSandbox); assert.equal(s.exitRehearsal(), false);
  assert.ok(s.enterRehearsal()); assert.ok(control(s, 'show.start')); assert.ok(control(s, 'show.next'));
  assert.ok(s.send({ type: 'vote', playerId: 'p', choiceId: 'b' }), 'Previous private deduplication must not survive exit');
  assert.ok(s.send({ type: 'reset' })); assert.equal(s.snapshot().values.hostName, 'Prepared host');
  assert.equal(s.snapshot().workspaceMode, 'rehearsal');
  const standalone = new RehearsalSession(AFTER_HOURS, 'set-only', 'prepare');
  assert.ok(standalone.enterRehearsal()); assert.equal(standalone.snapshot().running, false);
  assert.equal(standalone.package.show, undefined); assert.ok(standalone.exitRehearsal());
});

test('only authored crossfades add compositor transition duration',()=>{
 assert.equal(authoredCrossfadeMs(undefined,true,false),0);
 assert.equal(authoredCrossfadeMs({type:'cut',durationMs:500},true,false),0);
 assert.equal(authoredCrossfadeMs({type:'morph',durationMs:500},true,false),0);
 assert.equal(authoredCrossfadeMs({type:'crossfade',durationMs:170},true,false),170);
 assert.equal(authoredCrossfadeMs({type:'crossfade',durationMs:170},false,false),0);
 assert.equal(authoredCrossfadeMs({type:'crossfade',durationMs:170},true,true),0);
});

test('room show and private rehearsal own independent runtime and prepared state',()=>{
  const room=new RehearsalSession(HEAD_TO_HEAD,'room','prepare');
  const draft=new RehearsalSession(room.exportPreparedPackage(),'editor','prepare');
  const before=structuredClone(room.snapshot());
  draft.enterRehearsal();control(draft,'show.start');control(draft,'show.next');
  assert.ok(draft.send({type:'vote',playerId:'practice',choiceId:'a'}));
  draft.send({type:'field',key:'hostName',value:'Practice name'});
  assert.deepEqual(room.snapshot(),before);
  draft.exitRehearsal();assert.equal(draft.snapshot().show.total,0);
  assert.equal(draft.snapshot().values.hostName,room.snapshot().values.hostName);
  assert.ok(room.enterLive());assert.ok(control(room,'show.start'));
  assert.equal(room.snapshot().workspaceMode,'live');
  assert.ok(room.send({type:'tick',milliseconds:1000}));assert.equal(room.snapshot().elapsedMs,1000);
  assert.equal(room.send({type:'vote',playerId:'fake',choiceId:'a'}),false);
  assert.equal(control(room,'show.vote',{choiceId:'a'}),false);
  assert.ok(room.send({type:'segment.select',phaseId:HEAD_TO_HEAD.show.phases[1].id}));assert.equal(room.snapshot().paused,false);
  assert.equal(draft.snapshot().running,false);assert.equal(draft.snapshot().elapsedMs,0);
});

test('agent export retains configured defaults and excludes all rehearsal edits/results', () => {
  const session = new RehearsalSession(HEAD_TO_HEAD, 'export', 'prepare');
  session.send({type:'field',key:'hostName',value:'Configured host'});
  session.send({type:'control',action:{type:'layout.select',layoutId:'solo'}});
  const configured = session.exportPreparedPackage();
  assert.equal(configured.set.values.hostName.default,'Configured host');
  assert.equal(configured.set.initialLayout,'solo');
  assert.equal(session.package.set.values.hostName.default,HEAD_TO_HEAD.set.values.hostName.default);
  session.enterRehearsal();
  session.send({type:'field',key:'hostName',value:'Private practice'});
  control(session,'show.start'); control(session,'show.next');
  session.send({type:'vote',playerId:'private-player',choiceId:'a'});
  assert.deepEqual(session.exportPreparedPackage(),configured);
  assert.equal(JSON.stringify(configured).includes('private-player'),false);
  session.exitRehearsal(); assert.deepEqual(session.exportPreparedPackage(),configured);
});
test('rundown follows transitions, accounts for manual timing and detects repeats', () => {
  const doc = structuredClone(HEAD_TO_HEAD);
  // Declaration order is not playback order. Unreachable phases are not added
  // to duration, and cycles cannot be presented as a finite show.
  doc.show.phases.reverse();
  doc.show.phases.push({ id: 'unused', label: 'Unused', layoutId: 'solo', collectMs: 120_000 });
  const schedule = rundown(parsePackage(doc));
  assert.deepEqual(schedule.phases.map(p => p.id), ['intro', 'round', 'outro']);
  assert.equal(schedule.timedMs, 60_000); assert.equal(schedule.manual, true);
  assert.equal(schedule.repeats, false); assert.equal(timeLabel(schedule.timedMs), '1:00');
  doc.show.phases.find(p => p.id === 'outro').next = 'round';
  assert.equal(rundown(parsePackage(doc)).repeats, true);
  assert.deepEqual(rundown(AFTER_HOURS).phases, []);
});

test('standalone set needs no show, choices, phases or live adapters', () => {
  const s = new RehearsalSession(AFTER_HOURS, 'test');
  assert.equal(s.package.show, undefined); assert.deepEqual(s.snapshot().counts, {});
  assert.ok(control(s, 'layout.select', { layoutId: 'solo' }));
  assert.equal(s.snapshot().layoutId, 'solo');
  assert.ok(s.send({ type: 'field', key: 'hostName', value: '<script>literal</script>' }));
  assert.ok(texts(outputProjection(s.package, s.snapshot())).includes('<script>literal</script>'));
  assert.ok(s.send({ type: 'feed', key: 'headline', value: 'NEW TOPIC' }));
  assert.ok(texts(outputProjection(s.package, s.snapshot())).includes('NEW TOPIC'));
});
test('standalone layout animation does not depend on a show transport',()=>{
 const doc=structuredClone(AFTER_HOURS),layout=doc.set.layouts[0];
 layout.animation={tracks:[{target:layout.root.children[0].id,property:'opacity',keyframes:[{atMs:0,value:0},{atMs:1000,value:1}]}]};
 const session=new RehearsalSession(doc,undefined,'prepare');assert.equal(session.snapshot().animationClock.running,true);assert.equal(session.snapshot().running,false);
 control(session,'layout.select',{layoutId:'solo'});control(session,'layout.select',{layoutId:layout.id});
 assert.equal(session.snapshot().animationClock.running,true);assert.equal(session.snapshot().animationClock.segmentMs,0);assert.equal(session.snapshot().running,false);
});

test('a show can sequence layouts without contestants or voting',()=>{
 const doc=structuredClone(AFTER_HOURS);
 doc.show={id:'conversation-sequence',version:'1',initialPhase:'opening',phases:[{id:'opening',label:'Opening',layoutId:doc.set.layouts[0].id,next:'close'},{id:'close',label:'Closing',layoutId:'solo'}]};
 const parsed=parsePackage(doc);assert.deepEqual(parsed.show.choices,[]);
 assert(!presentationJsonSchema.properties.show.required.includes('choices'));
 const session=new RehearsalSession(parsed,undefined,'prepare');session.enterLive();
 assert.ok(control(session,'show.start'));assert.ok(control(session,'show.next'));
 assert.equal(session.snapshot().show.phase,'close');assert.equal(session.snapshot().layoutId,'solo');assert.deepEqual(session.snapshot().counts,{});
 const invalid=structuredClone(doc);invalid.show.phases[0].collectMs=10000;
 assert.throws(()=>parsePackage(invalid),/Voting needs at least two choices/);
});

test('schema is generated from the same strict codec', () => {
  assert.equal(presentationJsonSchema.additionalProperties, false);
  assert.equal(presentationJsonSchema.properties.schema.const, 'producer.presentation/2');
  assert.ok(presentationJsonSchema.$defs.node); assert.ok(presentationJsonSchema.$defs.binding);
  assert.deepEqual(parsePackage(AFTER_HOURS), AFTER_HOURS);
});
test('import refuses executable content, unknown native actions and unsafe bindings', () => {
  for (const change of [d => d.script = 'alert(1)', d => d.set.layouts[0].root.html = '<iframe>',
    d => d.set.controls[0].action = { type: 'record.start' },
    d => d.set.layouts[0].root.styles.background = 'url(https://evil.test)',
    d => d.set.layouts[0].root.styles.background = 'image-set("relative-image.png" 1x)',
    d => d.set.layouts[0].root.styles.background = '-webkit-image-set("//evil.test/x" 1x)',
    d => d.set.layouts[0].root.styles.background = 'red;position:fixed',
    d => d.set.layouts[0].root.styles.width = '999999px',
    d => d.set.layouts[0].root.styles.filter = 'blur(30px)',
    d => d.set.controls[0].when = { get: 'values.hostName' },
    d => d.set.layouts[0].root.children[0].text = { get: 'values.constructor' },
    d => d.set.layouts[0].root.children[0].text = { op: 'if', args: ['yes', 'a', 'b'] },
    d => d.set.components.Nameplate.root.when = { get: 'props.name' },
    d => d.set.layouts[0].root.children[4].children[0].props.name = 12,
    d => d.set.layouts[0].width = 1280.5]) assert.throws(() => parsePackage(edit(change)));
  assert.throws(() => parsePackage(JSON.parse(JSON.stringify(AFTER_HOURS).replace('"values":{', '"values":{"__proto__":{},'))));
});
test('source appearance shares strict bounds and keeps native slot identity', () => {
  const good = edit(d => d.set.layouts[0].root.children[2].appearance = { shape:'circle',cornerRadius:24,outlineWidth:6,outlineColor:'#ffaa22',grayscale:1,opacity:0.8 });
  const doc = parsePackage(good), state = new RehearsalSession(doc,'appearance').snapshot();
  const slot = outputProjection(doc,state).root.children.find(n => n.slotId === 'host');
  assert.equal(slot.appearance.shape,'circle'); assert.equal(slot.appearance.grayscale,1);
  for(const key of ['opacity','borderRadius','transform','overflow'])
    assert.throws(()=>parsePackage(edit(d=>d.set.layouts[0].root.children[2].styles[key]=key==='opacity'?0:'none')),/Media slot style/);
  const reactive = parsePackage(edit(d => d.set.layouts[0].root.children[2].appearance = { grayscale:{get:'feeds.energy'},cornerRadius:20 }));
  const r = new RehearsalSession(reactive,'reactive');
  r.send({type:'feed',key:'energy',value:0.75});
  assert.equal(outputProjection(r.package,r.snapshot()).root.children.find(n=>n.slotId==='host').appearance.grayscale,0.75);
  assert.throws(()=>parsePackage(edit(d => d.set.layouts[0].root.children[2].appearance={grayscale:{get:'values.hostName'}})));
  const invalid = new RehearsalSession(edit(d => d.set.layouts[0].root.children[2].appearance={outlineColor:{get:'values.hostName'}}),'invalid');
  assert.throws(()=>outputProjection(invalid.package,invalid.snapshot()),/Outline/);
  for(const bad of [{shape:'html'},{grayscale:2},{cornerRadius:-1},{outlineColor:'url(evil)'},{outlineWidth:65},{opacity:NaN},{script:'alert(1)'}])
    assert.throws(()=>parsePackage(edit(d => d.set.layouts[0].root.children[2].appearance=bad)));
});
test('unused components, cycles and exponential expansion cannot hide unsafe work', () => {
  assert.throws(() => parsePackage(edit(d => d.set.components.Hidden = { props: {}, root: { id: 'hidden', type: 'box', children: [], styles: { background: 'url(file:///tmp/x)' } } })), /injection/);
  assert.throws(() => parsePackage(edit(d => d.set.components.Nameplate.root = { id: 'loop', type: 'component', component: 'Nameplate', props: {} })), /cyclic/);
  const doc = edit(d => {
    d.set.components = {};
    d.set.components.Leaf = { props: {}, root: { id: 'leaf', type: 'box', children: Array.from({ length: 40 }, (_, i) => ({ id: `item-${i}`, type: 'text', text: 'x' })) } };
    d.set.layouts = [d.set.layouts[0]];
    d.set.layouts[0].root.children = Array.from({ length: 20 }, (_, i) => ({ id: `ref-${i}`, type: 'component', component: 'Leaf', props: {} }));
  });
  assert.throws(() => parsePackage(doc), /600 nodes/);
});
test('bounds apply to defaults and incoming updates; snapshots and packages are immutable', () => {
  const s = new RehearsalSession(AFTER_HOURS, 'test');
  assert.equal(s.send({ type: 'feed', key: 'energy', value: NaN }), false);
  assert.equal(s.send({ type: 'feed', key: '__proto__', value: 'x' }), false);
  assert.equal(s.send({ type: 'field', key: 'hostName', value: 'x'.repeat(41) }), false);
  assert.throws(() => s.snapshot().values.hostName = 'bypassed');
  assert.throws(() => s.package.set.controls.push({}));
  assert.throws(() => parsePackage(edit(d => { d.set.feeds.hostName = { type: 'text', default: 'ok', maxLength: 3 }; d.set.values.hostName.default = 'x'.repeat(41); })));
});
test('output ancestry cannot alias keys; private result fields are projected only after reveal', () => {
  const doc = edit(d => {
    d.set.layouts = [d.set.layouts[0]]; d.set.components = {}; d.set.controls = [];
    d.set.layouts[0].root.children = [
      { id: 'a_b', type: 'box', children: [{ id: 'c', type: 'text', text: 'first' }] },
      { id: 'a', type: 'box', children: [{ id: 'b_c', type: 'text', text: 'second' }] },
    ];
  });
  const s = new RehearsalSession(doc, 'test'); const p = outputProjection(s.package, s.snapshot());
  assert.notEqual(p.root.children[0].children[0].id, p.root.children[1].children[0].id);
  const show = structuredClone(HEAD_TO_HEAD);
  show.set.layouts[0].root.children.push({ id: 'private-test', type: 'text', text: { get: 'show.winner' } });
  const ss = new RehearsalSession(show, 'test'); const state = structuredClone(ss.snapshot());
  state.show.winner = 'SECRET UNREVEALED'; state.show.total = 8;
  assert.equal(texts(outputProjection(ss.package, state)).includes('SECRET UNREVEALED'), false);
});
test('one answer per identity; pause and exact deadline reject inputs; closing is not revealing', () => {
  const s = round();
  assert.ok(s.send({ type: 'vote', playerId: 'player-1', choiceId: 'a' }));
  assert.equal(s.send({ type: 'vote', playerId: 'player-1', choiceId: 'b' }), false);
  assert.ok(s.send({ type: 'pause', paused: true }));
  assert.equal(s.send({ type: 'tick', milliseconds: 10000 }), false); assert.equal(s.snapshot().show.remainingMs, 60000);
  assert.equal(s.send({ type: 'vote', playerId: 'player-2', choiceId: 'a' }), false);
  assert.ok(s.send({ type: 'pause', paused: false }));
  assert.ok(s.send({ type: 'tick', milliseconds: 60000 }));
  assert.equal(s.send({ type: 'vote', playerId: 'player-2', choiceId: 'a' }), false);
  assert.equal(s.snapshot().show.revealed, false); assert.equal(control(s, 'show.next'), false);
  const projection = outputProjection(s.package, s.snapshot());
  assert.equal(texts(projection).includes('WINNER ·'), false);
  assert.equal('counts' in projection, false); assert.equal('controls' in projection, false);
  assert.ok(control(s, 'show.reveal')); assert.ok(texts(outputProjection(s.package, s.snapshot())).includes('WINNER · Contestant A'));
  assert.ok(control(s, 'show.next'));
});
test('zero inputs and ties never silently award a winner', () => {
  const zero = round(); zero.send({ type: 'tick', milliseconds: 60000 }); assert.equal(control(zero, 'show.reveal'), false);
  const tie = round(); tie.send({ type: 'vote', playerId: 'p1', choiceId: 'a' }); tie.send({ type: 'vote', playerId: 'p2', choiceId: 'b' });
  tie.send({ type: 'tick', milliseconds: 60000 }); assert.equal(control(tie, 'show.reveal'), false); assert.equal(tie.snapshot().show.winner, '');
});
test('reopen preserves votes, receipts and elapsed time, accepts new voters and refuses invalid transitions', () => {
  const s = round();
  assert.equal(control(s, 'show.reopen'), false);
  s.send({ type:'vote', playerId:'p1', choiceId:'a' });
  s.send({ type:'tick', milliseconds:60000 });
  const elapsed = s.snapshot().elapsedMs;
  s.send({ type:'pause', paused:true }); assert.equal(control(s,'show.reopen'),false);
  s.send({ type:'pause', paused:false }); assert.ok(control(s,'show.reopen'));
  assert.equal(s.snapshot().elapsedMs,elapsed); assert.equal(s.snapshot().show.remainingMs,60000);
  assert.equal(s.snapshot().show.total,1); assert.equal(s.snapshot().counts.a,1);
  assert.equal(s.send({type:'vote',playerId:'p1',choiceId:'b'}),false);
  assert.ok(s.send({type:'vote',playerId:'p2',choiceId:'a'}));
  s.send({type:'tick',milliseconds:60000}); assert.ok(control(s,'show.reveal'));
  assert.equal(control(s,'show.reopen'),false); assert.equal(s.snapshot().show.result,'winner');
  const zero = round(); zero.send({type:'tick',milliseconds:60000});
  assert.equal(control(zero,'show.draw'),false); assert.equal(control(zero,'show.tiebreak'),false);
  assert.ok(control(zero,'show.reopen')); assert.ok(zero.send({type:'vote',playerId:'p',choiceId:'a'}));
  const prepared = new RehearsalSession(HEAD_TO_HEAD,'prepared','prepare');
  for(const action of ['show.reopen','show.draw','show.tiebreak']) assert.equal(control(prepared,action),false);
});
test('operator draw reveals no winner and can progress; resolved results cannot be reopened', () => {
  const s = round();
  s.send({type:'vote',playerId:'p1',choiceId:'a'}); s.send({type:'vote',playerId:'p2',choiceId:'b'});
  assert.equal(control(s,'show.draw'),false); s.send({type:'tick',milliseconds:60000});
  s.send({type:'pause',paused:true}); assert.equal(control(s,'show.draw'),false);
  s.send({type:'pause',paused:false}); assert.ok(control(s,'show.draw'));
  assert.equal(s.snapshot().show.winner,''); assert.equal(s.snapshot().show.result,'draw');
  assert.ok(texts(outputProjection(s.package,s.snapshot())).includes('DRAW'));
  assert.equal(texts(outputProjection(s.package,s.snapshot())).includes('WINNER ·'),false);
  assert.equal(control(s,'show.draw'),false); assert.equal(control(s,'show.reopen'),false);
  assert.ok(control(s,'show.next')); assert.equal(s.snapshot().show.phase,'outro');
  assert.ok(texts(outputProjection(s.package,s.snapshot())).includes('DRAW'));
  s.send({type:'reset'}); assert.equal(s.snapshot().show.result,'');
});
test('tie-break creates a fresh ballot only for tied leaders and preserves the previous tally', () => {
  const doc = structuredClone(HEAD_TO_HEAD); doc.show.choices.push({id:'c',label:'Contestant C'});
  const s = new RehearsalSession(doc,'tiebreak'); control(s,'show.start'); control(s,'show.next');
  for(const [playerId,choiceId] of [['p1','a'],['p2','b'],['p3','a'],['p4','b'],['p5','c']]) s.send({type:'vote',playerId,choiceId});
  s.send({type:'tick',milliseconds:60000}); assert.ok(control(s,'show.tiebreak'));
  assert.deepEqual(s.snapshot().ballotChoiceIds,['a','b']); assert.equal(s.snapshot().show.ballot,2);
  assert.deepEqual(s.snapshot().ballotHistory,[{ballot:1,counts:{a:2,b:2,c:1},total:5}]);
  assert.equal(s.snapshot().show.total,0); assert.equal(s.snapshot().show.remainingMs,60000);
  assert.equal(s.send({type:'vote',playerId:'p5',choiceId:'c'}),false);
  assert.ok(s.send({type:'vote',playerId:'p1',choiceId:'b'}));
  assert.equal(s.send({type:'vote',playerId:'p1',choiceId:'a'}),false);
  s.send({type:'tick',milliseconds:60000}); assert.ok(control(s,'show.reveal'));
  assert.equal(s.snapshot().show.winner,'Contestant B'); assert.ok(control(s,'show.next'));
  s.send({type:'stop'}); control(s,'show.start'); control(s,'show.next');
  assert.deepEqual(s.snapshot().ballotHistory,[]); assert.equal(s.snapshot().show.ballot,1);
  assert.ok(s.send({type:'vote',playerId:'p5',choiceId:'c'}));
});
test('simulation refuses its 101st identity without evicting previous voter deduplication', () => {
  const s = round(); for (let i = 0; i < 100; i++) assert.ok(s.send({ type: 'vote', playerId: `p${i}`, choiceId: 'a' }));
  assert.equal(s.send({ type: 'vote', playerId: 'p100', choiceId: 'a' }), false);
  assert.equal(s.send({ type: 'vote', playerId: 'p0', choiceId: 'b' }), false); assert.equal(s.snapshot().show.total, 100);
});
test('stop/restart clears private voters, results, reactions and restores the initial phase layout', () => {
  const s = round(); s.send({ type: 'vote', playerId: 'p1', choiceId: 'a' }); s.send({ type: 'reaction', playerId: 'p1' });
  s.send({ type: 'tick', milliseconds: 60000 }); control(s, 'show.reveal'); s.send({ type: 'stop' });
  control(s, 'layout.select', { layoutId: 'solo' }); control(s, 'show.start');
  assert.equal(s.snapshot().layoutId, 'conversation'); assert.equal(s.snapshot().show.winner, ''); assert.equal(s.snapshot().show.total, 0); assert.equal(s.snapshot().show.heat, 0);
  control(s, 'show.next'); assert.ok(s.send({ type: 'vote', playerId: 'p1', choiceId: 'b' }));
});
test('event replay is deterministic; invalid action cannot invoke native or network effects', () => {
  const a = round(), b = round();
  const events = [{ type: 'reaction', playerId: 'p' }, { type: 'reaction', playerId: 'p' }, { type: 'tick', milliseconds: 10000 }, { type: 'control', action: { type: 'native.invoke', command: 'record_start' } }];
  for (const event of events) assert.equal(a.send(event), b.send(event));
  const left=structuredClone(a.snapshot()),right=structuredClone(b.snapshot());assert.notEqual(left.moduleCommit.setEpoch,right.moduleCommit.setEpoch);left.moduleCommit.setEpoch=right.moduleCommit.setEpoch=0;
  assert.deepEqual(left,right); assert.equal(a.snapshot().show.heat, 0);
  assert.equal(outputProjection(a.package, a.snapshot()).css, outputProjection(b.package, b.snapshot()).css);
  assert.ok(outputProjection(a.package, a.snapshot()).css.includes('animation-play-state:paused'));
  a.send({ type: 'reset' }); assert.equal(a.snapshot().show.total, 0); assert.equal(a.snapshot().running, false);
});
test('shared style tokens resolve without flattening reusable presets',()=>{
 const raw=edit(doc=>{doc.set.tokens={brand:'#b9e5ca',font:'Avenir Next, sans-serif'};doc.set.styles={headline:{color:{get:'tokens.brand'},fontFamily:{get:'tokens.font'},fontWeight:800}};doc.set.layouts[0].root.children.push({id:'token-example',type:'text',styleId:'headline',text:'Design system',styles:{fontWeight:600}});});
 const doc=parsePackage(raw),s=new RehearsalSession(doc),p=outputProjection(s.package,s.snapshot());
 const node=p.root.children.find(n=>n.id.endsWith('/token-example'));assert.equal(node.styles.color,'#b9e5ca');assert.equal(node.styles.fontWeight,600);assert.equal(node.styles.fontFamily,'Avenir Next, sans-serif');assert.equal(doc.set.layouts[0].root.children.at(-1).styles.color,undefined);
 assert.throws(()=>parsePackage(edit(d=>{d.set.styles={bad:{transform:'scale(2)'}};})));
 assert.throws(()=>parsePackage(edit(d=>{d.set.layouts[0].root.styles.filter='blur(8px)';})));
 assert.throws(()=>parsePackage(edit(d=>{d.set.layouts[0].root.styles.clipPath='circle(50%)';})));
 assert.throws(()=>parsePackage(edit(d=>{d.set.styles={bad:{fontFamily:'url(https://evil)'}};})));
 assert.throws(()=>parsePackage(edit(d=>{d.set.styles={bad:{color:{get:'tokens.missing'}}};})));
});
test('Editor segment navigation reaches any segment without starting a show and pauses an active rehearsal', () => {
 const session=new RehearsalSession(HEAD_TO_HEAD,undefined,'prepare');
 session.send({type:'field',key:'hostName',value:'Editor test'});
 for(const phase of HEAD_TO_HEAD.show.phases){assert.equal(session.send({type:'segment.select',phaseId:phase.id}),true);assert.equal(session.snapshot().layoutId,phase.layoutId);assert.equal(session.snapshot().show.phase,phase.id);assert.equal(session.snapshot().running,false);assert.equal(session.snapshot().values.hostName,'Editor test');}
 const before=session.snapshot().layoutId;assert.equal(session.send({type:'segment.select',phaseId:'unknown'}),false);assert.equal(session.snapshot().layoutId,before);
 session.enterRehearsal();session.send({type:'control',action:{type:'show.start'}});
 const voting=HEAD_TO_HEAD.show.phases.find(p=>p.collectMs);
 assert.equal(session.send({type:'segment.select',phaseId:voting.id}),true);
 assert.equal(session.snapshot().paused,true);assert.equal(session.snapshot().show.collecting,true);assert.equal(session.snapshot().animationClock?.running??false,false);
 const remaining=session.snapshot().show.remainingMs;assert.equal(session.send({type:'tick',milliseconds:1000}),false);assert.equal(session.snapshot().show.remainingMs,remaining);
 assert.equal(session.send({type:'pause',paused:false}),true);assert.equal(session.send({type:'tick',milliseconds:1000}),true);assert.equal(session.snapshot().show.remainingMs,remaining-1000);
});
test('live lifecycle transport preserves rapid segment changes without a React render boundary',()=>{
 const doc=parsePackage(JSON.parse(readFileSync('docs/shows/head-to-head-grand-arena.json','utf8'))),session=new RehearsalSession(doc,undefined,'prepare');assert.ok(session.enterLive());const events=[];
 session.attachModuleLifecycle(value=>events.push(structuredClone(value)));
 assert.ok(control(session,'show.start'));assert.ok(control(session,'show.next'));assert.ok(control(session,'show.previous'));
 assert.deepEqual(events.map(e=>[e.segment,e.running]),[[doc.show.initialPhase,false],[doc.show.initialPhase,true],[doc.show.phases[0].next,true],[doc.show.initialPhase,true]]);
 session.attachModuleLifecycle(undefined);const count=events.length;assert.ok(control(session,'show.next'));assert.equal(events.length,count);
});
console.log(`Presentation runtime: ${checks} checks passed.`);

for (const development of [false, true]) {
  const flags = await build({ entryPoints: ['src/lib/featureFlags.ts'], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.env.DEV': String(development) } });
  const module = await import('data:text/javascript;base64,' + Buffer.from(flags.outputFiles[0].text).toString('base64'));
  assert.equal(module.panelAllowed('setControls', new Set(['mods'])), true, 'Set controls must be available in production and development.');
}
console.log('PASS: Set controls are available in production and development.');
