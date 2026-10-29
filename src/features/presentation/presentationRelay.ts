import {parsePresentationReceipt,presentationFailed,comparePresentation,type PresentationReceipt} from '../../../shared/set-runtime/presentationReceipt';
/** Coalesce actual renderer outcomes; a committed command never implies presentation. */
export class PresentationRelay {
 private pending=new Map<string,PresentationReceipt>();
 private sent=new Map<string,string>();
 constructor(private room:string){}
 observe(value:unknown,commit:{setEpoch:number;revision:number},send:(frame:Record<string,unknown>)=>boolean){
  const d=value as {roomId?:unknown;output?:unknown;generation?:unknown;nativeRevision?:unknown;renderSerial?:unknown;status?:unknown;stage?:unknown;error?:unknown;moduleCommit?:{setEpoch:number;revision:number;domain?:string}}|null;
  if(d?.roomId!==this.room||d.moduleCommit?.domain==='rehearsal'||d.moduleCommit?.setEpoch!==commit.setEpoch||d.moduleCommit.revision>commit.revision)return;
  try{const receipt=parsePresentationReceipt({output:d.output,generation:d.generation,nativeRevision:d.nativeRevision,renderSerial:d.renderSerial,setEpoch:d.moduleCommit.setEpoch,revision:d.moduleCommit.revision,...(d.status==='failed'?{status:'failed',stage:d.stage,error:d.error}:{})});
   const previous=this.pending.get(receipt.output);
   if(previous&&(comparePresentation(previous,receipt)>0||comparePresentation(previous,receipt)===0&&!presentationFailed(previous)&&presentationFailed(receipt)))return;
   this.pending.set(receipt.output,receipt);this.flush(send,commit);
  }catch{/* Malformed or incomplete native status cannot confirm presentation. */}
 }
 flush(send:(frame:Record<string,unknown>)=>boolean,commit:{setEpoch:number;revision:number},reconnect=false){
  if(reconnect)this.sent.clear();
  for(const [output,receipt]of this.pending){if(receipt.setEpoch!==commit.setEpoch){this.pending.delete(output);this.sent.delete(output);continue;}
   const identity=JSON.stringify([receipt.setEpoch,receipt.revision,receipt.generation,presentationFailed(receipt)?['failed',receipt.nativeRevision,receipt.stage]:['presented']]);
   if(this.sent.get(output)!==identity&&send({type:'set.presented',receipt}))this.sent.set(output,identity);
  }
 }
}
