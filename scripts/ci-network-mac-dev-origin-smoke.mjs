#!/usr/bin/env node
// CI-only native WebView IPC proof. Fixed calls, no app UI/account/media code.
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,lstat,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';

export const IDENTIFIER='ai.boomin.producer.sets-v2-dev',ORIGIN='http://localhost:1436';
export const COMMANDS=['plugin:app|identifier','live_set_v2_smoke_enabled','live_set_v2_report'];
const RUNTIME_ENVIRONMENT=['HOME','PATH','USER','LOGNAME','TMPDIR','LANG','LC_ALL','LC_CTYPE','SHELL','__CF_USER_TEXT_ENCODING'];
const FAILURES=new Set(['bridge_missing','identifier_denied','identifier_wrong','smoke_denied','smoke_false','report_denied','origin_wrong']);
const bytes=64*1024;
function require(value,code){if(!value)throw Error(code);}

export function runtimeEnvironment(input){
  // The outer CI signing step has credentials. The GUI app needs only normal
  // OS runtime values and this exact flag; preserve HOME rather than replace it.
  return {...Object.fromEntries(RUNTIME_ENVIRONMENT.filter(key=>typeof input[key]==='string').map(key=>[key,input[key]])),PRODUCER_SETS_V2_UI_PROBE:'1'};
}

export function smokeHtml(nonce){
  require(/^[a-f0-9-]{36}$/.test(nonce),'invalid_nonce');
  return `<!doctype html><meta charset="utf-8"><title>Native IPC smoke only</title><p>Core and custom IPC check; no account or media.</p><script>
(async()=>{
  const expected=${JSON.stringify(IDENTIFIER)},nonce=${JSON.stringify(nonce)};
  const failed=stage=>fetch('/?smokeFailure='+stage).catch(()=>{});
  if(location.origin!==${JSON.stringify(ORIGIN)}){failed('origin_wrong');return;}
  for(let i=0;i<50&&!window.__TAURI_INTERNALS__?.invoke;i++)await new Promise(r=>setTimeout(r,100));
  if(!window.__TAURI_INTERNALS__?.invoke){failed('bridge_missing');return;}
  const invoke=(command,args)=>window.__TAURI_INTERNALS__.invoke(command,args);
  let id;try{id=await invoke('plugin:app|identifier');}catch{failed('identifier_denied');return;}
  if(id!==expected){failed('identifier_wrong');return;}
  let enabled;try{enabled=await invoke('live_set_v2_smoke_enabled');}catch{failed('smoke_denied');return;}
  if(enabled!==true){failed('smoke_false');return;}
  try{await invoke('live_set_v2_report',{result:{schema:'producer.native-origin-smoke/1',nonce,identifier:id,origin:location.origin,smoke_enabled:true,core_ipc:true,custom_ipc:true,commands:${JSON.stringify(COMMANDS)}}});}
  catch{failed('report_denied');}
})().catch(()=>{});
</script>`;
}

export function validateNativeReport(value,nonce){
  return !!value&&value.schema==='producer.native-origin-smoke/1'&&value.nonce===nonce&&value.identifier===IDENTIFIER&&value.origin===ORIGIN&&value.smoke_enabled===true&&value.core_ipc===true&&value.custom_ipc===true&&JSON.stringify(value.commands)===JSON.stringify(COMMANDS);
}

export function serveHtml(html,diagnostics){
  return createServer((req,res)=>{
    // Only static HTML GET/HEAD. No RPC/eval/command endpoint, external proxy,
    // writable request body, or arbitrary diagnostics payload exists here.
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return;}
    if(!['localhost:1436','127.0.0.1:1436'].includes(req.headers.host)){res.writeHead(403);res.end();return;}
    const url=new URL(req.url,ORIGIN);
    if(!['/','/index.html'].includes(url.pathname)){res.writeHead(404);res.end();return;}
    const failure=url.searchParams.get('smokeFailure');
    if(FAILURES.has(failure))diagnostics.failure=failure;
    diagnostics.html_requests++;
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:html);
  });
}

function under(parent,child){const part=relative(parent,child);return part!==''&&!isAbsolute(part)&&part!=='..'&&!part.startsWith('..'+(process.platform==='win32'?'\\':'/'));}
async function exists(path){try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}

