import type {ModuleDefinition,ModuleInstanceDefinition} from './contract';
export type ModuleKind='vote'|'submissions'|'agent'|'weather';
export function moduleTemplate(type:ModuleKind):ModuleDefinition{
 const common={state:{},actions:{},controls:[],publicFields:[]};
 switch(type){
  case 'vote':return {...common,label:'Audience vote',capabilities:['audience.vote@1'],behavior:{type,question:'What do you think?',options:[{id:'yes',label:'Yes'},{id:'no',label:'No'}],maxParticipants:10000,allowChange:false}};
  case 'submissions':return {...common,label:'Audience questions',capabilities:['audience.text@1'],behavior:{type,prompt:'Ask the panel a question',maxLength:500,capacity:500}};
  case 'agent':return {...common,label:'Research desk',capabilities:['data.agent@1'],behavior:{type,integrationRole:'research',prompt:'Assess the question using reliable evidence. Distinguish established facts from uncertainty. Cite the original sources.',mode:'factCheck',maxLength:16000}};
  case 'weather':return {...common,label:'Live weather',capabilities:['data.weather@1'],behavior:{type,integrationRole:'weather'}};
 }
}
export const moduleInstance=(id:string,definition:string,segment?:string):ModuleInstanceDefinition=>({id,definition,owner:segment?'segment':'set',...(segment?{segment}:{}),hidden:'continue',onExit:segment?'pause':'continue',reenter:'resume'});
