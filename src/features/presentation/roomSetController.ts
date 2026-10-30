import {parseControlDefinition,type ControlDefinition,type ControlCommand} from '../../../shared/set-runtime/control';
import {parseRuntimeDefinition,type RuntimeDefinition,type Scalar} from '../../../shared/set-runtime/contract';
import type {Snapshot,Result} from '../../../shared/set-runtime/runtime';
import {parseWeatherLocation,type WeatherLocation} from '../../../shared/set-runtime/weather';
import {compareConfirmedPresentation,presentationFailed,type ConfirmedPresentation,type PresentedOutputs,type OutputFailures} from '../../../shared/set-runtime/presentationReceipt';
import {subscribeModulePush,type ModulePushEvent} from './modulePush';

type Reply={locations?:unknown;deployment?:string|null;setEpoch?:number;snapshot?:Snapshot|null;definition?:RuntimeDefinition;control?:ControlDefinition;result?:Result;presented?:PresentedOutputs;outputFailures?:OutputFailures};
export type RoomSetCall=(method:'GET'|'POST',suffix?:string,body?:unknown)=>Promise<Reply>;
export interface RoomSetState {status:'loading'|'ready'|'empty'|'error';deployment?:string;snapshot?:Snapshot;definition?:RuntimeDefinition;control?:ControlDefinition;pending:boolean;error:string;committed?:number;presented?:PresentedOutputs;outputFailures?:OutputFailures}
/** Operator observer: never installs packages, opens sockets, or drives a local
 * renderer. Every mutation uses the authenticated room route. */
