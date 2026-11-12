import type {AssistantSuggestion} from './suggestions';
import type {ResponseItem} from './provider';

export type ConversationMessage={id?:string;role:'user'|'assistant'|'tool';text:string};
export const conversationSuggestionTool={type:'namespace',name:'producer_assistant',description:'Suggested user replies for this conversation. UI metadata only; no Set, device or output authority.',tools:[{
  type:'function',name:'suggest_replies',strict:false,
  description:'Suggest three short, specific next user replies based on the latest conversation. Use actual creative options, unanswered questions or relevant design refinements. This only populates editable prompts; it executes nothing. Call alongside your final answer, not in a separate task.',
  parameters:{type:'object',additionalProperties:false,required:['suggestions'],properties:{suggestions:{type:'array',minItems:1,maxItems:3,items:{type:'object',additionalProperties:false,required:['label','prompt'],properties:{label:{type:'string',minLength:1,maxLength:40},prompt:{type:'string',minLength:1,maxLength:600}}}}}},
}]};
export const conversationSuggestionInstructions=[
  'When your answer is ready, call producer_assistant.suggest_replies at most once per user message with three relevant, brief next user replies. Include your normal user-facing answer in the same response when possible. If the tool is acknowledged before you have answered, send the answer next without calling it again. The tool is invisible UI metadata, not part of the answer text.',
  'Suggestions must follow the latest exchange, not generic Continue/Next step buttons. If you offered creative directions, make those directions selectable. If you asked a question, offer meaningful answers or ways to explore it. After an edit, suggest useful refinements of what changed.',
  'Respect planning-only/no-edits instructions in the suggested prompts. Do not offer to control live output, recording, devices or integrations outside your current tools. Never invent personal preferences. Never inspect a Set merely to generate suggestions. Suggestions do not authorize edits; the user must send the selected prompt.',
].join('\n');

export function isSuggestionCall(call:ResponseItem):boolean {
  return call.type==='function_call'&&(call.namespace==='producer_assistant'&&call.name==='suggest_replies'||!call.namespace&&(call.name==='producer_assistant.suggest_replies'||call.name==='suggest_replies'));
}
export function parseSuggestedReplies(args:unknown):AssistantSuggestion[] {
  if(typeof args!=='string'||args.length>8192)throw Error('Suggested replies must be a small JSON object.');
  const value=JSON.parse(args);
  if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(key=>key!=='suggestions')||!Array.isArray(value.suggestions)||!value.suggestions.length||value.suggestions.length>3)throw Error('Provide one to three suggested replies.');
  const seen=new Set<string>();
  return value.suggestions.map((item:unknown,index:number)=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(key=>!['label','prompt'].includes(key)))throw Error('Suggested replies contain only label and prompt.');
    const {label,prompt}=item as {label:unknown;prompt:unknown};
    if(typeof label!=='string'||!label.trim()||label.trim().length>40||/[\u0000-\u001f<>]/.test(label)||typeof prompt!=='string'||!prompt.trim()||prompt.trim().length>600||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prompt))throw Error('Suggested reply text is invalid or too long.');
    const key=label.trim().toLocaleLowerCase();if(seen.has(key))throw Error('Suggested replies must be distinct.');seen.add(key);
    return {id:'reply-'+index,label:label.trim(),prompt:prompt.trim()};
  });
}

function plain(text:string){return text.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*_`]/g,'').replace(/\s+/g,' ').trim();}
function chipLabel(text:string){const label=plain(text);return label.length<=40?label:label.slice(0,37).replace(/\s+\S*$/,'')+'…';}

/** Local fallback for existing conversations and providers that omit metadata.
 * Reads only the current exchange; no background inference or room inspection. */
export function conversationSuggestions(messages:readonly ConversationMessage[],replies:readonly AssistantSuggestion[]|undefined,canReview:boolean):AssistantSuggestion[] {
  let start=messages.length-1;while(start>=0&&messages[start].role!=='user')--start;
  const exchange=messages.slice(Math.max(0,start));
  const reply=[...exchange].reverse().find(message=>message.role==='assistant'&&message.text.trim())?.text.slice(0,16000)??'';
  const choices:string[]=[];
  const lines=reply.split('\n');
  // A Markdown table often holds the creative directions themselves.
  for(let index=0;index<lines.length-1;index++){
    if(!/^\s*\|?\s*:?-{3}/.test(lines[index+1]))continue;
    for(let row=index+2;row<lines.length&&lines[row].includes('|');row++){
      const first=lines[row].trim().replace(/^\|/,'').split('|')[0].trim();if(first)choices.push(plain(first));
    }
    if(choices.length)break;
  }
  if(!choices.length)for(const line of lines){
    const entry=/^\s*(?:[-*]|\d+[.)])\s+(.+)/.exec(line)?.[1];if(!entry)continue;
    const label=/^\*\*([^*]+)\*\*/.exec(entry)?.[1]??entry.split(/\s+[—–]\s+|:\s/)[0];
    if(plain(label).length>2)choices.push(plain(label));
    if(choices.length===3)break;
  }
  const result:AssistantSuggestion[]=[];
  const add=(item:AssistantSuggestion)=>{if(!result.some(existing=>existing.label.toLocaleLowerCase()===item.label.toLocaleLowerCase()))result.push(item);};
  const editedNow=canReview&&exchange.some(message=>message.role==='tool'&&message.text==='Draft updated and validated.');
  if(editedNow)add({id:'review',label:'Review changes',action:'review'});
  for(const item of replies??[])add(item);
  for(const choice of choices)add({id:'choice-'+result.length,label:chipLabel(choice),prompt:`Let's explore “${choice.slice(0,220)}” for the Set we're discussing. Describe the look and experience first; make no edits yet.`});
  const question=lines.slice().reverse().find(line=>line.trim().endsWith('?'));
  if(question&&result.length<3)add({id:'answer-question',label:chipLabel(question),prompt:`Help me decide: ${plain(question).slice(0,350)} Explore a few options before making any Set edits.`});
  const topic=plain(exchange.find(message=>message.role==='user')?.text??'this Set').slice(0,180);
  const fallback:AssistantSuggestion[]=[
    {id:'visual-direction',label:'Develop the look',prompt:`For what we are discussing (“${topic}”), help me choose a coherent visual direction. Keep this in planning; no Set edits yet.`},
    {id:'layout-plan',label:'Plan the layouts',prompt:`Based on this conversation, sketch the key layouts and how the camera and content would fit. Keep it simple and describe the plan before editing.`},
    {id:'control-plan',label:'Shape the live controls',prompt:'Based on the Set idea we are discussing, propose the few live controls I would actually need. Explain what each does; make no edits yet.'},
  ];
  for(const item of fallback)add(item);
  return result.slice(0,3);
}
