import { invoke } from './nativeInvoke';
import { notifyError } from './notices';
export type SoundPad={id:string;name:string;color:string;mode:'restart'|'toggle'|'overlap'|'loop';volume:number;fade_ms:number};
export type SoundBoard={pads:SoundPad[];volume:number;monitor:boolean};
export type Sound={id:string;name:string;path:string;duration_ms?:number;purpose?:string;description?:string};
export type SoundLibrary={sounds:Sound[];board:SoundBoard};

export function soundCueCatalog({sounds,board}:SoundLibrary) {
  const pads=new Map(board.pads.map(pad=>[pad.id,pad]));
  const explicitPurpose=(name:string)=>{
    if (/\b(whoosh|swoosh|swish|transition)\b/i.test(name)) return 'transition';
    if (/\b(mouse click|button click|ui click)\b/i.test(name)) return 'button';
    if (/\b(applause|rimshot|crowd cheer)\b/i.test(name)) return 'reaction';
  };
  return sounds.flatMap(sound=>{
    const pad=pads.get(sound.id);
    if (!pad && !['transition','button','reaction'].includes(sound.purpose??'')) return [];
    const name=pad?.name||sound.name;
    const purpose=sound.purpose??explicitPurpose(name);
    return [{id:sound.id,name,mode:pad?.mode??'restart',connected:!!pad,purpose,
      description:sound.description,durationMs:sound.duration_ms||undefined}];
  });
}
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

/** A missing or disconnected sound must never block the visual action. */
export function playSetSound(room: string, id: string) {
  void sounds.control(room, 'play_cue', id).catch(error => notifyError(error, {key: 'set-sound'}));
}
