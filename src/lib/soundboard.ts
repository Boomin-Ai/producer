import { invoke } from './nativeInvoke';
export type SoundPad={id:string;name:string;color:string;mode:'restart'|'toggle'|'overlap'|'loop';volume:number;fade_ms:number};
export type SoundBoard={pads:SoundPad[];volume:number;monitor:boolean};
export type SoundLibrary={sounds:{id:string;name:string;path:string}[];board:SoundBoard};
export type SoundStatus={room:string;playing:string[];previewing:string[];cached_bytes:number;volume:number;monitor:boolean};
export let soundHotkeysEnabled=false;
export const sounds={
 activate:(room:string)=>invoke<SoundStatus>('soundboard_activate',{room}),
 library:(room:string)=>invoke<SoundLibrary>('soundboard_library',{room}),
 import:(room:string,paths:string[])=>invoke<SoundLibrary>('soundboard_import',{room,paths}),
 save:(room:string,board:SoundBoard)=>invoke<SoundLibrary>('soundboard_save',{room,board}),
 control:(room:string,action:string,id='',value?:number)=>invoke<SoundStatus>('soundboard_control',{request:{room,action,id,value}}),
 pairing:()=>invoke<{port:number;token:string}>('soundboard_pairing'),
 hotkeys:async(enabled:boolean)=>{await invoke('soundboard_hotkeys',{enabled});soundHotkeysEnabled=enabled;},
};
