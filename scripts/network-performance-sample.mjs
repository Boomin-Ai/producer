#!/usr/bin/env node
// Passive OS metrics only. No application control, argv, credentials or media.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {cpus} from 'node:os';
import {open,mkdir,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';

const execute=promisify(execFile),MAX_ROWS=65536,MAX_BYTES=8*1024*1024;
export const HELP=`Passive Producer process sampler (Node 24+)
  node scripts/network-performance-sample.mjs --pid PID --duration SECONDS --interval MS --out PATH --stage LABEL

All options are required. Duration: 1–120 seconds. Interval: 1000–120000 ms.
Stage: 1–64 letters/digits/dot/underscore/hyphen, starting with a letter.
Writes new PATH as JSONL and PATH.summary.json; refuses to overwrite either.
Requires an explicit root PID. No process-name discovery or application control.
Mac/Linux CPU is OS-reported average, not the Windows interval CPU-time delta.
RSS sums include shared pages more than once; they are not unique memory.
This measures process costs, not room latency, decoded frames, or audible audio.`;

function fail(message){throw new Error(message);}
function finite(value){return typeof value==='number'&&Number.isFinite(value)?value:null;}
function nonnegative(value){const n=finite(value);return n!==null&&n>=0?n:null;}
function integer(value,min=0){return Number.isSafeInteger(value)&&value>=min?value:null;}
function name(value){return typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,1024).trim():'';}
function decimal(value){return /^\d+(?:[.,]\d+)?$/.test(value)?nonnegative(Number(value.replace(',','.'))):null;}

export function parseArguments(args){
  if(args.length===1&&['--help','-h'].includes(args[0]))return {help:true};
  const allowed=new Set(['pid','duration','interval','out','stage']),options={};
  for(let i=0;i<args.length;i+=2){
    const flag=args[i];
    if(!flag?.startsWith('--')||!allowed.has(flag.slice(2)))fail('Unknown option. Use --help.');
    const key=flag.slice(2),value=args[i+1];
    if(Object.hasOwn(options,key)||value===undefined||value.startsWith('--'))fail('Every option needs one value and may appear only once.');
    options[key]=value;
  }
  if([...allowed].some(key=>!Object.hasOwn(options,key)))fail('All five options are required. Use --help.');
  if(!/^\d+$/.test(options.pid)||integer(Number(options.pid),1)===null)fail('--pid must be a positive integer.');
  if(!/^\d+(?:\.\d+)?$/.test(options.duration)||Number(options.duration)<1||Number(options.duration)>120)fail('--duration must be 1–120 seconds.');
  if(!/^\d+$/.test(options.interval)||integer(Number(options.interval),1000)===null||Number(options.interval)>120000)fail('--interval must be 1000–120000 milliseconds.');
  if(!/^[a-z][a-z0-9._-]{0,63}$/i.test(options.stage))fail('--stage must be a safe 1–64 character label.');
  if(!options.out.trim()||/[\u0000-\u001f\u007f]/.test(options.out))fail('--out must be an explicit output path.');
  return {pid:Number(options.pid),duration:Number(options.duration),interval:Number(options.interval),out:resolve(options.out),stage:options.stage};
}

/** ps comm is the executable/name field, never args/command. LC_ALL=C at capture;
 * comma decimals are accepted for imported fixtures from other locales. */
export function parsePs(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)fail('Process snapshot exceeded its format/size budget.');
  const rows=[],seen=new Set();let rejected=0;
  for(const line of text.split(/\r?\n/)){
    if(!line.trim())continue;
    if(rows.length+rejected>=MAX_ROWS)fail('Process snapshot exceeded its row budget.');
    const match=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if(!match){rejected++;continue;}
    const pid=integer(Number(match[1]),1),ppid=integer(Number(match[2])),cpu=decimal(match[3]),rss=integer(Number(match[4])*1024),comm=name(match[5]);
    if(pid===null||ppid===null||cpu===null||rss===null||!comm||seen.has(pid)){rejected++;continue;}
    seen.add(pid);rows.push({pid,ppid,comm,rss_bytes:rss,cpu_reported_core_percent:cpu,cpu_seconds:null,started_at:null});
  }
  return {rows,rejected_rows:rejected};
}