export class RoomSetController {
 private state:RoomSetState={status:'loading',pending:false,error:''};
 private listeners=new Set<()=>void>();
 private closed=false;
 private generation=0;
 private floor=0;
 private target='';
 private fetching=false;
 private again=false;
 private timer?:ReturnType<typeof setTimeout>;
 private push?:ReturnType<typeof subscribeModulePush>;
 constructor(private endpoint:string,private room:string,private call:RoomSetCall){}
 snapshot=()=>this.state;
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 private update(next:RoomSetState){if(this.closed)return;this.state=next;for(const listener of this.listeners)listener();}
 start(){if(this.push)return;this.closed=false;this.push=subscribeModulePush(this.endpoint,this.room,this.onPush);void this.refresh();}
 close(){this.closed=true;this.generation++;clearTimeout(this.timer);this.push?.close();this.push=undefined;this.listeners.clear();}
 private onPush=(event:ModulePushEvent)=>{
  if(event.type==='presentation'){
   const p=event.presentation;
   if(event.deployment===this.state.deployment&&p.setEpoch===this.state.snapshot?.setEpoch)this.update(this.withReceipt(this.state,p));
   return;
  }
  if(event.type==='update'){
   if(event.setEpoch<this.floor)return;
   if(event.deployment!==this.state.deployment||event.setEpoch!==this.state.snapshot?.setEpoch){if(this.target!==event.deployment||this.floor!==event.setEpoch){this.floor=event.setEpoch;this.target=event.deployment;this.generation++;this.update({status:'loading',pending:false,error:''});}void this.refresh();return;}
   if(event.snapshot){this.accept(event.snapshot);return;}
  }
  if(event.type==='offline')this.update({...this.state,status:'loading'});
  void this.refresh();
 };
 private withReceipt(state:RoomSetState,receipt:ConfirmedPresentation):RoomSetState {
  const previous=state.presented?.[receipt.output],failure=state.outputFailures?.[receipt.output];
  // A late failure must not replace a completed retry or a newer committed frame.
  if(presentationFailed(receipt)){
   if(previous&&compareConfirmedPresentation(previous,receipt)>=0||failure&&compareConfirmedPresentation(failure,receipt)>0)return state;
   return {...state,outputFailures:{...state.outputFailures,[receipt.output]:receipt}};
  }
  if(previous&&compareConfirmedPresentation(previous,receipt)>0)return state;
  const outputFailures={...state.outputFailures};if(failure&&compareConfirmedPresentation(receipt,failure)>=0)delete outputFailures[receipt.output];
  return {...state,presented:{...state.presented,[receipt.output]:receipt},outputFailures};
 }
 private accept(snapshot:Snapshot){
  const old=this.state.snapshot;
  if(snapshot.setEpoch<this.floor||old&&(snapshot.setEpoch!==old.setEpoch||snapshot.revision<old.revision))return;
  this.floor=snapshot.setEpoch;this.update({...this.state,snapshot});
 }
 refresh=async()=>{
  if(this.closed)return;if(this.fetching){this.again=true;return;}this.fetching=true;clearTimeout(this.timer);const generation=this.generation;
  try{
   const [state,config]=await Promise.all([this.call('GET'),this.call('GET','/configuration')]);
   if(this.closed||generation!==this.generation)return;
   if(!state.deployment||!state.snapshot){this.update({status:'empty',pending:false,error:''});return;}
   if(config.deployment!==state.deployment||config.setEpoch!==state.snapshot.setEpoch||state.snapshot.setEpoch<this.floor)throw Error('Set changed while loading. Reconnecting…');
   const definition=parseRuntimeDefinition(config.definition),control=config.control?parseControlDefinition(config.control):undefined;
   const previous=this.state.snapshot;
   this.floor=state.snapshot.setEpoch;
   this.target=state.deployment;
   let next:RoomSetState={...this.state,status:'ready',deployment:state.deployment,definition,control,error:'',presented:{},outputFailures:{},snapshot:previous&&previous.setEpoch===state.snapshot.setEpoch&&previous.revision>state.snapshot.revision?previous:state.snapshot};
   for(const p of [...Object.values(state.presented??{}),...Object.values(state.outputFailures??{}),...Object.values(this.state.presented??{}),...Object.values(this.state.outputFailures??{})])if(p.setEpoch===state.snapshot.setEpoch)next=this.withReceipt(next,p);
   this.update(next);
  }catch(error){if(!this.closed&&generation===this.generation)this.update({status:'error',pending:false,error:error instanceof Error?error.message:'Room controls unavailable'});}
  finally{this.fetching=false;if(!this.closed){const delay=this.again?0:this.push?.ready()?30000:1000;this.again=false;this.timer=setTimeout(()=>void this.refresh(),delay);}}
 };
 private async request(suffix:string,command:unknown):Promise<Result>{
  if(this.closed||this.state.status!=='ready'||this.state.pending||!this.state.snapshot)throw Error('Room controls are not ready');
  const generation=this.generation,epoch=this.state.snapshot.setEpoch,deployment=this.state.deployment;
  this.update({...this.state,pending:true,error:''});
  try{
   const reply=await this.call('POST',suffix,{command});
   if(this.closed||generation!==this.generation||this.state.deployment!==deployment||this.state.snapshot?.setEpoch!==epoch)throw Error('Set connection changed');
   if(reply.snapshot)this.accept(reply.snapshot);
   if(!reply.result)throw Error('Missing command receipt');
   if(reply.result.status==='rejected')throw Error(reply.result.error);
   this.update({...this.state,committed:reply.result.revision});return reply.result;
  }catch(error){if(!this.closed&&generation===this.generation)this.update({...this.state,error:error instanceof Error?error.message:'Command failed'});throw error;}
  finally{if(!this.closed&&generation===this.generation)this.update({...this.state,pending:false});}
 }
 control=async(op:ControlCommand['op'],input?:ControlCommand['input'])=>{
  if(!this.state.control||!this.state.snapshot)throw Error('Shared layouts and Shows are not enabled for this Set');
  return this.request('/control',{id:crypto.randomUUID(),setEpoch:this.state.snapshot.setEpoch,expectedRevision:this.state.snapshot.revision,op,...(input?{input}:{})});
 };
 sendModule=async(module:string,op:string,input:Record<string,Scalar>={})=>{
  const s=this.state.snapshot,m=s?.modules[module];if(!s||!m)throw Error('Module unavailable');
  return this.request('/commands',{id:crypto.randomUUID(),setEpoch:s.setEpoch,module,epoch:m.epoch,expectedRevision:s.revision,op,input});
 };
 /** Room-scoped read: city search never grants connection administration. */
 searchWeatherLocations=async(query:string):Promise<WeatherLocation[]>=>{
  if(this.closed||this.state.status!=='ready'||!this.state.snapshot)throw Error('Room controls are not ready');
  if(typeof query!=='string'||query.length>100||query.trim().length<2)throw Error('Enter 2–100 city characters');
  const generation=this.generation,epoch=this.state.snapshot.setEpoch,deployment=this.state.deployment;
  const reply=await this.call('GET','/locations?query='+encodeURIComponent(query.trim()));
  if(this.closed||generation!==this.generation||this.state.status!=='ready'||this.state.deployment!==deployment||this.state.snapshot?.setEpoch!==epoch)throw Error('Set connection changed');
  if(!Array.isArray(reply.locations)||reply.locations.length>5)throw Error('Invalid city lookup response');
  return reply.locations.map(parseWeatherLocation);
 };
 queryModule=async(module:string,question:string,refresh=false)=>{
  const s=this.state.snapshot,m=s?.modules[module],b=m&&this.state.definition?.definitions[m.definition].behavior;
  if(!s||!m||!b||!['weather','agent'].includes(b.type))throw Error('Module has no provider');
  await this.request(`/modules/${encodeURIComponent(module)}/query`,{id:crypto.randomUUID(),setEpoch:s.setEpoch,module,epoch:m.epoch,op:b.type==='agent'?'agent.ask':'weather.refresh',input:{question,refresh}});
 };
}
