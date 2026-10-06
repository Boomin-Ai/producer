import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

async function module(path, imports = {}) {
  let js = ts.transpileModule(await fs.readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 },
  }).outputText;
  for (const [name, url] of Object.entries(imports)) js = js.replaceAll(`"${name}"`, JSON.stringify(url));
  return 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
}
const slots = await module('../src/lib/slotMath.ts');
const { scenePlan, openingScene } = await import(await module('../src/lib/scenePlan.ts', { './slotMath': slots }));
const scenes = [
  { id: 'scene-1', name: 'Scene 1', look: { camera: { visible: true, x: 20, y: 30, w: 640, h: 360, z: 0 } } },
  { id: 'scene-2', name: 'Scene 2', look: { media: { visible: true } } },
];
const catalog = ['camera', 'media', 'image', 'text', 'screen', 'overlay', 'mic'].map(id => ({ id, kind: id, visible: true }));
const selected = openingScene({ scenes, active_scene: 'scene-1' });
assert.equal(selected.id, 'scene-1');
assert.equal(openingScene({ scenes }).id, 'scene-1');
assert.equal(openingScene({ scenes, active_scene: 'deleted' }).id, 'scene-1');
assert.equal(openingScene({ scenes: [] }), undefined);

// Source creation order, slow browser arrival and the previously visible scene
// cannot alter the requested complete plan. Every other source is off and silent.
for (const items of [catalog, [...catalog].reverse(), [...catalog.slice(2), ...catalog.slice(0, 2)]]) {
  const plan = scenePlan(selected.look, items, {}, true);
  assert.deepEqual(plan.filter(change => change.patch.visible).map(change => change.id), ['camera']);
  assert.deepEqual(plan.find(change => change.id === 'camera').patch, { visible: true, z: 0, x: 20, y: 30, w: 640, h: 360 });
  for (const change of plan.filter(change => change.id !== 'camera')) {
    assert.equal(change.patch.visible, false);
    assert.equal(change.muted, true);
  }
}
const empty = scenePlan({}, catalog, {}, true);
assert.equal(empty.length, catalog.length);
assert(empty.every(change => !change.patch.visible && change.muted));
assert(scenePlan({ missing: { visible: true } }, catalog, {}, true).every(change => !change.patch.visible));

const remote = [...catalog, { id: 'gslot-1', kind: 'color' }, { id: 'guest-1', kind: 'guest', visible: true, muted: false }];
const bindings = { 'gslot-1': 'guest-1' };
const slotLook = { 'gslot-1': { visible: true, x: 10, y: 20, w: 200, h: 300, z: 2 } };
const filled = scenePlan(slotLook, remote, bindings, true);
assert.equal(filled.find(change => change.id === 'guest-1').patch.visible, true);
assert.equal(filled.find(change => change.id === 'guest-1').muted, false);
assert.equal(filled.find(change => change.id === 'gslot-1').patch.visible, false);
const offScene = scenePlan({}, remote, bindings, true);
assert.equal(offScene.find(change => change.id === 'guest-1').muted, true);
assert.equal(offScene.find(change => change.id === 'guest-1').patch.visible, false);
assert.equal(scenePlan({}, remote, {}, true).find(change => change.id === 'guest-1').patch.visible, true);
assert.equal(scenePlan({}, remote, {}, false).some(change => change.id === 'guest-1'), false);
assert.deepEqual(scenePlan(scenes[1].look, catalog, {}).filter(change => change.patch.visible).map(change => change.id), ['media']);
console.log('PASS: scene selection, complete startup membership for every source kind/order, empty/missing looks, geometry, cut switching, and guest slot continuity.');
