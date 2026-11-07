import {invoke} from '../../lib/nativeInvoke';
import {sounds} from '../../lib/soundboard';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function peaks(ms:number){
 const result=[0,0],end=performance.now()+ms;
 while(performance.now()<end){
  await sleep(40);const data=await invoke<ArrayBuffer>('live_program_audio_read'),view=new DataView(data);let offset=0;
  while(offset+16<=view.byteLength){const bus=view.getUint32(offset,true),frames=view.getUint32(offset+4,true),next=offset+16+frames*8;if(next>view.byteLength)throw Error('Invalid audio packet');
   if(bus<2)for(let sample=offset+16;sample<next;sample+=4)result[bus]=Math.max(result[bus],Math.abs(view.getFloat32(sample,true)));offset=next;
  }
 }
 return result;
}
export async function soundLibraryPreviewProof(room:string){
 const original=await sounds.library(room),assigned=new Set(original.board.pads.map(p=>p.id)),unassigned=original.sounds.filter(sound=>!assigned.has(sound.id));
 const candidate=unassigned.find(sound=>/apple pay/i.test(sound.name))??unassigned[0],other=unassigned.find(sound=>sound.id!==candidate?.id),cold=unassigned.find(sound=>sound.id!==candidate?.id&&sound.id!==other?.id);
 if(!candidate||!other||!cold)throw Error('Three unconnected sounds are needed for audition verification');
 const sequence=async()=>{const {generation}=await invoke<{generation:number}>('live_set_status');return Promise.all(['program','portrait'].map(outputId=>invoke<{djVisuals:{soundActive?:boolean;soundSequence?:number}[]}>('live_set_v2',{request:{op:'status',generation,outputId}})));};
 try{
  await sounds.control(room,'stop_all');await invoke('live_program_audio_start');await sleep(150);await invoke('live_program_audio_read');
  const baseline=await peaks(150);if(baseline.some(value=>value>.001))throw Error('Program must be quiet to measure preview isolation');
  const visualsBefore=await sequence(),started=performance.now();
  const preview=await sounds.control(room,'preview',candidate.id);if(!preview.previewing.includes(candidate.id))throw Error('Unconnected sound did not audition');
  const previewReplyMs=performance.now()-started,programPeaks=await peaks(400);
  if(programPeaks.some(value=>value>.001))throw Error('Private preview leaked into program audio');
  const visualsAfter=await sequence();
  if(visualsAfter.some((output,i)=>output.djVisuals.some((v,j)=>v.soundActive||(v.soundSequence??0)!==(visualsBefore[i].djVisuals[j]?.soundSequence??0))))throw Error('Preview triggered the on-output sound overlay');
  const replacement=await sounds.control(room,'preview',other.id);if(replacement.previewing.length!==1||replacement.previewing[0]!==other.id)throw Error('Preview replacement kept multiple sounds playing');
  const pending=sounds.control(room,'preview',cold.id),cancel=sounds.control(room,'stop_preview');await Promise.allSettled([pending,cancel]);await sleep(150);
  if((await sounds.control(room,'status')).previewing.length)throw Error('Cancelled preview started after stopping');
  let denied=false;try{await sounds.control(room,'play',candidate.id);}catch(error){denied=/not assigned/i.test(String(error));}if(!denied)throw Error('Unconnected sound was allowed on program');
  if(JSON.stringify((await sounds.library(room)).board)!==JSON.stringify(original.board))throw Error('Audition changed room assignments or playback settings');
  const live=original.board.pads[0];if(!live)throw Error('A connected pad is needed to check live playback preservation');
  await sounds.control(room,'volume','',0);await sounds.control(room,'monitor','',0);
  await sounds.control(room,'play',live.id);await sounds.control(room,'preview',candidate.id);const stopped=await sounds.control(room,'stop_preview');
  if(!stopped.playing.includes(live.id)||stopped.previewing.length)throw Error('Stopping preview interrupted live sound playback');
  return {check:'Unconnected library audition is private, does not connect sounds or trigger overlays, replaces/cancels correctly, and preserves live sounds',sound:candidate.name,previewReplyMs,baseline,programPeaks};
 }finally{
  await sounds.control(room,'stop_all').catch(()=>{});await invoke('live_program_audio_stop').catch(()=>{});
  await sounds.control(room,'volume','',original.board.volume).catch(()=>{});await sounds.control(room,'monitor','',original.board.monitor?1:0).catch(()=>{});
 }
}
