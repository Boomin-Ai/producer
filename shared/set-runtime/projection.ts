import type {ModuleDefinition,RuntimeDefinition,Scalar} from './contract';
import type {ModuleState,Snapshot} from './runtime';
export function answerPages(text:string,limit=800){
 const result:string[]=[];let remaining=text;
 while(remaining.length>limit){let end=remaining.lastIndexOf('\n',limit);if(end<limit*.5)end=remaining.lastIndexOf(' ',limit);if(end<limit*.5)end=limit;result.push(remaining.slice(0,end));remaining=remaining.slice(end).trimStart();}
 if(remaining||!result.length)result.push(remaining);return result;
}
export function outputTypes(d:ModuleDefinition):Record<string,'text'|'number'|'boolean'>{
 const types:Record<string,'text'|'number'|'boolean'>=Object.fromEntries((d.publicFields??[]).map(k=>[k,d.state[k].type]));
 Object.assign(types,{label:'text',view:'text',accepting:'boolean',revealed:'boolean',round:'number'});
 const b=d.behavior;
 if(b?.type==='vote'){Object.assign(types,{question:'text',total:'number',winner:'text'});for(let i=0;i<b.options.length;i++)for(const [suffix,type]of [['Label','text'],['Count','number'],['Percent','number'],['Width','text']] as const)types['choice'+(i+1)+suffix]=type;}
 if(b?.type==='submissions')Object.assign(types,{prompt:'text',featuredText:'text',featuredName:'text'});
 if(b?.type==='weather')Object.assign(types,{temperature:'number',temperatureLabel:'text',condition:'text',isDay:'boolean',location:'text',wind:'number',precipitation:'number',dataStatus:'text'});
 if(b?.type==='agent')Object.assign(types,{question:'text',answer:'text',sources:'text',page:'number',pages:'number',hasAnswer:'boolean'});
 return types;
}
/** Public/render projection: never exposes unrevealed counts or pending content. */
export function moduleFields(m:ModuleState,d:ModuleDefinition):Record<string,Scalar>{
 const fields:Record<string,Scalar>={...Object.fromEntries((d.publicFields??[]).map(k=>[k,m.values[k]])),label:d.label,view:m.view??'',accepting:m.execution==='running'&&m.published&&m.admission==='open',revealed:m.revealed,round:m.round};const b=d.behavior;
 if(b?.type==='vote'){
  Object.assign(fields,{question:b.question,total:m.revealed?m.total:0,winner:''});
  let highest=0,leaders:string[]=[];for(const o of b.options){const count=m.counts[o.id];if(count>highest){highest=count;leaders=[o.label];}else if(count===highest&&count>0)leaders.push(o.label);}
  if(m.revealed&&m.total)fields.winner=leaders.length===1?leaders[0]:'Draw';
  b.options.forEach((o,i)=>{const pct=m.revealed&&m.total?100*m.counts[o.id]/m.total:0;fields['choice'+(i+1)+'Label']=o.label;fields['choice'+(i+1)+'Count']=m.revealed?m.counts[o.id]:0;fields['choice'+(i+1)+'Percent']=Math.round(pct);fields['choice'+(i+1)+'Width']=pct+'%';});
 }
 if(b?.type==='submissions'){const item=m.submissions.find(s=>s.id===m.featured&&s.status==='approved');Object.assign(fields,{prompt:b.prompt,featuredText:item?.text??'',featuredName:item?.name??''});}
 if(b?.type==='weather'){const w=m.weather;Object.assign(fields,{temperature:w?.temperature??0,temperatureLabel:w?`${Math.round(w.temperature)}°${w.units==='fahrenheit'?'F':'C'}`:'—',condition:w?.condition??'clear',isDay:w?.isDay??true,location:w?.location??'',wind:w?.wind??0,precipitation:w?.precipitation??0,dataStatus:m.dataStatus});}
 if(b?.type==='agent'){const pages=answerPages(m.agent.displayedResponse),page=Math.max(0,Math.min(pages.length-1,m.agent.page));Object.assign(fields,{question:m.agent.displayedQuestion,answer:pages[page],sources:m.agent.displayedCitations.map(c=>c.title).slice(0,4).join(' · ').slice(0,500),page:page+1,pages:pages.length,hasAnswer:!!m.agent.displayedResponse});}
 return fields;
}
export function runtimeFields(snapshot:Snapshot,definition:RuntimeDefinition){return Object.fromEntries(Object.values(snapshot.modules).filter(m=>m.execution!=='disposed').map(m=>[m.id,moduleFields(m,definition.definitions[m.definition])]));}
