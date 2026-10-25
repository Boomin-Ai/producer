import os from 'node:os';
import path from 'node:path';
// Real local Worker verification. Reads only the development endpoint token;
// the Anthropic credential stays encrypted inside the managed connection.
import fs from 'node:fs';
const env=Object.fromEntries(fs.readFileSync(path.join(os.homedir(),'Library/Application Support/ai.boomin.producer.sets-v2-dev/local-workspace/workspace.env'),'utf8').trim().split('\n').map(l=>{const n=l.indexOf('=');return [l.slice(0,n),l.slice(n+1)];}));
const headers={Authorization:'Bearer '+env.PRIMARY_TOKEN,'Content-Type':'application/json'},base='http://127.0.0.1:8795';
async function call(path,body){const response=await fetch(base+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});const result=await response.json();if(!response.ok)throw Error(`${path}: ${response.status} ${result.error?.message??'Request failed'}`);return result;}
const {room}=await call('/v1/app/live/rooms',{title:'Sets v2 · Managed integration proof',external_ref:'sets-v2-managed-proof'});
const doc=JSON.parse(fs.readFileSync('docs/shows/just-facts.json','utf8')),list=await call('/v1/app/data-integrations'),connection=list.connections.find(c=>c.connection.id==='claude-research');if(!connection?.hasSecret)throw Error('Save the managed Claude connection first');
const root=`/v1/app/live/rooms/${room.id}/set-runtime`,previous=await call(root),deployment='proof-'+crypto.randomUUID();
let reply=await call(root,{deployment,definition:doc.runtime,bindings:{research:{id:'claude-research',revision:connection.revision}},expectedEpoch:previous.snapshot?.setEpoch??0});
const command=(op,input={})=>({id:crypto.randomUUID(),setEpoch:reply.snapshot.setEpoch,module:'research',epoch:reply.snapshot.modules.research.epoch,op,input});
reply=await call(root+'/commands',{command:command('start')});
const asked=command('agent.ask',{question:'Is oxygen the most abundant gas in Earth’s atmosphere? Check the claim against primary scientific sources. Give a concise answer with citations.'});
reply=await call(root+'/modules/research/query',{command:asked});if(reply.result?.status!=='committed')throw Error('Research result was not committed');
const agent=reply.snapshot.modules.research.agent;if(agent.status!=='completed'||!agent.citations.length||agent.displayedResponse)throw Error('Research privacy/completion check failed');
reply=await call(root+'/commands',{command:command('agent.show')});if(!reply.snapshot.modules.research.agent.displayedResponse)throw Error('Show response failed');
fs.writeFileSync('/private/tmp/producer-just-facts-managed-answer.json',JSON.stringify({room:room.id,deployment,snapshot:reply.snapshot,result:agent},null,2),{mode:0o600});
const proof={scope:'Actual local Cloudflare Worker HTTP routes, encrypted saved Claude credential, durable room module authority, researched answer and explicit show gate',at:new Date().toISOString(),model:connection.connection.model,citations:agent.citations.length,responseCharacters:agent.response.length,encryptedConnection:true,withheldBeforeShow:true,shownAfterAction:true};
fs.writeFileSync('docs/set-runtime/claude-managed-proof.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
