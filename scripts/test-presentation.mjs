import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const result = await build({ stdin: { contents: `export * from './src/features/presentation/schema';
export * from './src/features/presentation/fixtures';
export * from './src/features/presentation/rehearsal';
export * from './src/features/presentation/rundown';
export * from './src/features/presentation/projection';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const temp = await mkdtemp(join(tmpdir(), 'producer-presentation-'));
const file = join(temp, 'runtime.mjs');
await writeFile(file, result.outputFiles[0].text);
const { parsePackage, presentationJsonSchema, AFTER_HOURS, HEAD_TO_HEAD, RehearsalSession, outputProjection, rundown, timeLabel } = await import(pathToFileURL(file));
await unlink(file); await rmdir(temp);
let checks = 0;
const test = (name, fn) => { fn(); checks++; console.log('PASS:', name); };
const edit = fn => { const doc = structuredClone(AFTER_HOURS); fn(doc); return doc; };
const texts = projection => JSON.stringify(projection);
const control = (session, type, args = {}) => session.send({ type: 'control', action: { type, ...args } });
const round = () => { const s = new RehearsalSession(HEAD_TO_HEAD, 'test'); assert.ok(control(s, 'show.start')); assert.ok(control(s, 'show.next')); return s; };

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
test('schema is generated from the same strict codec', () => {
  assert.equal(presentationJsonSchema.additionalProperties, false);
  assert.equal(presentationJsonSchema.properties.schema.const, 'producer.presentation/1');
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
  assert.deepEqual(a.snapshot(), b.snapshot()); assert.equal(a.snapshot().show.heat, 0);
  assert.equal(outputProjection(a.package, a.snapshot()).css, outputProjection(b.package, b.snapshot()).css);
  assert.ok(outputProjection(a.package, a.snapshot()).css.includes('animation-play-state:paused'));
  a.send({ type: 'reset' }); assert.equal(a.snapshot().show.total, 0); assert.equal(a.snapshot().running, false);
});
console.log(`Presentation runtime: ${checks} checks passed.`);

for (const development of [false, true]) {
  const flags = await build({ entryPoints: ['src/lib/featureFlags.ts'], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.env.DEV': String(development) } });
  const module = await import('data:text/javascript;base64,' + Buffer.from(flags.outputFiles[0].text).toString('base64'));
  assert.equal(module.panelAllowed('setControls', new Set(['mods'])), true, 'Set controls must be available in production and development.');
}
console.log('PASS: Set controls are available in production and development.');
