import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const bundle = await build({
  stdin: {
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    contents: `
      export {djSetFeeds, hasDjSetFeeds} from './src/features/presentation/djFeeds';
      export {AFTER_HOURS} from './src/features/presentation/fixtures';
      export {outputProjection} from './src/features/presentation/projection';
      export {RehearsalSession} from './src/features/presentation/rehearsal';
      export {layoutProjections} from './src/features/sets-v2/preparedScenes';`,
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const encoded = Buffer.from(bundle.outputFiles[0].text).toString('base64');
const {AFTER_HOURS, djSetFeeds, hasDjSetFeeds, layoutProjections, outputProjection, RehearsalSession} =
  await import(`data:text/javascript;base64,${encoded}`);

const text = (value, maxLength = 60) => ({type: 'text', default: value, maxLength});
const definitions = {
  dj_phase: text('idle'),
  dj_now: text('Sample track'),
  dj_deck: text(''),
  dj_next: text('Sample next'),
  dj_next_deck: text(''),
  dj_next_kind: text('none'),
  dj_fade: text(''),
  dj_blend: {type: 'number', default: 0, min: 0, max: 100},
  headline: text('Ordinary Set feed'),
};
const privatePath = '/Users/local-account/Private Library/track.flac';
const status = {
  decks: [{track: {id: 'private-track-id', path: privatePath, title: 'Deck metadata'}, position_ms: 1000}],
  error: `Could not open ${privatePath}`,
  fade: 2.5,
  crossfader: 0.32,
  program: {
    phase: 'crossfade',
    current: {title: 'City lights', deck: 0, path: privatePath},
    next: {title: 'After midnight', deck: 1},
    next_kind: 'incoming',
  },
};

assert.equal(hasDjSetFeeds(definitions), true);
assert.equal(hasDjSetFeeds({headline: definitions.headline}), false);
assert.deepEqual(djSetFeeds({...status, program: undefined}, definitions), {});
const projected = djSetFeeds(status, definitions);
assert.deepEqual(projected, {
  dj_phase: 'crossfade', dj_now: 'City lights', dj_deck: 'A',
  dj_next: 'After midnight', dj_next_deck: 'B', dj_next_kind: 'incoming',
  dj_fade: '2.5 s', dj_blend: 30,
});
assert(!JSON.stringify(projected).includes(privatePath));
assert.deepEqual(djSetFeeds({...status, decks: [{position_ms: 2400}], crossfader: 0.34}, definitions), projected);
assert.deepEqual(djSetFeeds(status, {dj_now: text('', 5)}), {dj_now: 'City…'});
const mislabeled = {...status, program: {...status.program, current: {title: privatePath, deck: 0}}};
assert.deepEqual(djSetFeeds(mislabeled, {dj_now: definitions.dj_now}), {dj_now: 'track.flac'});

const transportDefinitions = {
  dj_elapsed: text(''), dj_duration: text(''), dj_remaining: text(''),
  dj_progress: {type: 'number', default: 0, min: 0, max: 100},
  ...Object.fromEntries(Array.from({length: 6}, (_, i) => ['dj_queue_' + (i + 1), text('')])),
};
const transportStatus = {...status,
  decks: [{position_ms: 31_900, duration_ms: 120_000}, {position_ms: 7000, duration_ms: 60_000}],
  queue_titles: ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Hidden seventh'],
};
const transportFeeds = djSetFeeds(transportStatus, transportDefinitions);
assert.equal(transportFeeds.dj_elapsed, '0:31');
assert.equal(transportFeeds.dj_duration, '2:00');
assert.equal(transportFeeds.dj_remaining, '1:28');
assert.equal(transportFeeds.dj_progress, 27);
assert.equal(transportFeeds.dj_queue_6, 'Sixth');
assert(!JSON.stringify(transportFeeds).includes('Hidden seventh'));
const fiveDefinitions = {...transportDefinitions};
delete fiveDefinitions.dj_queue_6;
const lastTrack = {...transportStatus, program: {...status.program, current: {title: 'Sixth', deck: 0}}};
const fiveFeeds = djSetFeeds(lastTrack, fiveDefinitions);
assert.equal(fiveFeeds.dj_queue_1, 'Second');
assert.equal(fiveFeeds.dj_queue_5, 'Sixth');
assert(!('dj_queue_6' in fiveFeeds));
const promotedStatus = {...transportStatus, program: {...status.program, current: {title: 'Second', deck: 1}}};
assert.equal(djSetFeeds(promotedStatus, transportDefinitions).dj_elapsed, '0:07');
assert.equal(djSetFeeds({...transportStatus, decks: [{position_ms: -20, duration_ms: NaN}]}, transportDefinitions).dj_progress, 0);

const doc = structuredClone(AFTER_HOURS);
Object.assign(doc.set.feeds, definitions);
for (const layout of doc.set.layouts) {
  layout.root.children.push({id: 'test-track', type: 'text', text: {get: 'feeds.dj_now'}});
  layout.root.children.push({
    id: 'test-transition', type: 'text', text: {get: 'feeds.dj_next'},
    when: {op: 'eq', args: [{get: 'feeds.dj_phase'}, 'crossfade']},
  });
  layout.root.children.push({id: 'test-headline', type: 'text', text: {get: 'feeds.headline'}});
}
const session = new RehearsalSession(doc, 'dj-test', 'prepare');
const rendered = (projection, id) => projection.root.children
  .find(node => node.id.endsWith('/' + id))?.text;
const displayed = id => rendered(outputProjection(session.package, session.snapshot()), id);
assert.equal(displayed('test-track'), 'Sample track');
assert.equal(displayed('test-transition'), undefined);
assert.equal(session.setRoomFeeds(projected), true);
assert.equal(displayed('test-track'), 'City lights');
assert.equal(session.exportPreparedPackage().set.feeds.dj_now.default, 'Sample track');
assert.equal(session.enterRehearsal(), true);
assert.equal(session.setRoomFeeds(projected), false);
assert.equal(displayed('test-track'), 'Sample track');
assert.equal(session.exitRehearsal(), true);
assert.equal(session.enterLive(), true);

let updates = 0;
session.subscribe(() => updates++);
assert.equal(session.setRoomFeeds(projected), true);
const first = session.snapshot();
assert.equal(session.setRoomFeeds({...projected}), false);
assert.equal(session.snapshot(), first);
assert.equal(updates, 1);
assert.equal(displayed('test-track'), 'City lights');
assert.equal(displayed('test-transition'), 'After midnight');
assert.equal(displayed('test-headline'), 'Ordinary Set feed');
for (const {projection} of layoutProjections(session)) {
  assert.equal(rendered(projection, 'test-track'), 'Sample track');
  assert.equal(rendered(projection, 'test-transition'), undefined);
}

const advanced = djSetFeeds({
  ...status, program: {phase: 'playing', current: status.program.next, next: null, next_kind: 'none'},
}, definitions);
assert.equal(session.setRoomFeeds(advanced), true);
assert.equal(updates, 2);
assert.equal(displayed('test-track'), 'After midnight');
assert.equal(displayed('test-transition'), undefined);
assert.equal(session.setRoomFeeds({}), true);
assert.equal(displayed('test-track'), 'Sample track');
assert.equal(displayed('test-headline'), 'Ordinary Set feed');
assert.equal(session.exportPreparedPackage().set.feeds.dj_now.default, 'Sample track');

const transitionDoc = structuredClone(doc);
Object.assign(transitionDoc.set.feeds, transportDefinitions);
for (const layout of transitionDoc.set.layouts) layout.animation = {tracks: [], transition: {
  type: 'cut', durationMs: 0, contentDurationMs: 240, contentFeeds: ['dj_now', 'dj_next', 'dj_phase'],
}};
const transitionSession = new RehearsalSession(transitionDoc, 'transition-test', 'prepare');
transitionSession.setRoomFeeds(djSetFeeds(transportStatus, transitionDoc.set.feeds));
const trackKey = outputProjection(transitionDoc, transitionSession.snapshot()).contentKey;
transitionSession.setRoomFeeds(djSetFeeds({...transportStatus, decks: [{position_ms: 60000, duration_ms: 120000}], crossfader: .8}, transitionDoc.set.feeds));
assert.equal(outputProjection(transitionDoc, transitionSession.snapshot()).contentKey, trackKey, 'Timeline and fader updates keep their transition identity');
transitionSession.setRoomFeeds(djSetFeeds(promotedStatus, transitionDoc.set.feeds));
assert.notEqual(outputProjection(transitionDoc, transitionSession.snapshot()).contentKey, trackKey, 'A track handoff changes transition identity');

console.log('PASS: DJ Set feeds expose bounded metadata, update live projection without redundant revisions, and stay out of saved and rehearsal data.');

const cueDoc=structuredClone(transitionDoc);
cueDoc.set.values.drop={type:'number',default:0,min:0,max:1};
for(const layout of cueDoc.set.layouts)layout.animation.cue={get:'values.drop'};
const cueSession=new RehearsalSession(cueDoc,'cue-proof','prepare');
const dormant=outputProjection(cueDoc,cueSession.snapshot()).timeline.clock;
assert.equal(dormant.segmentMs,86_400_000,'Opening a Set does not fire its drop sequence');
const originalShow=dormant.positionMs;
cueSession.send({type:'control',action:{type:'value.set',key:'drop',value:1}});
const impact=outputProjection(cueDoc,cueSession.snapshot()).timeline.clock;
assert.equal(impact.segmentMs,0,'Drop starts its own segment clock');
assert(impact.positionMs>=originalShow,'Drop preserves the continuous show clock');
cueSession.setRoomFeeds(djSetFeeds(transportStatus,cueDoc.set.feeds));
assert.deepEqual(outputProjection(cueDoc,cueSession.snapshot()).timeline.clock,impact,'Track metadata cannot restart drop motion');
cueSession.send({type:'control',action:{type:'value.set',key:'drop',value:0}});
assert.equal(outputProjection(cueDoc,cueSession.snapshot()).timeline.clock.segmentMs,0,'Drop can be triggered repeatedly');
const exported=cueSession.exportPreparedPackage();
assert.equal(exported.animationCues,undefined,'Transient motion state is not exported into a Set');
console.log('PASS: drop cue clock starts on control edges, stays stable during metadata updates, and does not alter show time.');
