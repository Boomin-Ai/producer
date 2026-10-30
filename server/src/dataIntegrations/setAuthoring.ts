import {parsePackageText,PackageValidationError} from '../../../src/features/presentation/validation';
import type {PresentationPackage} from '../../../src/features/presentation/schema';
import {ProviderError,type Connection} from './providers';

export const AUTHORING_PROMPT_LIMIT=4000;
export const AUTHORING_BASE_BYTES=64*1024;
const RESPONSE_BYTES=256*1024;
export interface SetAuthoringInput {prompt:string;package?:PresentationPackage}
export interface SetAuthoringResult {package:PresentationPackage;provider:'anthropic';model:string}
const example={schema:'producer.presentation/2',id:'studio-cover',version:'1.0.0',name:'Studio cover',set:{initialLayout:'main',values:{title:{type:'text',default:'ON AIR',maxLength:80}},feeds:{},slots:[{id:'host',label:'Host camera'}],components:{},layouts:[{id:'main',label:'Main',width:1920,height:1080,root:{id:'root',type:'box',styles:{position:'relative',width:1920,height:1080,background:'#0b1220'},children:[{id:'camera',type:'slot',slotId:'host',styles:{position:'absolute',left:80,top:160,width:1760,height:840},framing:{mode:'fill',x:0.5,y:0.5}},{id:'title',type:'text',text:{get:'values.title'},styles:{position:'absolute',left:80,top:40,width:1760,height:100,fontSize:64,color:'#ffffff'}}]}}],controls:[{id:'title',type:'text',label:'Title',key:'title'}],controlArrangement:{sections:[{id:'content',label:'Content',controls:['set:title']}],minimized:[]}}};
// A small valid example and concise contract avoid sending the 90 KB full schema
// on every paid request. The canonical validator remains the admission authority.
const system=`You author Producer Set draft packages. Return exactly one complete JSON object, without Markdown, commentary or tool calls. Do not research, fetch URLs, include credentials, generate embedded assets or invent API connections. The output is a draft for human preview; never claim it is installed or live. Fit the entire package within the output token budget: use concise JSON and at most two layouts.
Contract: schema is producer.presentation/2; id and all stable IDs start with a letter and use letters, digits, underscore or hyphen (max64). Include id, version, name and set. set requires initialLayout, values, feeds, slots, components, layouts, controls. A layout has id,label,width,height,root. Core nodes are box (children), text (text), slot (slotId); all have id,type,styles. Exact node keys: box={id,type,styles,children}; text={id,type,styles,text}; slot={id,type,styles,slotId,framing?,appearance?}. Only box has children; never attach children to text or slot. Do not invent keys such as content, name, label, style, x or y on nodes. Position goes inside styles.left/top. Each box requires children, including an empty array. Use only declared slots. Text can be literal or {"get":"values.key"}. Values are typed {type:"text",default:string,maxLength:1..160}, {type:"number",default:number,min:number,max:number}, or {type:"boolean",default:boolean}. Controls are text/number {id,type,label,key} or button {id,type:"button",label,action:{type:"layout.select",layoutId}}. Layout dimensions are 16:9 1920x1080 or 9:16 1080x1920. Styles support bounded numeric geometry, colors, background, border, borderRadius, fontSize,fontWeight,textAlign,padding,position,overflow,opacity; no URLs or JavaScript. This authoring profile supports core box/text/slot nodes and the trusted voiceBars and voiceRing shaders only. voiceBars is a level-reactive visualization of the existing room microphone bus, not a PCM waveform or frequency spectrum; it never starts a microphone. Browser previews use simulated microphone levels. Exact voice layer: {"id":"voice","type":"shader","styles":{"position":"absolute","left":80,"top":860,"width":1760,"height":120},"shader":{"effect":"voiceBars","colors":["#142b3d","#62e5d5","#c5b2ff"],"speed":1,"intensity":1,"scale":1,"opacity":1,"radius":16,"quality":"low","clock":"show"}}. voiceRing wraps radial bars around a circular camera; use a square shader layer centered on the camera with radius equal to half the camera width and at least 90px padding outside it. Its interior is transparent. Use a square camera slot with appearance:{"shape":"circle"}; the ring radius is half that slot width. Shader bounds: speed0..4, intensity0..2 controls sensitivity, scale0.25..4 controls bar density, opacity0..1, radius0..960, quality low/medium, clock show/segment. Place at most four shaders directly beneath layout.root in its children; root styles must be only position:"relative", numeric width/height matching layout, optional background and overflow. Shader styles must be only numeric absolute left/top/width/height and fit within canvas. No custom audioLevel, input selection, microphone activation, scripts or shader code. Other shader presets, live data integrations, modules, Shows, charts,3D, media assets and reusable components are outside this authoring profile. Optional set.controlArrangement has sections [{id,label,controls:["set:control-id"],collapsed?:boolean}] and minimized ["set:control-id"]; minimized contains only deliberate quick controls. Each control reference must exist. No show is needed for a standalone Set. Preserve base semantics when revising it. If the request requires unsupported features, do not silently substitute a simpler design or invent live metrics/forecasts. Instead return exactly {\"error\":{\"code\":\"unsupported_request\",\"message\":\"Explain the unsupported requirement briefly\"}}. Never claim an unsupported capability was implemented.
Minimal valid example:
${JSON.stringify(example)}`;
const bytes=(value:string)=>new TextEncoder().encode(value).byteLength;
function packageDraft(text:string,source:'input'|'output'):PresentationPackage{
 if(bytes(text)>(source==='input'?AUTHORING_BASE_BYTES:RESPONSE_BYTES))throw new ProviderError(source==='input'?'invalid_request':'provider_response','Set draft exceeds the authoring size budget.');
 let doc:PresentationPackage;
 try{doc=parsePackageText(text);}catch(error){if(error instanceof PackageValidationError)throw new ProviderError(source==='input'?'invalid_request':'invalid_set_draft','Set draft validation failed: '+error.message.slice(0,800));throw error;}
 if(Object.keys(doc.set.assets??{}).length)throw new ProviderError(source==='input'?'invalid_request':'invalid_set_draft','Set authoring accepts asset-free drafts. Add media after reviewing the draft.');
 const core=(node:PresentationPackage['set']['layouts'][number]['root']):boolean=>(['box','text','slot'].includes(node.type)||node.type==='shader'&&['voiceBars','voiceRing'].includes(node.shader?.effect??''))&&(node.children??[]).every(core);
 if(doc.show||doc.runtime.instances.length||Object.keys(doc.runtime.definitions).length||doc.set.viewController||doc.set.views||Object.keys(doc.set.components).length||(doc.requires??[]).length||!doc.set.layouts.every(layout=>core(layout.root)))throw new ProviderError(source==='input'?'invalid_request':'invalid_set_draft','This authoring preview supports text, box, camera layouts and the voiceBars/voiceRing microphone-level presets only. Advanced Set features require a later authoring profile.');
 return doc;
}
export function parseSetAuthoringInput(value:unknown):SetAuthoringInput{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['prompt','package'].includes(key)))throw new ProviderError('invalid_request','Invalid Set authoring fields');
 const v=value as Record<string,unknown>;
 if(typeof v.prompt!=='string'||!v.prompt.trim()||v.prompt.length>AUTHORING_PROMPT_LIMIT)throw new ProviderError('invalid_request','Describe the Set in 1–4000 characters.');
 let base:PresentationPackage|undefined;
 if(v.package!==undefined){let raw:string;try{raw=JSON.stringify(v.package);}catch{throw new ProviderError('invalid_request','Base Set must be JSON.');}base=packageDraft(raw,'input');}
 return {prompt:v.prompt.trim(),...(base?{package:base}:{})};
}
async function readResponse(response:Response):Promise<Record<string,unknown>>{
 if(!response.ok){await response.body?.cancel();throw new ProviderError(response.status===401||response.status===403?'provider_auth':response.status===429?'provider_rate_limit':'provider_error','The saved Claude connection could not complete Set authoring.');}
 const reader=response.body?.getReader();if(!reader)throw new ProviderError('provider_response','Claude returned no response.');
 const chunks:Uint8Array[]=[];let length=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>RESPONSE_BYTES)throw new ProviderError('provider_response','Claude response exceeded the authoring size budget.');chunks.push(value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 const buffer=new Uint8Array(length);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
 let value:unknown;try{value=JSON.parse(new TextDecoder().decode(buffer));}catch{throw new ProviderError('provider_response','Claude returned invalid response JSON.');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ProviderError('provider_response','Claude returned an invalid response.');return value as Record<string,unknown>;
}
/** Provider-neutral draft boundary. Claude is the first explicitly supported
 * authoring transport; answer/research adapters are not reused as generators. */
export async function authorSet(connection:Connection,key:string,value:unknown,options:{signal?:AbortSignal;fetcher?:typeof fetch}={}):Promise<SetAuthoringResult>{
 const input=parseSetAuthoringInput(value);
 if(connection.kind!=='agent'||connection.provider!=='anthropic')throw new ProviderError('invalid_request','Select a saved Claude connection for Set authoring.');
 if(!key.trim())throw new ProviderError('provider_auth','The saved Claude connection has no API key.');
 if(!Number.isSafeInteger(connection.maxOutputTokens)||connection.maxOutputTokens<256||connection.maxOutputTokens>4096)throw new ProviderError('invalid_request','Invalid saved output token budget.');
 const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000);signal.throwIfAborted();
 let timer:ReturnType<typeof setTimeout>|undefined;
 const operation=async()=>readResponse(await (options.fetcher??fetch)('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','Content-Type':'application/json',...(connection.workspaceId?{'anthropic-workspace-id':connection.workspaceId}:{})},signal,redirect:'manual',body:JSON.stringify({model:connection.model,max_tokens:connection.maxOutputTokens,system,messages:[{role:'user',content:JSON.stringify(input)}]})}));
 let result:Record<string,unknown>;
 try{result=await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ProviderError('provider_timeout','Claude generation timed out. No automatic retry was started.')),90000);})]);}finally{if(timer!==undefined)clearTimeout(timer);}
 signal.throwIfAborted();
 if(result.stop_reason!=='end_turn')throw new ProviderError('provider_incomplete','Claude did not finish the Set draft. Try a simpler prompt or adjust the saved token budget; no automatic retry was made.');
 if(!Array.isArray(result.content)||!result.content.length||result.content.length>8||result.content.some(block=>!block||typeof block!=='object'||block.type!=='text'||typeof block.text!=='string'))throw new ProviderError('provider_response','Claude returned unsupported authoring content.');
 const text=result.content.map(block=>block.text).join('');
 // A refusal is not a degraded success or a request for an automatic repair.
 let refusal:unknown;try{refusal=JSON.parse(text);}catch{/* Canonical text validation below reports malformed JSON. */}
 if(refusal&&typeof refusal==='object'&&!Array.isArray(refusal)&&'error'in refusal){const error=(refusal as {error?:unknown}).error;if(error&&typeof error==='object'&&'code'in error&&error.code==='unsupported_request')throw new ProviderError('unsupported_request','The requested Set needs features outside this layout and voiceBars authoring preview. No draft was applied and no automatic retry was made.');}
 return {package:packageDraft(text,'output'),provider:'anthropic',model:connection.model};
}
