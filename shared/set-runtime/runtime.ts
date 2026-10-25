import {answerPages} from './projection';
import {evaluate,fieldValue,key,parseRuntimeDefinition,type RuntimeDefinition,type ModuleDefinition,type ModuleInstanceDefinition,type Scalar,type Role} from './contract';
export interface Principal {role:Role;id:string;modules:readonly string[];actions?:readonly string[]}
export interface Command {id:string;setEpoch:number;module:string;epoch:number;op:string;input?:Record<string,Scalar>;expectedRevision?:number}
export type Result={status:'committed';revision:number;moduleEpoch:number}|{status:'rejected';revision:number;error:string};
export interface Submission {id:string;name:string;text:string;at:number;status:'pending'|'approved'|'rejected'}
export interface Weather {at:number;observedAt:number;temperature:number;condition:'clear'|'cloudy'|'fog'|'rain'|'snow'|'storm';isDay:boolean;wind:number;precipitation:number;provider:string;location:string;units:'celsius'|'fahrenheit'}
export interface Citation {title:string;url:string;start?:number;end?:number}
export interface AgentState {requestId:string;question:string;status:'idle'|'pending'|'completed'|'error';response:string;citations:Citation[];displayedQuestion:string;displayedResponse:string;displayedCitations:Citation[];origin:'manual'|'provider';error:string;page:number}
export interface ModuleState {
 id:string;definition:string;epoch:number;execution:'created'|'running'|'paused'|'stopped'|'disposed';pauseReasons:string[];mounted:boolean;published:boolean;view?:string;values:Record<string,Scalar>;
 round:number;admission:'closed'|'open';revealed:boolean;counts:Record<string,number>;total:number;submissions:Submission[];featured:string|null;weather:Weather|null;dataStatus:'empty'|'fresh'|'stale'|'error';error:string;agent:AgentState;
}
export interface Snapshot {revision:number;setEpoch:number;modules:Record<string,ModuleState>}
interface Secret {ballots:Map<string,string>;submissions:Map<string,string>}
const own=(o:object,k:string)=>Object.prototype.hasOwnProperty.call(o,k);
const freeze=<T>(v:T):T=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const scalarInput=(input:unknown):Record<string,Scalar>=>{
 if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw Error('Invalid input');
 if(JSON.stringify(input).length>64000)throw Error('Input byte budget exceeded');
 if(Object.keys(input).length>32)throw Error('Input budget exceeded');for(const[k,v]of Object.entries(input)){if(!key(k)||!['string','number','boolean'].includes(typeof v)||typeof v==='string'&&v.length>16000||typeof v==='number'&&!Number.isFinite(v))throw Error('Invalid input field');}return input as Record<string,Scalar>;
};
/** Synchronous commit authority shared by server execution and isolated rehearsal.
 * No module may call network/device APIs here. Adapters deliver checked results. */
