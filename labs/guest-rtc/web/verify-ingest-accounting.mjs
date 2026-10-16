// Verify actual live-run evidence, including every retired transport generation.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Use verify-ingest-accounting.mjs <transport-json> <result-json>');
const report = JSON.parse(await readFile(input,'utf8'));
const generations = report.audio_ingest_generation_reports;
assert.ok(generations?.length > 0,'No OBS audio generation evidence');
assert.equal(report.audio_worker_lifecycle.alive_after_retirement,0,'Ingest worker remained alive');
assert.equal(report.audio_worker_lifecycle.peak_alive,1,'Overlapping writers fed the single guest OBS source');
const sids = new Set(), keys = ['received','consumed','overflow_oldest_dropped','callback_contention_dropped','stale_dropped','pending_frames'];
const totals = Object.fromEntries([...keys,'clock_resets'].map(key => [key,0]));
for (const generation of generations) {
  const evidence = generation.evidence, ingest = evidence.ingest, queue = ingest.queue;
  assert.equal(evidence.sink_removed,true); assert.equal(ingest.worker_joined,true); assert.equal(ingest.worker_exit_ok,true);
  assert.ok(!sids.has(evidence.sid),'Generation counted twice'); sids.add(evidence.sid);
  for (const key of keys) { assert.ok(Number.isSafeInteger(queue[key]) && queue[key] >= 0,`Invalid ${key}`); totals[key] += queue[key]; }
  assert.equal(queue.received,queue.consumed+queue.overflow_oldest_dropped+queue.callback_contention_dropped+queue.stale_dropped+queue.pending_frames,
    'Quiescent received blocks do not reconcile');
  assert.ok(queue.pending_frames <= queue.capacity_frames,'Shutdown tail exceeds capacity');
  totals.clock_resets += ingest.clock_resets;
}
assert.deepEqual(report.audio_ingest_session_totals,totals,'Retired-generation counts missing from session totals');
const result = { verified:true, generations:generations.length, all_generations_reconcile:true,
  worker_count_after_retirement:0, overlapping_writers_observed:false,
  shutdown_tail_counted_as_pending_not_consumed:true, session_totals:totals,
  scope:'application OBS audio ingest only; SDK/device resources and privacy flush remain unqualified' };
await writeFile(output,JSON.stringify(result,null,2));
console.log(`Verified ${generations.length} audio generations; worker count returned to zero; every block accounted for`);
