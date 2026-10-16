export function markerOffsets(probe, sinceMs=-Infinity,untilMs=Infinity) {
 const video=probe.video.filter(marker=>marker.at_ms>=sinceMs&&marker.at_ms<untilMs),audio=probe.audio.filter(marker=>marker.at_ms>=sinceMs&&marker.at_ms<untilMs);
 const used=new Set(),pairs=[];
 for(const sound of audio){let selected=-1,distance=1000;
  for(let i=0;i<video.length;i++){if(used.has(i)||video[i].id%16!==sound.id)continue;const delta=Math.abs(video[i].at_ms-sound.at_ms);if(delta<distance){distance=delta;selected=i;}}
  if(selected>=0){used.add(selected);pairs.push({id:video[selected].id,video_epoch:video[selected].epoch,audio_epoch:sound.epoch,video_minus_audio_ms:video[selected].at_ms-sound.at_ms});}
 }
 const absolute=pairs.map(pair=>Math.abs(pair.video_minus_audio_ms)).sort((a,b)=>a-b);
 return {audio_markers:audio.length,video_markers:video.length,paired_markers:pairs.length,unpaired_audio:audio.length-pairs.length,unpaired_video:video.length-pairs.length,absolute_p95_ms:absolute.length?absolute[Math.ceil(absolute.length*.95)-1]:null,pairs,scope:'generated label-matched browser observations; paint/analyser scheduling uncertainty, not OBS or source-to-playout qualification'};
}

export function videoSequenceHealth(probe) {
 let repeats=0,regressions=0;
 for(let i=1;i<probe.video.length;i++){const step=(probe.video[i].id-probe.video[i-1].id+256)%256;if(step===0)repeats++;else if(step>=128)regressions++;}
 return {repeated_labels:repeats,regressed_labels:regressions,scope:'8-bit generated marker progression; bounds detect old/repeated labels, not all SDK buffered audio'};
}
