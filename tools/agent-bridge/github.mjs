import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

export const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed','blocked'] },
    summary: { type: 'string', maxLength: 2000 },
    checks: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 200 } },
  }, required: ['status','summary','checks'],
};
export async function command(executable, args, cwd) {
  return (await execute(executable,args,{cwd,windowsHide:true,timeout:30_000,maxBuffer:2_000_000})).stdout;
}
const ghName = process.platform === 'win32' ? 'gh.exe' : 'gh';
export async function gh(args) { return JSON.parse(await command(ghName,args)); }
export function safeText(text) {
  return String(text).replace(/https?:\/\/\S+/g,'[link omitted]')
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g,'[credential omitted]')
    .replace(/\bBearer\s+\S+/gi,'Bearer [omitted]')
    .replace(/\b(?:gr_|gi_)[A-Za-z0-9_-]+/g,'[invite omitted]');
}
export async function reference(config, packet) {
  const comment = await gh(['api',`repos/${config.repo}/issues/comments/${packet.commentId}`]);
  if (!config.actors.map(a=>a.toLowerCase()).includes(comment.user?.login?.toLowerCase()) || comment.issue_url !== `https://api.github.com/repos/${config.repo}/issues/${packet.issue}` || !comment.body?.startsWith(`[BRIDGE TO ${config.peer.toUpperCase()}]\n`) && !comment.body?.startsWith(`[BRIDGE TO ${config.peer.toUpperCase()}]\r\n`)) throw new Error('Current GitHub comment no longer matches the authorized route');
  const issue = await gh(['issue','view',String(packet.issue),'-R',config.repo,'--json','title,body,comments']);
  return { title:issue.title, issueBody:safeText(issue.body).slice(0,16000), handoff:safeText(comment.body).slice(0,8000), recentComments:issue.comments.slice(-12).map(c=>({author:c.author?.login,body:safeText(c.body).slice(0,2000)})) };
}
export function resultFrom(report) {
  const value = JSON.parse(report);
  if (!['completed','blocked'].includes(value.status) || typeof value.summary !== 'string' || value.summary.length>2000 || !Array.isArray(value.checks) || value.checks.length>10 || value.checks.some(s=>typeof s!=='string'||s.length>200)) throw new Error('Worker did not return the bounded result schema');
  return value;
}
export async function acknowledge(config, packet, outcome) {
  const prefix=`[${config.peer.toUpperCase()} BRIDGE ACK]`;
  const pages=await gh(['api',`repos/${config.repo}/issues/${packet.issue}/comments?per_page=100`,'--paginate','--slurp']);
  const prior=pages.flat().find(c=>c.body?.startsWith(prefix) && c.body.split(/\r?\n/).includes(`Event: ${packet.id}`));
  if(prior)return {url:prior.html_url,duplicate:true};
  const branch=(await command('git',['branch','--show-current'],config.workerCwd)).trim();
  const sha=(await command('git',['rev-parse','HEAD'],config.workerCwd)).trim();
  const body=`${prefix}\nEvent: ${packet.id}\nResult: ${outcome.status}\nCheckout: ${branch} @ ${sha}\n\n${safeText(outcome.summary)}\n\n${outcome.checks.map(c=>'- '+safeText(c)).join('\n')}\n\nSeparate bridge worker; no interactive desktop chat was resumed.`;
  // Only this fixed repository/issue result operation uses host GitHub credentials.
  const input=JSON.stringify({body});
  const {spawn}=await import('node:child_process');
  const child=spawn(ghName,['api',`repos/${config.repo}/issues/${packet.issue}/comments`,'--method','POST','--input','-'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const result=await new Promise((resolve,reject)=>{
    let output='';let errors='';const timer=setTimeout(()=>{child.kill();reject(new Error('GitHub ACK timed out; inspect before retry'));},30_000);
    child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',code=>{clearTimeout(timer);if(code===0){try{resolve(JSON.parse(output));}catch(error){reject(error);}}else reject(new Error(`GitHub ACK failed (${code})`));});
    child.stdin.end(input);
  });
  return {url:result.html_url,duplicate:false};
}
