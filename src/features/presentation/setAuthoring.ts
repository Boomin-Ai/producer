import {parsePackageText} from './validation';
import type {PresentationPackage} from './schema';

export interface AuthoringInput {connectionId:string;expectedRevision:number;prompt:string;package?:PresentationPackage;requireShow?:boolean}
export interface AuthoringReply {connectionId:string;connectionRevision:number;package:unknown;provider:'anthropic';model:string}
export type AuthoringCall=(input:Omit<AuthoringInput,'requireShow'>)=>Promise<AuthoringReply>;
export interface AuthoringState {status:'idle'|'generating'|'ready'|'error';text:string;package?:PresentationPackage;error:string;model?:string}
/** An isolated candidate workflow. It has no room, output, install or apply capability. */
export class SetAuthoringDraft {
 private state:AuthoringState={status:'idle',text:'',error:''};
 private generation=0;
 private listeners=new Set<()=>void>();
 constructor(private call:AuthoringCall,private timeoutMs=105000){}
 snapshot=()=>this.state;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private update(next:AuthoringState){this.state=next;for(const listener of this.listeners)listener();}
 cancel=()=>{this.generation++;this.update({status:'idle',text:'',error:''});};
 editCandidate=(text:string)=>{this.generation++;this.update({status:'idle',text,error:''});};
 validate=(requireShow=false)=>{try{const doc=parsePackageText(this.state.text);if(requireShow&&!doc.show)throw Error('This draft has no Show. Request a segment sequence and generate again.');this.update({...this.state,status:'ready',package:doc,error:''});}catch(error){this.update({...this.state,status:'error',package:undefined,error:error instanceof Error?error.message:'The draft did not pass validation.'});}};
 generate=async(input:AuthoringInput)=>{
  const ticket=++this.generation;this.update({status:'generating',text:'',error:''});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const {requireShow,...request}=input,reply=await Promise.race([this.call(request),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Generation timed out. The provider may still finish the request. No retry was started.')),this.timeoutMs);})]);
   if(ticket!==this.generation)return;
   if(reply.connectionId!==input.connectionId||reply.connectionRevision!==input.expectedRevision||reply.provider!=='anthropic')throw Error('The saved connection changed. Select it again and retry.');
   const text=JSON.stringify(reply.package);if(typeof text!=='string')throw Error('The provider did not return a Set package.');
   const doc=parsePackageText(text);
   if(requireShow&&!doc.show)throw Error('This draft has no Show. Request a segment sequence and generate again.');
   this.update({status:'ready',text:JSON.stringify(doc,null,2),package:doc,error:'',model:reply.model});
  }catch(error){if(ticket===this.generation)this.update({status:'error',text:'',error:error instanceof Error?error.message:typeof error==='string'&&error.trim()?error:typeof error==='object'&&error!==null&&'message'in error&&typeof error.message==='string'?error.message:'The Set draft could not be generated.'});}
  finally{clearTimeout(timer);}
 };
}

export function authoringBaseIssue(doc:PresentationPackage):string|undefined {
 const unsupported=(node:PresentationPackage['set']['layouts'][number]['root']):boolean=>!(['box','text','slot'].includes(node.type)||node.type==='shader'&&['voiceBars','voiceRing'].includes(node.shader?.effect??''))||!!node.children?.some(unsupported);
 if(doc.show||doc.runtime.instances.length||Object.keys(doc.set.components).length||doc.set.layouts.some(layout=>unsupported(layout.root)))return 'This Set uses features beyond the text/camera and voiceBars/voiceRing generator. Generate a fresh draft or use the full manual workflow below.';
 if(Object.keys(doc.set.assets??{}).length)return 'This Set contains media assets. Generate a fresh draft or use the manual package workflow below.';
 if(new TextEncoder().encode(JSON.stringify(doc)).byteLength>64*1024)return 'This Set exceeds the 64 KB starting-package limit. Generate a fresh draft or use the manual package workflow below.';
 return undefined;
}
