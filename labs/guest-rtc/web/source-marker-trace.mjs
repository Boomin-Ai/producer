// Source generation evidence only: it does not prove encoder/SFU receipt.
export class SourceMarkerTrace {
 constructor(){this.audio=[];this.video=[];this.errors=[];}
 push(kind,id,contextTime){
  if(!['audio','video'].includes(kind)||!Number.isInteger(id)||id<0||id>255||!Number.isFinite(contextTime)||contextTime<0)throw new Error('Invalid source marker');
  if(this[kind].length>=256){if(!this.errors.includes('source-marker-cap'))this.errors.push('source-marker-cap');return;}
  this[kind].push({id,context_time_seconds:contextTime});
 }
 snapshot(){return {audio:this.audio,video:this.video,errors:this.errors,capacity_per_kind:256,clock:'guest AudioContext sample time only; not native or recording time',scope:'tone samples generated and canvas pulse painted; encoding, transport receipt and playback are unproven'};}
}