/** Takes only the fields our fixed PowerShell projection emits. Unknown fields
 * and provider error text cannot escape into the trace. */
export function parseWindows(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)fail('Process snapshot exceeded its format/size budget.');
  let decoded;try{decoded=JSON.parse(text.replace(/^\uFEFF/,''));}catch{fail('Windows process snapshot was not valid JSON.');}
  const input=decoded===null?[]:Array.isArray(decoded)?decoded:[decoded];
  if(input.length>MAX_ROWS)fail('Process snapshot exceeded its row budget.');
  const rows=[],seen=new Set();let rejected=0;
  for(const raw of input){
    if(!raw||typeof raw!=='object'){rejected++;continue;}
    const pid=integer(raw.pid,1),ppid=integer(raw.ppid),rss=integer(raw.rss_bytes),comm=name(raw.comm);
    if(pid===null||ppid===null||rss===null||!comm||seen.has(pid)){rejected++;continue;}
    let started=null;
    if(typeof raw.started_at==='string'&&raw.started_at.length<=64&&Number.isFinite(Date.parse(raw.started_at)))started=new Date(raw.started_at).toISOString();
    seen.add(pid);rows.push({pid,ppid,comm,rss_bytes:rss,cpu_reported_core_percent:null,cpu_seconds:nonnegative(raw.cpu_seconds),started_at:started});
  }
  return {rows,rejected_rows:rejected};
}

/** Snapshot ancestry only. A helper reparented to launchd/systemd is excluded,
 * even if its name resembles Producer or it belonged to an earlier snapshot. */
export function processFamily(rows,rootPid){
  const byId=new Map(rows.map(row=>[row.pid,row])),children=new Map();
  if(!byId.has(rootPid))return [];
  for(const row of byId.values()){
    if(!children.has(row.ppid))children.set(row.ppid,[]);
    children.get(row.ppid).push(row);
  }
  const result=[],seen=new Set(),queue=[byId.get(rootPid)];
  for(let i=0;i<queue.length;i++){
    const row=queue[i];if(seen.has(row.pid))continue;seen.add(row.pid);result.push(row);
    queue.push(...(children.get(row.pid)??[]).sort((a,b)=>a.pid-b.pid));
  }
  return result;
}

export function windowsCpu(current,previous,elapsedMs){
  if(!previous)return {value:null,status:'baseline'};
  if(current.started_at!==previous.started_at||current.comm!==previous.comm)return {value:null,status:'process_replaced'};
  if(!Number.isFinite(elapsedMs)||elapsedMs<=0)return {value:null,status:'invalid_interval'};
  if(nonnegative(current.cpu_seconds)===null||nonnegative(previous.cpu_seconds)===null)return {value:null,status:'unavailable'};
  const delta=current.cpu_seconds-previous.cpu_seconds;
  return delta<0?{value:null,status:'counter_reset'}:{value:delta*100000/elapsedMs,status:'interval_delta'};
}

export function metricLabels(platform){
  if(!['darwin','linux','win32'].includes(platform))fail('Supported platforms are macOS, Linux and Windows.');
  return {
    cpu:platform==='win32'?'interval_cpu_time_delta_core_percent':platform==='darwin'?'ps_reported_decaying_cpu_core_percent':'ps_reported_lifetime_cpu_core_percent',
    cpu_unit:'100% equals one logical CPU core; family sum may exceed 100%',
    normalized_cpu:'family core percent divided by recorded host logical core count',
    cpu_comparison:'OS-reported averages and Windows interval deltas are different measurements; use matched within-platform stages, not unqualified cross-platform raw-percent comparisons',
    memory:'sum of process RSS/working sets in bytes; shared pages may be counted repeatedly; not unique physical memory',
    ownership:'explicit root PID and current parent-chain descendants only; reparented helpers and launchd/WebKit services are not attributed',
    identity_limit:platform==='win32'?'creation timestamp/name changes end root attribution; regressed CPU counters are rebased':'ps PID/PPID/comm cannot detect same-name PID reuse between snapshots; name changes end root attribution',
  };
}

