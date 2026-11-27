// Derive the website's compact example from the signed production document.
// Run with --check to verify a checkout, or without flags to refresh it.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const source = JSON.parse(readFileSync(new URL('protocol/v1/my-first-million/production.json',root)));
const show = source.shows['my-first-million'];
const set = source.sets[show.set];
const seconds = time => Number(time.ticks) / time.rate;
const segments = show.segments.map(segment => {
  const sequence = source.sequences[segment.sequence];
  const change = (at, entry) => {
    const layout = set.layouts[entry.landscape];
    const sources = [];
    function visit(node) {
      if (node.content.kind === 'source') sources.push(node.content.source);
      for (const child of node.children || []) visit(child);
    }
    visit(layout.root);
    for (const key of [entry.landscape,entry.vertical]) {
      assert.ok(set.layouts[key]);
      assert.ok(existsSync(new URL(`site/protocol/${key}.jpg`,root)), `Missing native preview for ${key}`);
    }
    const graph = set.outputGraphs[entry.landscape];
    return {at, landscape:entry.landscape, portrait:entry.vertical, sources,
      passes:set.graphs[graph].passes.map(pass=>pass.kind)};
  };
  return {id:segment.id,title:segment.title,sequence:segment.sequence,duration:seconds(sequence.duration),
    changes:[change(0,segment),...segment.layoutChanges.map(entry=>change(seconds(entry.at),entry))]};
});
const result = JSON.stringify({set:show.set,segments},null,2)+'\n';
const output = new URL('site/protocol/example.json',root);
if (process.argv.includes('--check')) assert.equal(readFileSync(output,'utf8'),result);
else writeFileSync(output,result);
