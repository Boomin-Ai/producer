import{invoke}from'@tauri-apps/api/core';import{sounds}from'../../lib/soundboard';
export async function soundboardProof(room:string,folder:string){
 const report=(result:unknown)=>invoke('live_set_v2_report',{result});
 const pause=(n:number)=>new Promise(r=>setTimeout(r,n));
 try{
 await report({kind:'soundboard',stage:'waiting for room'});
 for(let i=0;i<180;i++){try{await sounds.control(room,'status');break}catch{if(i===179)throw Error('Room audio did not activate');await pause(500)}}
 const library=await sounds.import(room,[folder]);await sounds.activate(room);await sounds.control(room,'monitor','',0);
 await report({kind:'soundboard',stage:'imported',count:library.board.pads.length});
 const chosen=library.board.pads.find(p=>/air horn/i.test(p.name))??library.board.pads[0];if(!chosen)throw Error('No sounds imported');
 await sounds.hotkeys(true);await sounds.hotkeys(false);
 await sounds.control(room,'prepare',chosen.id);await sounds.control(room,'stop_all');
 await invoke('live_program_audio_start');await pause(200);await invoke('live_program_audio_read');
 const start=performance.now();await sounds.control(room,'play',chosen.id);const replyMs=performance.now()-start;
 let firstMs:number|null=null;let peaks=[0,0];for(let i=0;i<70;i++){await pause(20);const bytes=await invoke<ArrayBuffer>('live_program_audio_read');const v=new DataView(bytes);let offset=0;while(offset+16<=v.byteLength){const bus=v.getUint32(offset,true),frames=v.getUint32(offset+4,true),end=offset+16+frames*8;if(end>v.byteLength)throw Error('Invalid audio packet');for(let s=offset+16;s<end;s+=4){const value=Math.abs(v.getFloat32(s,true));if(bus<2)peaks[bus]=Math.max(peaks[bus],value);if(value>.001&&firstMs===null)firstMs=performance.now()-start;}offset=end;}}
 await sounds.control(room,'stop_all');await pause(200);await invoke('live_program_audio_read');await pause(100);const stopped=await sounds.control(room,'status');await invoke('live_program_audio_stop');await sounds.control(room,'monitor','',1);
 if(peaks.some(p=>p<.001)||stopped.playing.length)throw Error('Audio did not reach both buses or stop');
 await report({kind:'soundboard',ok:true,stage:'ready for manual review',room,count:library.board.pads.length,replyMs:Math.round(replyMs),firstAudioObservedMs:firstMs===null?null:Math.round(firstMs),peaks,playingAfterStop:stopped.playing.length,hotkeyRegistration:true});
 // Refresh the panel after import without touching the room or current Set.
 window.dispatchEvent(new Event('producer:soundboard-library'));
 }catch(e){await invoke('live_program_audio_stop').catch(()=>{});await sounds.control(room,'stop_all').catch(()=>{});await report({kind:'soundboard',ok:false,error:String(e)})}
}