export function makeSample(rows,{pid,platform,logicalCores,elapsedMs,previous=null,timestamp=new Date().toISOString(),queryDurationMs=0,rejectedRows=0}){
  const family=processFamily(rows,pid),root=family[0],priorRoot=previous?.family?.[0];
  let status=root?'running':rejectedRows?'root_unavailable':'terminated';
  if(root&&priorRoot&&(root.comm!==priorRoot.comm||root.started_at!==priorRoot.started_at))status='root_replaced';
  const prior=new Map((previous?.family??[]).map(row=>[row.pid,row]));
  const processes=status==='running'?family.map(row=>{
    const cpu=platform==='win32'?windowsCpu(row,prior.get(row.pid),elapsedMs-(previous?.elapsedMs??elapsedMs)):{value:row.cpu_reported_core_percent,status:'os_reported_average'};
    return {pid:row.pid,ppid:row.ppid,comm:row.comm,rss_bytes:row.rss_bytes,cpu_core_percent:cpu.value,cpu_status:cpu.status};
  }):[];
  const known=processes.filter(row=>row.cpu_core_percent!==null),sum=known.reduce((total,row)=>total+row.cpu_core_percent,0),complete=processes.length>0&&known.length===processes.length;
  const sample={type:'sample',timestamp,elapsed_ms:elapsedMs,query_duration_ms:queryDurationMs,status,root_pid:pid,rejected_rows:rejectedRows,process_count:processes.length,processes,totals:{
    rss_sum_bytes:processes.length?processes.reduce((total,row)=>total+row.rss_bytes,0):null,
    cpu_core_percent:complete?sum:null,cpu_host_normalized_percent:complete&&integer(logicalCores,1)!==null?sum/logicalCores:null,
    cpu_known_sum_core_percent:known.length?sum:null,cpu_known_process_count:known.length,
  }};
  return {sample,baseline:{family,elapsedMs}};
}