export async function nativeOriginSmoke(appPath,outPath){
  require(process.platform==='darwin'&&process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true','ci_macos_only');
  const workspace=resolve(process.env.GITHUB_WORKSPACE??''),runner=resolve(process.env.RUNNER_TEMP??''),app=resolve(appPath),out=resolve(outPath);
  require(process.env.GITHUB_WORKSPACE&&process.env.RUNNER_TEMP&&under(workspace,app)&&under(workspace,out),'unexpected_ci_paths');
  require(app.endsWith('/candidate/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Producer DJ Test.app'),'unexpected_app_path');
  require(!await exists(out),'proof_destination_exists');
  const plist=join(app,'Contents/Info.plist');
  const info=JSON.parse(execFileSync('plutil',['-convert','json','-o','-',plist],{encoding:'utf8'}));
  require(info.CFBundleIdentifier===IDENTIFIER,'unexpected_bundle_identifier');
  require(typeof info.CFBundleExecutable==='string'&&!/[\/\\]/.test(info.CFBundleExecutable),'unexpected_executable');
  const executable=join(app,'Contents/MacOS',info.CFBundleExecutable),profile=join(homedir(),'Library/Application Support',IDENTIFIER);
  require(!await exists(profile),'preexisting_profile_refused');
  require(under(runner,resolve(runner,'native-origin-smoke')),'unexpected_runner_directory');
  // A real GUI bootstrap is required. A missing native WebView is a failure,
  // never a skipped/green substitute for IPC acceptance.
  try{execFileSync('/bin/launchctl',['print',`gui/${process.getuid()}`],{stdio:'ignore',timeout:3000});}catch{throw Error('gui_session_unavailable');}
  const nonce=randomUUID(),diagnostics={html_requests:0,failure:null,stdout_bytes:0,stderr_bytes:0},server=serveHtml(smokeHtml(nonce),diagnostics);
  const reportPath=join(profile,'sets-v2-ui-proof.json');
  let child,launched=false,closed=false,exitCode=null,exitSignal=null,passed=false,status='not_started';
  const start=Date.now();let report;
  try{
    await new Promise((yes,no)=>{server.once('error',()=>no(Error('loopback_port_unavailable')));server.listen(1436,'127.0.0.1',yes);});
    child=spawn(executable,[],{cwd:join(app,'Contents/MacOS'),env:runtimeEnvironment(process.env),stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>diagnostics.stdout_bytes+=chunk.length);child.stderr.on('data',chunk=>diagnostics.stderr_bytes+=chunk.length);
    child.on('error',()=>{closed=true;status='native_launch_failed';});
    child.on('exit',(code,signal)=>{closed=true;exitCode=code;exitSignal=signal;});
    launched=Number.isInteger(child.pid);status=launched?'waiting_for_native_report':'native_launch_failed';
    while(Date.now()-start<30000){
      if(diagnostics.failure){status=diagnostics.failure;break;}
      if(closed){if(status!=='native_launch_failed')status='native_exited_before_report';break;}
      try{
        const stat=await lstat(reportPath);
        require(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=bytes&&stat.mtimeMs>=start-1000,'invalid_native_report_file');
        const candidate=JSON.parse(await readFile(reportPath,'utf8'));
        if(validateNativeReport(candidate,nonce)){report=candidate;passed=true;status='passed';break;}
      }catch(error){if(error.message==='invalid_native_report_file')throw error;/* absent or in-progress native write */}
      await wait(200);
    }
    if(status==='waiting_for_native_report')status='native_ipc_report_timeout';
  }catch(error){status=['loopback_port_unavailable','invalid_native_report_file'].includes(error.message)?error.message:'smoke_failed';}
  finally{
    if(launched&&!closed){
      child.kill('SIGTERM');
      for(let i=0;i<15&&!closed;i++)await wait(100);
      if(!closed){child.kill('SIGKILL');for(let i=0;i<15&&!closed;i++)await wait(100);}
    }
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    // Initially absent and created only by this exact CI-owned app. Never
    // clean a preexisting profile or any normal developer/user installation.
    if(launched&&closed)await rm(profile,{recursive:true,force:true});
  }
  const proof={schema:'producer.native-origin-smoke/1',status,passed,nonce,identifier:IDENTIFIER,origin:ORIGIN,commands:COMMANDS,core_ipc:passed,custom_ipc:passed,smoke_enabled:passed,
    application_launched:launched,owned_pid:child?.pid??null,owned_process_exited:closed,exit_code:exitCode,exit_signal:exitSignal,elapsed_ms:Date.now()-start,
    binary_sha256:createHash('sha256').update(await readFile(executable)).digest('hex'),diagnostics,
    scope:'core+custom IPC from signed native loopback WebView only; no accounts, rooms, capture, audio, video, tones, streaming or RTC qualification',
  };
  if(passed)require(validateNativeReport(report,nonce),'report_mismatch');
  await writeFile(out,JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});
  require(passed&&launched&&closed,'native_origin_smoke_failed:'+status);
  return proof;
}

export async function selfTest(){
  const assert=(await import('node:assert/strict')).default,{runInNewContext}=await import('node:vm');
  const nonce='12345678-1234-4234-8234-123456789abc',html=smokeHtml(nonce),script=/<script>([\s\S]*)<\/script>/.exec(html)[1];
  const run=async({deny,identifier=IDENTIFIER,enabled=true}={})=>{
    const calls=[],reports=[],failures=[];
    await runInNewContext(script,{window:{__TAURI_INTERNALS__:{async invoke(command,args){calls.push(command);if(command===deny)throw Error('SENSITIVE_PROVIDER_MESSAGE');if(command===COMMANDS[0])return identifier;if(command===COMMANDS[1])return enabled;if(command===COMMANDS[2])reports.push(args.result);else if(!COMMANDS.includes(command))throw Error('unexpected command');}}},location:{origin:ORIGIN},setTimeout,fetch:async url=>{failures.push(url);}});
    return {calls,reports,failures};
  };
  const good=await run();assert.deepEqual(good.calls,COMMANDS);assert.equal(good.reports.length,1);assert(validateNativeReport(good.reports[0],nonce));assert.equal(good.failures.length,0);
  for(const [deny,failure] of [[COMMANDS[0],'identifier_denied'],[COMMANDS[1],'smoke_denied'],[COMMANDS[2],'report_denied']]){
    const result=await run({deny});assert.equal(result.reports.length,0);assert(result.failures.some(url=>url.endsWith(failure)));assert(!JSON.stringify(result).includes('SENSITIVE'));
  }
  assert.equal((await run({identifier:'ai.boomin.producer'})).reports.length,0);assert.equal((await run({enabled:false})).reports.length,0);
  assert(!validateNativeReport({...good.reports[0],nonce:'stale'},nonce));assert(!validateNativeReport({...good.reports[0],origin:'https://producer.dev'},nonce));assert(!validateNativeReport({...good.reports[0],commands:['record']},nonce));
  assert.throws(()=>smokeHtml('</script>'));assert(!under('/work','/work-other/file'));assert(under('/work','/work/candidate'));
  assert.doesNotMatch(script,/eval\(|getUserMedia|connectRoom|engine_|record|capture|email|token/i);
  const inherited={HOME:'/Users/runner',PATH:'/usr/bin:/bin',USER:'runner',LOGNAME:'runner',TMPDIR:'/tmp/runner/',LANG:'en_US.UTF-8',LC_ALL:'C',LC_CTYPE:'UTF-8',SHELL:'/bin/bash',__CF_USER_TEXT_ENCODING:'0x1F5:0x0:0x0',
    GH_TOKEN:'SECRET_GH',CERT_B64:'SECRET_CERT',CERT_PW:'SECRET_CERT_PASSWORD',NOTARY_PW:'SECRET_NOTARY',NOTARY_ID:'SECRET_APPLE_EMAIL',APPLE_PASSWORD:'SECRET_APPLE',CODEX_HOME:'SECRET_CODEX',OPENAI_API_KEY:'SECRET_PROVIDER',GITHUB_ACTIONS:'true',CI:'true',PRODUCER_SETS_V2_UI_PROBE:'0'};
  const environment=runtimeEnvironment(inherited);
  assert.deepEqual(Object.keys(environment).sort(),[...RUNTIME_ENVIRONMENT,'PRODUCER_SETS_V2_UI_PROBE'].sort());
  for(const key of RUNTIME_ENVIRONMENT)assert.equal(environment[key],inherited[key]);
  assert.equal(environment.HOME,'/Users/runner');assert.equal(environment.PRODUCER_SETS_V2_UI_PROBE,'1');assert.equal(inherited.PRODUCER_SETS_V2_UI_PROBE,'0');assert(!JSON.stringify(environment).includes('SECRET'));
  assert.deepEqual(runtimeEnvironment({GH_TOKEN:'SECRET'}),{PRODUCER_SETS_V2_UI_PROBE:'1'});
  console.log('PASS native-origin smoke IPC/path fixtures and OS environment allowlist/secret rejection; HOME preserved; no app or server launched.');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv[2]==='--self-test'&&process.argv.length===3)await selfTest();
    else{require(process.argv.length===4,'expected_app_and_output');const result=await nativeOriginSmoke(process.argv[2],process.argv[3]);console.log('PASS signed native loopback core+custom IPC smoke ('+result.elapsed_ms+'ms); devices/RTC not qualified.');}
  }catch(error){console.error('Native origin smoke failed: '+(/^[a-z0-9_:]+$/.test(error.message)?error.message:'fixed_scope_check_failed'));process.exitCode=1;}
}
