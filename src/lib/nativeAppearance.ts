/** Opt-in outgoing guest owner. Native code obtains and validates its own
 * guest-scoped authority. No browser camera, canvas, PCM queue or host token is
 * opened here. Unsupported/failed native publication never changes transport.
 */
import {invoke} from './nativeInvoke';

export type NativeAppearanceStatus = {
 appearanceId:string;phase:'starting'|'waiting'|'live'|'reconnecting'|'gone'|'error';
 onStage:boolean;hasProgram:boolean;hasAudio:boolean;returnSourceId:string|null;
 width:number;height:number;fps:number;
};
export type NativeAppearanceSpec = {
 localRoomId:string;api:string;invite:string;participantId:string;portrait:boolean;quality:720|1080;
};
export class NativeAppearance {
 private readonly id=crypto.randomUUID();
 private alive=true;private timer=0;private previewUrl:string|null=null;
 private retiring:Promise<void>|null=null;
 private startup:Promise<void>|null=null;
 private muted=false;private cameraOff=false;private playback=false;
 private commands:Promise<unknown>=Promise.resolve();private nextPreview=0;private desiredPlayback=false;
 constructor(private readonly spec:NativeAppearanceSpec,
  private readonly update:(state:NativeAppearanceStatus,preview:string|null,playback:boolean)=>void,
  private readonly failed:()=>void){}
 start(muted=false,cameraOff=false):Promise<void>{
  if(this.startup)return this.startup;
  this.muted=muted;this.cameraOff=cameraOff;
  this.startup=this.begin();return this.startup;
 }
 private async begin():Promise<void>{
  if(!this.alive)return;
  if(!await invoke<boolean>('live_appearance_enabled'))throw Error('Native appearances are unavailable in this build.');
  if(!this.alive)return;
  const status=await invoke<NativeAppearanceStatus>('live_appearance_start',{appearanceId:this.id,...this.spec,controls:{muted:this.muted,cameraOff:this.cameraOff,playback:false}});
  if(!this.alive)return;
  this.reflect(status);
  if(this.alive)void this.poll();
 }
 private reflect(status:NativeAppearanceStatus):void {
  if(!this.alive)return;
  const wide=this.spec.quality*16/9;
  if(status.appearanceId!==this.id||status.height!==(this.spec.portrait?wide:this.spec.quality)||
   status.width!==(this.spec.portrait?this.spec.quality:wide)||status.fps!==30||
   !['starting','waiting','live','reconnecting','gone','error'].includes(status.phase))
   throw Error('Native appearance binding changed.');
  if(!status.hasProgram&&this.previewUrl){URL.revokeObjectURL(this.previewUrl);this.previewUrl=null;}
  this.update(status,this.previewUrl,this.playback);
 }
 private async poll():Promise<void>{
  try{
   const status=await invoke<NativeAppearanceStatus>('live_appearance_status',{appearanceId:this.id});
   if(!this.alive)return;
   if(status.hasProgram&&performance.now()>=this.nextPreview){
    this.nextPreview=performance.now()+500;
    const bytes=await invoke<ArrayBuffer>('live_appearance_preview',{appearanceId:this.id});
    if(!this.alive)return;
    if(bytes.byteLength>512*1024)throw Error('Native preview exceeded its limit.');
    if(bytes.byteLength){
     const next=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'})),previous=this.previewUrl;
     this.previewUrl=next;if(previous)URL.revokeObjectURL(previous);
    }
   }
   this.reflect(status);
   if(['gone','error'].includes(status.phase)){await this.close();return;}
  }catch{if(this.alive){this.failed();await this.close().catch(()=>{});return;}}
  if(this.alive)this.timer=window.setTimeout(()=>void this.poll(),300);
 }
 controls(muted:boolean,cameraOff:boolean,playback=this.desiredPlayback):Promise<void>{
  this.muted=muted;this.cameraOff=cameraOff;
  this.desiredPlayback=playback;
  const controls={muted,cameraOff,playback};
  const result=this.commands.then(async()=>{
   await this.startup;
   if(!this.alive)return;
   await invoke('live_appearance_controls',{appearanceId:this.id,controls});
   if(this.alive)this.playback=controls.playback;
  });
  this.commands=result.catch(()=>{});return result;
 }
 async enableAudio():Promise<void>{await this.controls(this.muted,this.cameraOff,true);}
 close(retry=false):Promise<void>{
  if(this.retiring&&!retry)return this.retiring;
  this.alive=false;window.clearTimeout(this.timer);
  if(this.previewUrl){URL.revokeObjectURL(this.previewUrl);this.previewUrl=null;}
  this.retiring=(async()=>{
   // A successor must not start until an older in-flight start has settled
   // and its exact owner ID has received a final native retirement receipt.
   // Already-dispatched control acknowledgements cannot keep capture owned.
   // The native stop fences them; queued commands see alive=false and skip.
   await this.startup?.catch(()=>{});
   await invoke<void>('live_appearance_stop',{appearanceId:this.id});
  })();
  const attempt=this.retiring;
  void attempt.catch(()=>{if(this.retiring===attempt)this.retiring=null;});
  return attempt;
 }
}
