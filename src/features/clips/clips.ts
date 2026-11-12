import {invoke} from '../../lib/nativeInvoke';
export type ClipOutput='landscape'|'portrait'|'both';
export interface ClipSettings {seconds:number;memory_mb:number;output:ClipOutput}
export interface ClipTrackStatus {output:ClipOutput;captured_frames:number;encoded_frames:number;video_active:boolean;audio_active:boolean}
export interface ClipStatus {enabled:boolean;saving:boolean;room_id:string|null;settings:ClipSettings;elapsed_seconds:number;video_frames:number;tracks?:ClipTrackStatus[];error:string|null}
export interface ClipFile {path:string;output:ClipOutput;duration_ms:number}
export interface SavedClip {id:string;created_ms:number;status:'saving'|'ready'|'failed';requested_seconds:number;files:ClipFile[];error:string|null}
export const DEFAULT_CLIPS:ClipSettings={seconds:60,memory_mb:256,output:'landscape'};
export const OFF_CLIPS:ClipStatus={enabled:false,saving:false,room_id:null,settings:DEFAULT_CLIPS,elapsed_seconds:0,video_frames:0,error:null};
export function validateClipSettings(value:unknown):ClipSettings {
 const v=value as ClipSettings;if(!v||!Number.isInteger(v.seconds)||v.seconds<1||v.seconds>600||!Number.isInteger(v.memory_mb)||v.memory_mb<64||v.memory_mb>1024||!['landscape','portrait','both'].includes(v.output))throw Error('Choose 1–600 seconds, 64–1024 MB, and an output format.');
 return {seconds:v.seconds,memory_mb:v.memory_mb,output:v.output};
}
export const clips={
 status:(roomId:string)=>invoke<{capture:ClipStatus;directory:string}>('clips_status',{roomId}),
 enable:(roomId:string,settings:ClipSettings)=>invoke<ClipStatus>('clips_enable',{roomId,settings:validateClipSettings(settings)}),
 disable:(roomId:string)=>invoke<ClipStatus>('clips_disable',{roomId}),
 save:(roomId:string)=>invoke<{id:string;files:ClipFile[]}>('clips_save',{roomId}),
 list:(roomId:string)=>invoke<SavedClip[]>('clips_list',{roomId}),
 pickDirectory:()=>invoke<string|null>('clips_pick_directory'),
};
export function clipsError(error:unknown):string {const message=String(error);return /command.*clips_|clips_.*not found/i.test(message)?'Clips needs the updated native dev build. Your recording and streaming controls are unchanged.':message;}