export function distribution(values){
  const sorted=values.filter(value=>finite(value)!==null).sort((a,b)=>a-b),n=sorted.length;
  return {count:n,median:n?(sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2:null,p95:n?sorted[Math.ceil(n*.95)-1]:null};
}
export function summarize(samples,metadata,{status='completed',elapsedMs=0}={}){
  const running=samples.filter(sample=>sample.status==='running');
  const metric=key=>distribution(running.map(sample=>sample.totals[key]));
  return {schema:'producer.os-process-summary/1',stage:metadata.stage,platform:metadata.platform,root_pid:metadata.root_pid,logical_cores:metadata.logical_cores,status,elapsed_ms:elapsedMs,sample_count:samples.length,running_sample_count:running.length,
    terminated:samples.some(sample=>sample.status==='terminated'),root_replaced:samples.some(sample=>sample.status==='root_replaced'),labels:metadata.labels,
    metrics:{cpu_core_percent:metric('cpu_core_percent'),cpu_host_normalized_percent:metric('cpu_host_normalized_percent'),rss_sum_bytes:metric('rss_sum_bytes'),process_count:distribution(running.map(sample=>sample.process_count)),query_duration_ms:distribution(samples.map(sample=>sample.query_duration_ms))},
    cpu_incomplete_sample_count:running.filter(sample=>sample.totals.cpu_core_percent===null).length,
    percentile_method:'median of sorted values; p95 nearest-rank; unknown values excluded, never treated as zero',
  };
}

// CIM fields come from one process enumeration, avoiding a parent-map/name join
// against a second query whose PIDs could already have been reused. CPU is
// cumulative kernel+user time in seconds, not a percentage from Get-Process.
export const WINDOWS_QUERY=`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate | ForEach-Object {
  $cpu=$null
  if($null -ne $_.KernelModeTime -and $null -ne $_.UserModeTime){$cpu=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000}
  $started=$null
  if($null -ne $_.CreationDate){$started=$_.CreationDate.ToUniversalTime().ToString('o',[System.Globalization.CultureInfo]::InvariantCulture)}
  [PSCustomObject]@{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;comm=[string]$_.Name;rss_bytes=[long]$_.WorkingSetSize;cpu_seconds=$cpu;started_at=$started}
})
ConvertTo-Json -InputObject $rows -Compress`;

async function readProcesses(platform,timeout){
  const command=platform==='win32'?'powershell.exe':'ps';
  const args=platform==='win32'?['-NoLogo','-NoProfile','-NonInteractive','-Command',WINDOWS_QUERY]:['-axo','pid=,ppid=,%cpu=,rss=,comm='];
  let stdout;
  try{({stdout}=await execute(command,args,{encoding:'utf8',windowsHide:true,maxBuffer:MAX_BYTES,timeout,env:{...process.env,LC_ALL:'C',LANG:'C'}}));}
  catch{fail('OS process query failed or timed out; no application was controlled.');}
  return platform==='win32'?parseWindows(stdout):parsePs(stdout);
}

/** Importing this module never queries processes; only this explicit CLI entry
 * samples. The caller supplies PID, stage and new output destinations. */
export async function runSampler(options){
  if(Number(process.versions.node.split('.')[0])<24)fail('This sampler requires Node 24 or newer.');
  const platform=process.platform,labels=metricLabels(platform),logicalCores=cpus().length;
  await mkdir(dirname(options.out),{recursive:true,mode:0o700});
  const output=await open(options.out,'wx',0o600);let summaryFile;
  try{summaryFile=await open(options.out+'.summary.json','wx',0o600);}catch{await output.close();await unlink(options.out);fail('Summary destination already exists or cannot be opened; no sampling started.');}
  const samples=[],start=performance.now(),end=start+options.duration*1000,stopWait=new AbortController();let stopped=false,baseline=null,status='completed';
  const stop=()=>{stopped=true;stopWait.abort();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  const metadata={type:'metadata',schema:'producer.os-process-sample/1',started_at:new Date().toISOString(),platform,arch:process.arch,node:process.version,stage:options.stage,root_pid:options.pid,logical_cores:logicalCores,duration_seconds:options.duration,interval_ms:options.interval,labels};
  let failure;
  try{
    await output.writeFile(JSON.stringify(metadata)+'\n');
    while(!stopped&&performance.now()<end){
      const queryStart=performance.now(),result=await readProcesses(platform,Math.max(1,Math.ceil(Math.min(5000,end-queryStart))));
      const now=performance.now(),made=makeSample(result.rows,{pid:options.pid,platform,logicalCores,elapsedMs:now-start,previous:baseline,queryDurationMs:now-queryStart,rejectedRows:result.rejected_rows});
      samples.push(made.sample);baseline=made.baseline;await output.writeFile(JSON.stringify(made.sample)+'\n');
      if(made.sample.status!=='running'){status=made.sample.status;break;}
      // Schedule from the capture start; do not overlap queries or catch up by
      // issuing a burst after a slow PowerShell/ps read.
      const wait=Math.min(end,queryStart+options.interval)-performance.now();
      if(wait>0)await delay(wait,undefined,{signal:stopWait.signal}).catch(error=>{if(error.name!=='AbortError')throw error;});
    }
    if(stopped)status='interrupted';
  }catch(error){status='query_failed';failure=error;await output.writeFile(JSON.stringify({type:'error',code:'process_query_failed',elapsed_ms:performance.now()-start})+'\n');}
  finally{
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
    const summary=summarize(samples,metadata,{status,elapsedMs:performance.now()-start});
    try{await output.writeFile(JSON.stringify({type:'summary',...summary})+'\n');await output.sync();await summaryFile.writeFile(JSON.stringify(summary,null,2)+'\n');await summaryFile.sync();}
    finally{await Promise.all([output.close(),summaryFile.close()]);}
  }
  if(failure)throw failure;
  return {out:options.out,summary:options.out+'.summary.json',status};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const options=parseArguments(process.argv.slice(2));
    if(options.help)console.log(HELP);
    else{const result=await runSampler(options);console.log(`Passive sample ${result.status}; JSONL: ${result.out}; summary: ${result.summary}`);}
  }catch(error){console.error(error instanceof Error&&error.message.startsWith('OS process query')?error.message:error instanceof Error&&error.code?`Sampler file access failed (${error.code}).`:error instanceof Error?error.message:'Sampler failed.');process.exitCode=1;}
}