export class SetRuntime {
 readonly definition:RuntimeDefinition;
 readonly domain:'live'|'rehearsal';
 private state:Snapshot;
 private secrets=new Map<string,Secret>();
 private listeners=new Set<()=>void>();
 private dedupe=new Map<string,{body:string;result:Result}>();
 private trace:Array<{id:string;module:string;op:string;result:Result}>=[];
 constructor(definition:unknown,options:{epoch:number;domain:'live'|'rehearsal';capabilities:readonly string[]}){
  this.definition=freeze(parseRuntimeDefinition(definition));this.domain=options.domain;
  if(!Number.isSafeInteger(options.epoch)||options.epoch<1)throw Error('Invalid set epoch');
  for(const d of Object.values(this.definition.definitions))for(const c of d.capabilities)if(!options.capabilities.includes(c))throw Error('Required capability unavailable: '+c);
  this.state=freeze({revision:0,setEpoch:options.epoch,modules:Object.fromEntries(this.definition.instances.map(i=>[i.id,this.initial(i,1)]))});
 }
 private initial(instance:ModuleInstanceDefinition,epoch:number):ModuleState{
  const d=this.definition.definitions[instance.definition],b=d.behavior;this.secrets.set(instance.id,{ballots:new Map(),submissions:new Map()});
  return {id:instance.id,definition:instance.definition,epoch,execution:'created',pauseReasons:[],mounted:false,published:false,view:d.initialView,values:{...Object.fromEntries(Object.entries(d.state).map(([k,f])=>[k,f.default])),...instance.initialState},round:1,admission:'closed',revealed:false,counts:Object.fromEntries(b?.type==='vote'?b.options.map(o=>[o.id,0]):[]),total:0,submissions:[],featured:null,weather:null,dataStatus:'empty',error:'',agent:{requestId:'',question:'',status:'idle',response:'',citations:[],displayedQuestion:'',displayedResponse:'',displayedCitations:[],origin:'manual',error:'',page:0}};
 }
 snapshot=()=>this.state;
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 activity=()=>structuredClone(this.trace);
 operator=()=>structuredClone(this.state);
 public=()=>({revision:this.state.revision,setEpoch:this.state.setEpoch,modules:Object.values(this.state.modules).filter(m=>m.published&&m.execution!=='disposed').map(m=>this.publicModule(m))});
 publicModule(m:ModuleState){
  const d=this.definition.definitions[m.definition],b=d.behavior;
  return {id:m.id,epoch:m.epoch,round:m.round,label:d.label,execution:m.execution,admission:m.admission,view:m.view,values:Object.fromEntries((d.publicFields??[]).map(k=>[k,m.values[k]])),controls:d.controls.filter(g=>g.audience==='audience'),
   ...(b?.type==='vote'?{vote:{question:b.question,options:b.options,allowChange:b.allowChange,results:m.revealed?{counts:m.counts,total:m.total}:null}}:{}),
   ...(b?.type==='submissions'?{text:{prompt:b.prompt,maxLength:b.maxLength,featured:m.submissions.find(s=>s.id===m.featured&&s.status==='approved')??null}}:{}),
   ...(b?.type==='agent'?{agent:{question:m.agent.displayedQuestion,response:m.agent.displayedResponse,citations:m.agent.displayedCitations}}:{}),
   ...(b?.type==='weather'?{weather:m.weather,dataStatus:m.dataStatus}:{}),
  };
 }
 dispatch(command:Command,principal:Principal,now:number):Result{
  let result:Result;let cacheKey='';let body='';
  try{
   if(!command||!key(command.module)||!command.id||command.id.length>160||!Number.isFinite(now)||now<0)throw Error('Invalid command');
   if(!principal||!principal.id||principal.id.length>160||!['operator','show','audience','connector'].includes(principal.role)||!principal.modules.includes(command.module))throw Error('Forbidden');
   if(principal.actions&&!principal.actions.includes(command.op))throw Error('Action not granted');
   body=JSON.stringify(command);cacheKey=JSON.stringify([principal.role,principal.id,command.setEpoch,command.module,command.epoch,command.id]);const previous=this.dedupe.get(cacheKey);if(previous){if(previous.body!==body)throw Error('Command identity reused');return structuredClone(previous.result);}
   if(command.setEpoch!==this.state.setEpoch)throw Error('Set epoch expired');
   const source=this.state.modules[command.module];if(!source||command.epoch!==source.epoch)throw Error('Module epoch expired');
   if(command.expectedRevision!==undefined&&command.expectedRevision!==this.state.revision)throw Error('State revision conflict');
   if(source.execution==='disposed')throw Error('Module disposed');
   const input=scalarInput(command.input??{}),next=structuredClone(source),definition=this.definition.definitions[source.definition];
   const secret=this.secrets.get(source.id)!;const staged={ballots:new Map(secret.ballots),submissions:new Map(secret.submissions)};
   this.apply(next,definition,command.op,input,principal,staged,now,command.id);
   if(this.state.revision>=Number.MAX_SAFE_INTEGER)throw Error('Revision limit reached');
   this.state=freeze({...this.state,revision:this.state.revision+1,modules:{...this.state.modules,[source.id]:next}});this.secrets.set(source.id,staged);
   result={status:'committed',revision:this.state.revision,moduleEpoch:next.epoch};
  }catch(error){result={status:'rejected',revision:this.state.revision,error:error instanceof Error?error.message:'Command failed'};}
  if(cacheKey){this.dedupe.set(cacheKey,{body,result});if(this.dedupe.size>2048)this.dedupe.delete(this.dedupe.keys().next().value!);}
  this.trace=[...this.trace.slice(-127),{id:command?.id??'',module:command?.module??'',op:command?.op??'',result}];
  if(result.status==='committed')for(const fn of this.listeners){try{fn();}catch{/* Observers cannot roll back a committed transaction. */}}return structuredClone(result);
 }
 private apply(m:ModuleState,d:ModuleDefinition,op:string,input:Record<string,Scalar>,p:Principal,secret:Secret,now:number,commandId:string){
  const operator=()=>{if(p.role!=='operator'&&p.role!=='show')throw Error('Operator authority required');};
  if(op==='reset'){operator();const i=this.definition.instances.find(i=>i.id===m.id)!;const fresh=this.initialValues(i,m.epoch+1);Object.assign(m,fresh);secret.ballots.clear();secret.submissions.clear();return;}
  if(op==='start'||op==='resume'){operator();const reason=String(input.reason??'operator');m.pauseReasons=m.pauseReasons.filter(r=>r!==reason);m.execution=m.pauseReasons.length?'paused':'running';return;}
  if(op==='pause'){operator();const reason=String(input.reason??'operator');if(reason.length>80||m.pauseReasons.length>=16)throw Error('Pause reason budget exceeded');m.pauseReasons=[...new Set([...m.pauseReasons,reason])];m.execution='paused';return;}
  if(op==='stop'||op==='dispose'){operator();m.epoch++;if(m.agent.status==='pending'){m.agent.status='error';m.agent.error='Request cancelled';}m.execution=op==='stop'?'stopped':'disposed';m.admission='closed';m.published=false;if(op==='dispose'){m.mounted=false;secret.ballots.clear();secret.submissions.clear();}return;}
  if(op==='mount'||op==='unmount'){operator();m.mounted=op==='mount';const i=this.definition.instances.find(i=>i.id===m.id)!;if(i.hidden==='pause'){m.pauseReasons=m.pauseReasons.filter(r=>r!=='visibility');if(!m.mounted)m.pauseReasons.push('visibility');if(m.execution==='running'&&!m.mounted)m.execution='paused';else if(m.execution==='paused'&&!m.pauseReasons.length)m.execution='running';}return;}
  if(op==='publish'||op==='withdraw'){operator();if(op==='publish'&&m.execution!=='running')throw Error('Start the module before publishing');m.published=op==='publish';if(!m.published)m.admission='closed';return;}
  if(op==='field'){if(p.role!=='operator')throw Error('Operator authority required');const field=String(input.field??'');if(!own(d.state,field))throw Error('Unknown local field');m.values[field]=fieldValue(d.state[field],input.value);return;}
  if(op.startsWith('agent.')){
   if(d.behavior?.type!=='agent')throw Error('Agent capability required');
   if(op==='agent.complete'||op==='agent.error'){
    if(p.role!=='connector'||m.agent.status!=='pending'||input.requestId!==m.agent.requestId)throw Error('Agent request expired or forbidden');
    if(op==='agent.error'){m.agent.status='error';m.agent.error=String(input.message??'Agent request failed').slice(0,240);return;}
   }else operator();
   if(op==='agent.ask'){
    if(m.execution!=='running'||typeof input.question!=='string'||!input.question.trim()||input.question.length>1000)throw Error('Start module and enter a question');
    m.agent={...m.agent,requestId:commandId,question:input.question.trim(),status:'pending',response:'',citations:[],origin:'provider',error:''};return;
   }
   if(op==='agent.complete'||op==='agent.embed'){
    if(typeof input.response!=='string'||!input.response.trim()||input.response.length>d.behavior.maxLength)throw Error('Invalid agent response');
    let citations:Citation[]=[];
    if(input.citations!==undefined){const raw=JSON.parse(String(input.citations));if(!Array.isArray(raw)||raw.length>20)throw Error('Invalid citations');citations=raw.map(c=>{if(!c||typeof c!=='object'||Object.keys(c).some(k=>!['title','url','start','end'].includes(k))||typeof c.title!=='string'||c.title.length>160||typeof c.url!=='string'||c.url.length>2000)throw Error('Invalid citation');const url=new URL(c.url);if(url.protocol!=='https:'||url.username||url.password)throw Error('Citation must use HTTPS');if(c.start!==undefined||c.end!==undefined){if(!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<0||c.end<=c.start||c.end>String(input.response).length)throw Error('Invalid citation position');return {title:c.title,url:url.href,start:c.start,end:c.end};}return {title:c.title,url:url.href};});}
    m.agent={...m.agent,status:'completed',response:input.response.trim(),citations,error:'',...(op==='agent.embed'?{question:String(input.question??m.agent.question).slice(0,1000),origin:'manual' as const,requestId:''}:{})};return;
   }
   if(op==='agent.page'){const page=input.page;if(typeof page!=='number'||!Number.isInteger(page)||page<0||page>=answerPages(m.agent.displayedResponse).length)throw Error('Invalid answer page');m.agent.page=page;return;}
   if(op==='agent.show'){m.agent.page=0;if(m.agent.status!=='completed')throw Error('No completed response to show');m.agent.displayedQuestion=m.agent.question;m.agent.displayedResponse=m.agent.response;m.agent.displayedCitations=structuredClone(m.agent.citations);return;}
   if(op==='agent.clear'){m.agent.displayedQuestion='';m.agent.displayedResponse='';m.agent.displayedCitations=[];return;}
   throw Error('Unknown agent action');
  }
  if(op==='weather.update'||op==='weather.error'){
   if(p.role!=='connector'||d.behavior?.type!=='weather')throw Error('Weather connector authority required');
   if(op==='weather.error'){m.dataStatus=m.weather?'stale':'error';m.error=String(input.message??'Weather unavailable').slice(0,240);return;}
   const finite=(k:string,min:number,max:number)=>{const v=input[k];if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error('Invalid weather '+k);return v;};
   if(typeof input.isDay!=='boolean'||!['clear','cloudy','fog','rain','snow','storm'].includes(String(input.condition)))throw Error('Invalid weather condition');
   const observedAt=finite('observedAt',0,now+300000);if(m.weather&&observedAt<m.weather.observedAt)throw Error('Stale weather observation');
   m.weather={at:now,observedAt,temperature:finite('temperature',-150,180),condition:input.condition as Weather['condition'],isDay:input.isDay,wind:finite('wind',0,500),precipitation:finite('precipitation',0,1000),provider:String(input.provider??'').slice(0,80),location:String(input.location??'').slice(0,120),units:input.units==='fahrenheit'?'fahrenheit':'celsius'};m.dataStatus='fresh';m.error='';return;
  }
  if(m.execution!=='running')throw Error('Module is not running');
  const b=d.behavior;
  if(p.role==='audience'&&(!m.published||m.admission!=='open'||input.round!==m.round))throw Error('Audience round is closed or expired');
  if(op==='open'||op==='close'||op==='reveal'||op==='round.new'){
   operator();if(!b||!['vote','submissions'].includes(b.type))throw Error('Module has no audience intake');
   if(op==='round.new'){m.round++;m.admission='closed';m.revealed=false;m.total=0;Object.keys(m.counts).forEach(k=>m.counts[k]=0);m.submissions=[];m.featured=null;secret.ballots.clear();secret.submissions.clear();return;}
   if(op==='open'){if(!m.published)throw Error('Publish audience controls before opening');if(m.revealed)throw Error('Start a new round before opening');m.admission='open';}
   else if(op==='close')m.admission='closed';else{if(m.admission!=='closed')throw Error('Close intake before reveal');m.revealed=true;}return;
  }
  if(op==='vote'||op==='submit'){
   if(p.role!=='audience'||!m.published||m.admission!=='open'||input.round!==m.round)throw Error('Audience round is closed or expired');
   if(op==='vote'){
    if(b?.type!=='vote'||typeof input.choice!=='string'||!own(m.counts,input.choice))throw Error('Invalid ballot');
    const previous=secret.ballots.get(p.id);if(previous&&!b.allowChange)throw Error('Already voted');if(!previous&&secret.ballots.size>=b.maxParticipants)throw Error('Participant capacity reached');
    if(previous)m.counts[previous]--;else m.total++;m.counts[input.choice]++;secret.ballots.set(p.id,input.choice);return;
   }
   if(b?.type!=='submissions'||typeof input.text!=='string'||!input.text.trim()||input.text.length>b.maxLength||m.submissions.length>=b.capacity)throw Error('Submission invalid or capacity reached');
   if(secret.submissions.has(p.id))throw Error('Already submitted in this round');
   const name=typeof input.name==='string'?input.name.trim().slice(0,80):'Audience';const id='item-'+(m.submissions.length+1)+'-r'+m.round;
   m.submissions.push({id,name:name||'Audience',text:input.text.trim(),at:now,status:'pending'});secret.submissions.set(p.id,id);return;
  }
  if(['approve','reject','feature','unfeature'].includes(op)){
   operator();if(b?.type!=='submissions')throw Error('No submission queue');if(op==='unfeature'){m.featured=null;return;}
   const item=m.submissions.find(i=>i.id===input.item);if(!item)throw Error('Unknown submission');if(op==='feature'){if(item.status!=='approved')throw Error('Approve before featuring');m.featured=item.id;}else{item.status=op==='approve'?'approved':'rejected';if(item.status==='rejected'&&m.featured===item.id)m.featured=null;}return;
  }
  const action=d.actions[op];if(!action||!action.roles.includes(p.role))throw Error('Unknown or forbidden action');
  if(action.when!==undefined&&evaluate(action.when,m.values,input,{})!==true)throw Error('Action precondition failed');
  for(const step of action.steps){if(step.op==='view'){m.view=step.view;continue;}const value=evaluate(step.value,m.values,input,{});const next=step.op==='add'?Number(m.values[step.field])+Number(value):value;if(step.op==='add'&&(typeof value!=='number'||typeof m.values[step.field]!=='number'))throw Error('Add requires numbers');m.values[step.field]=fieldValue(d.state[step.field],next);}
 }
 private initialValues(instance:ModuleInstanceDefinition,epoch:number){
  // Build without mutating the authoritative private map before commit.
  const old=this.secrets.get(instance.id);const fresh=this.initial(instance,epoch);if(old)this.secrets.set(instance.id,old);return fresh;
 }
}
