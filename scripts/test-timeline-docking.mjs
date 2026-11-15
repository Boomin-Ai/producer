import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
const bundled=await build({entryPoints:['src/lib/layout.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {normalize,DEFAULT_LAYOUT,PANEL_ORDER,panelCanDock,movePanel,movePanelTo,dockOf}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
test('Timeline moves and reorders in either row, hides, and rejects both side docks',()=>{
 let layout=normalize(DEFAULT_LAYOUT);
 for(const dock of ['bottom','top','hidden','bottom']){
  layout=movePanel(layout,'timeline',dock);
  assert.equal(dockOf(layout,'timeline'),dock);
  assert.equal(Object.values(layout).flat().filter(id=>id==='timeline').length,1);
 }
 for(const side of ['left','right']){
  assert.equal(panelCanDock('timeline',side),false);
  assert.deepEqual(movePanel(layout,'timeline',side),layout);
  assert.deepEqual(movePanelTo(layout,'timeline',side,0),layout);
 }
 layout=movePanelTo(layout,'timeline','top',0);
 assert.equal(layout.top[0],'timeline');
 for(const id of PANEL_ORDER.filter(id=>id!=='timeline'))assert(panelCanDock(id,'left')&&panelCanDock(id,'right'));
});
test('saved side placements recover to bottom without losing other panels or duplicating Timeline',()=>{
 for(const side of ['left','right']){
  const original=normalize(DEFAULT_LAYOUT);
  original.hidden=original.hidden.filter(id=>id!=='timeline');original[side].push('timeline');
  const recovered=normalize(original);
  assert.equal(dockOf(recovered,'timeline'),'bottom');
  assert.equal(new Set(Object.values(recovered).flat()).size,PANEL_ORDER.length);
 }
});
const configBundle=await build({entryPoints:['src/lib/roomConfig.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {parseConfig,serializeConfig}=await import('data:text/javascript;base64,'+Buffer.from(configBundle.outputFiles[0].text).toString('base64'));
test('Studio bar preference and original top docking survive the room document round trip',()=>{
 for(const bar of [true,false]){
  const doc={...parseConfig(null),timeline_bar:bar,layout:movePanel(normalize(DEFAULT_LAYOUT),'timeline','top')};
  const restored=parseConfig(serializeConfig(doc));
  assert.equal(restored.timeline_bar,bar);
  assert.equal(dockOf(restored.layout,'timeline'),'top');
 }
 assert.equal(parseConfig('{"timeline_bar":"true"}').timeline_bar,undefined);
});
