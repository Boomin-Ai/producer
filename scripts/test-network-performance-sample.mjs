import assert from 'node:assert/strict';
import {parseArguments,parsePs,parseWindows,processFamily,windowsCpu,makeSample,distribution,summarize,metricLabels,WINDOWS_QUERY} from './network-performance-sample.mjs';

let count=0;
function test(label,fn){fn();count++;console.log('PASS '+label);}
const row=(pid,ppid,extra={})=>({pid,ppid,comm:'Producer',rss_bytes:1024,cpu_seconds:1,cpu_reported_core_percent:10,started_at:null,...extra});
const config={pid:100,platform:'win32',logicalCores:8};
const args=['--pid','100','--duration','10','--interval','1000','--out','/tmp/producer-test.jsonl','--stage','cold-open'];

test('explicit bounded CLI options only; no discovery default',()=>{
  const options=parseArguments(args);assert.equal(options.pid,100);assert.equal(options.duration,10);assert.equal(options.interval,1000);assert.equal(options.stage,'cold-open');assert.deepEqual(parseArguments(['--help']),{help:true});
  for(const input of [[],args.slice(0,-2),[...args,'--name','Producer'],[...args,'--pid','100'],['--pid'],args.map(v=>v==='10'?'121':v),args.map(v=>v==='1000'?'999':v),args.map(v=>v==='100'?'0':v),args.map(v=>v==='cold-open'?'room token/secret':v),args.map(v=>v==='10'?'Infinity':v)])assert.throws(()=>parseArguments(input));
  assert.equal(parseArguments(args.map(v=>v==='10'?'120':v)).duration,120);
});
test('ps parser handles paths with spaces, CRLF and comma decimal locales',()=>{
  const {rows,rejected_rows}=parsePs(' 100 1 123.4 200 /Applications/Producer DJ Test.app/Contents/MacOS/producer\r\n 101 100 1,5 10 CEF Helper (Renderer)\r\n');
  assert.equal(rejected_rows,0);assert.equal(rows[0].comm,'/Applications/Producer DJ Test.app/Contents/MacOS/producer');assert.equal(rows[0].rss_bytes,204800);assert.equal(rows[1].cpu_reported_core_percent,1.5);assert.equal(rows[1].comm,'CEF Helper (Renderer)');
});
test('ps parser rejects headers, malformed counters, duplicate PIDs and unsafe numeric values',()=>{
  const result=parsePs('PID PPID CPU RSS COMM\n100 1 NaN 10 x\n100 1 1 10 producer\n100 1 2 10 duplicate\n102 100 -1 10 x\n103 100 1 99999999999999999 x\n');
  assert.equal(result.rows.length,1);assert.equal(result.rejected_rows,5);assert.throws(()=>parsePs('x'.repeat(8*1024*1024+1)));assert.deepEqual(parsePs(''),{rows:[],rejected_rows:0});
});
test('Windows allowlist supports singleton, array, BOM, empty and unknown counters',()=>{
  const raw={pid:100,ppid:1,comm:'Producer DJ Test.exe',rss_bytes:1048576,cpu_seconds:2.5,started_at:'2026-11-08T10:00:00-07:00',argv:'SECRET',token:'SECRET'};
  const one=parseWindows('\uFEFF'+JSON.stringify(raw));assert.equal(one.rows[0].started_at,'2026-11-08T17:00:00.000Z');assert.equal(one.rows[0].cpu_seconds,2.5);assert.ok(!JSON.stringify(one).includes('SECRET'));
  assert.equal(parseWindows(JSON.stringify([raw])).rows.length,1);assert.deepEqual(parseWindows('null'),{rows:[],rejected_rows:0});assert.equal(parseWindows(JSON.stringify({...raw,cpu_seconds:null})).rows[0].cpu_seconds,null);
  assert.equal(parseWindows(JSON.stringify({...raw,cpu_seconds:'2,5'})).rows[0].cpu_seconds,null);assert.throws(()=>parseWindows('invalid JSON'));
});
test('Windows invalid identities and working sets are rejected without coercing null to zero',()=>{
  const result=parseWindows(JSON.stringify([{pid:0,ppid:0,comm:'System',rss_bytes:1},{pid:100,ppid:null,comm:'x',rss_bytes:1},{pid:101,ppid:1,comm:'x',rss_bytes:-1},{pid:102,ppid:1,comm:'x',rss_bytes:1,cpu_seconds:-1}]));
  assert.equal(result.rejected_rows,3);assert.equal(result.rows[0].cpu_seconds,null);
});
test('ownership follows true ancestry, not names, old children or process order',()=>{
  const rows=[row(104,103),row(777,1,{comm:'Producer CEF'}),row(103,101),row(100,1),row(101,100),row(888,777)];
  assert.deepEqual(processFamily(rows,100).map(r=>r.pid),[100,101,103,104]);assert.deepEqual(processFamily(rows,999),[]);
  assert.deepEqual(processFamily([row(100,1),row(101,1)],100).map(r=>r.pid),[100]);
});
test('corrupt parent cycles do not loop or duplicate ownership',()=>{
  assert.deepEqual(processFamily([row(100,101),row(101,100),row(102,101)],100).map(r=>r.pid),[100,101,102]);
});
test('Windows CPU is cumulative delta core percent, including multi-core use',()=>{
  assert.deepEqual(windowsCpu(row(100,1,{cpu_seconds:5}),row(100,1,{cpu_seconds:1}),2000),{value:200,status:'interval_delta'});
  assert.equal(windowsCpu(row(100,1),undefined,1000).status,'baseline');assert.equal(windowsCpu(row(100,1),row(100,1),0).status,'invalid_interval');
  assert.equal(windowsCpu(row(100,1,{cpu_seconds:.5}),row(100,1),1000).status,'counter_reset');assert.equal(windowsCpu(row(100,1,{started_at:'new'}),row(100,1),1000).status,'process_replaced');
  assert.equal(windowsCpu(row(100,1,{cpu_seconds:null}),row(100,1),1000).status,'unavailable');
});
test('Windows first sample is unknown; family total requires complete coverage',()=>{
  const first=makeSample([row(100,1)],{...config,elapsedMs:0});assert.equal(first.sample.totals.cpu_core_percent,null);
  const second=makeSample([row(100,1,{cpu_seconds:3}),row(101,100,{cpu_seconds:.5})],{...config,elapsedMs:1000,previous:first.baseline});
  assert.equal(second.sample.totals.cpu_core_percent,null);assert.equal(second.sample.totals.cpu_known_sum_core_percent,200);assert.equal(second.sample.totals.cpu_known_process_count,1);assert.equal(second.sample.totals.rss_sum_bytes,2048);
  const third=makeSample([row(100,1,{cpu_seconds:4}),row(101,100,{cpu_seconds:1})],{...config,elapsedMs:2000,previous:second.baseline});
  assert.equal(third.sample.totals.cpu_core_percent,150);assert.equal(third.sample.totals.cpu_host_normalized_percent,18.75);
});
test('counter reset rebases one process, not a negative or fabricated zero CPU',()=>{
  const first=makeSample([row(100,1),row(101,100)],{...config,elapsedMs:0});
  const second=makeSample([row(100,1,{cpu_seconds:2}),row(101,100,{cpu_seconds:.1})],{...config,elapsedMs:1000,previous:first.baseline});
  assert.equal(second.sample.processes[1].cpu_status,'counter_reset');assert.equal(second.sample.totals.cpu_core_percent,null);
  const third=makeSample([row(100,1,{cpu_seconds:3}),row(101,100,{cpu_seconds:.6})],{...config,elapsedMs:2000,previous:second.baseline});assert.equal(third.sample.totals.cpu_core_percent,150);
});
test('missing parent terminates collection rather than claiming surviving orphans',()=>{
  const first=makeSample([row(100,1),row(101,100)],{...config,elapsedMs:0});
  const missing=makeSample([row(101,1)],{...config,elapsedMs:1000,previous:first.baseline});assert.equal(missing.sample.status,'terminated');assert.deepEqual(missing.sample.processes,[]);assert.equal(missing.sample.totals.rss_sum_bytes,null);
});
test('a malformed partial snapshot cannot prove the parent terminated',()=>{
  const missing=makeSample([],{...config,elapsedMs:1000,rejectedRows:1});assert.equal(missing.sample.status,'root_unavailable');assert.equal(missing.sample.process_count,0);
});
test('root incarnation/name change stops attribution and excludes replacement family',()=>{
  const first=makeSample([row(100,1,{started_at:'old'})],{...config,elapsedMs:0});
  const next=makeSample([row(100,1,{started_at:'new'}),row(101,100)],{...config,elapsedMs:1000,previous:first.baseline});assert.equal(next.sample.status,'root_replaced');assert.equal(next.sample.process_count,0);
});
test('ps CPU is labeled OS average, kept distinct from Windows interval delta',()=>{
  const mac=makeSample([row(100,1,{cpu_reported_core_percent:125}),row(101,100,{cpu_reported_core_percent:75})],{...config,platform:'darwin',elapsedMs:1});assert.equal(mac.sample.totals.cpu_core_percent,200);assert.equal(mac.sample.totals.cpu_host_normalized_percent,25);
  assert.match(metricLabels('darwin').cpu,/decaying/);assert.match(metricLabels('linux').cpu,/lifetime/);assert.match(metricLabels('win32').cpu,/interval/);assert.match(metricLabels('darwin').memory,/not unique/);assert.throws(()=>metricLabels('unsupported'));
});
test('median/p95/count ignore unknowns and use explicit nearest-rank percentile',()=>{
  assert.deepEqual(distribution([null,NaN,Infinity]),{count:0,median:null,p95:null});assert.deepEqual(distribution([4,1,3,2,null]),{count:4,median:2.5,p95:4});
  assert.deepEqual(distribution(Array.from({length:100},(_,i)=>i+1)),{count:100,median:50.5,p95:95});
});
test('summary excludes terminated zeros and keeps CPU coverage/metric counts',()=>{
  const a=makeSample([row(100,1)],{...config,elapsedMs:0});const b=makeSample([row(100,1,{cpu_seconds:2})],{...config,elapsedMs:1000,previous:a.baseline});const c=makeSample([],{...config,elapsedMs:2000,previous:b.baseline});
  const summary=summarize([a.sample,b.sample,c.sample],{stage:'cold',platform:'win32',root_pid:100,logical_cores:8,labels:metricLabels('win32')},{status:'terminated',elapsedMs:2000});
  assert.equal(summary.terminated,true);assert.equal(summary.sample_count,3);assert.equal(summary.running_sample_count,2);assert.equal(summary.cpu_incomplete_sample_count,1);assert.deepEqual(summary.metrics.cpu_core_percent,{count:1,median:100,p95:100});assert.equal(summary.metrics.rss_sum_bytes.count,2);
});
test('fixed Windows query does not collect command lines, executable paths, or environment',()=>{
  assert.match(WINDOWS_QUERY,/Get-CimInstance Win32_Process/);assert.match(WINDOWS_QUERY,/KernelModeTime/);assert.match(WINDOWS_QUERY,/ParentProcessId/);assert.doesNotMatch(WINDOWS_QUERY,/CommandLine|ExecutablePath|Environment|Stop-Process|Invoke-Expression/i);
});
console.log(`PASS ${count} passive sampler parser/ownership/aggregation cases; no OS process sample, application control or media performed.`);
