import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
import vm from 'node:vm';

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

const {withWindowsCameraDevices} = await import(await module('../src/lib/cameraDevicePersistence.ts'));
// Execute the actual event save path: selecting a camera must survive the next
// document restore without dropping guest credentials, filters or Set bindings.
const live = (await fs.readFile(new URL('../src/views/Live.tsx', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const eventStart = live.indexOf('      } else if (ev.type === "sources_changed") {');
const eventBody = eventStart + '      } else if (ev.type === "sources_changed") {'.length;
const eventEnd = live.indexOf('      } else if (ev.type === "video_changed") {', eventBody);
assert(eventStart > 0 && eventEnd > eventBody);
const handler = ts.transpileModule(`exports.save = ev => {${live.slice(eventBody, eventEnd)}};`, {
  compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS},
}).outputText;
const camera = {id:'camera-a', label:'Host', spec:{kind:'camera'}, filters:[{name:'Keep filter'}]};
const guest = {id:'guest-a', label:'Guest', spec:{kind:'guest', url:'https://guest.example/owned-invite'}};
const mic = {id:'mic-a', label:'Microphone', spec:{kind:'mic', device:'saved-mic'}};
const original = {sources:{extras:[camera, guest, mic]}, scenes:[{id:'scene-a'}], slot_bindings:{slot:'guest-a'}, presentation:{bindings:{host:'camera-a'}}};
function saveDevice(platform, items, applied = true) {
  const writes=[], cfgRef={current:structuredClone(original)}, exports={};
  vm.runInNewContext(handler, {
    exports, sourcesRef:{current:{}}, setSources:()=>{}, roomId:'local-room', roomApplied:{current:applied}, cfgRef,
    setCfgState:()=>{}, withWindowsCameraDevices, document:{documentElement:{dataset:{platform}}},
    serializeConfig:JSON.stringify, ipc:{liveUpdateRoom:(_room,value)=>{writes.push(JSON.parse(value.config));return Promise.resolve();}},
  });
  exports.save({sources:{items}});
  return {writes, config:cfgRef.current};
}
const cameraSelection=[{id:'camera-a',kind:'camera',device:'facecam-device-id'}, {id:'mic-a',kind:'mic',device:'runtime-mic'}];
const persisted=saveDevice('win',cameraSelection).writes[0];
assert.equal(persisted.sources.extras[0].spec.device,'facecam-device-id');
assert.deepEqual(persisted.sources.extras[0].filters,camera.filters);
assert.deepEqual(persisted.sources.extras.slice(1),[guest,mic]);
assert.deepEqual(persisted.scenes,original.scenes);
assert.deepEqual(persisted.slot_bindings,original.slot_bindings);
assert.deepEqual(persisted.presentation,original.presentation);
assert.equal(saveDevice('mac',cameraSelection).writes[0].sources.extras[0].spec.device,undefined);
assert.equal(saveDevice('win',[{id:'camera-a',kind:'guest',device:'not-camera'}]).writes[0].sources.extras[0].spec.device,undefined);
assert.equal(saveDevice('win',cameraSelection,false).writes.length,0);
const saved=[{...camera,spec:{kind:'camera',device:'facecam-device-id'}}];
assert.equal(withWindowsCameraDevices(saved,[], 'win'),saved);
assert.equal(withWindowsCameraDevices(saved,[{id:'camera-a',kind:'camera',device:null}], 'win'),saved);
assert.equal(withWindowsCameraDevices(saved,cameraSelection, 'win'),saved);
console.log('PASS: actual Windows camera selection save path survives restore; Mac behavior, guests, filters, Set/scene bindings and missing-device choices are preserved.');
