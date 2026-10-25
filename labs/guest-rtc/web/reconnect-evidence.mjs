// RTP counters belong to one receiver epoch. Missing shutdown stats are absent,
// not a zero counter; an SSRC change or counter regression needs separate proof.
export function reconnectReturnGrowth(observations, resumedAtMs) {
 const after=Number.isFinite(resumedAtMs)?observations.filter(o=>o.at_ms>resumedAtMs+3000):[];
 const samples=after.filter(o=>o.audio?.length && o.audio.every(s=>typeof s.id==='string' && Number.isFinite(s.ssrc) && Number.isFinite(s.packetsReceived) && s.packetsReceived>=0));
 const identities=o=>o.audio.map(s=>`${s.id}:${s.ssrc}`).sort().join('|');
 const packets=o=>o.audio.reduce((sum,s)=>sum+s.packetsReceived,0);
 let error=null;
 if(samples.length<2)error='Insufficient post-resume audio stats';
 for(let i=1;i<samples.length;i++) {
  if(identities(samples[i])!==identities(samples[i-1]))error='Receiver epoch changed; separate replacement proof required';
  else if(samples[i].audio.some(s=>s.packetsReceived<samples[i-1].audio.find(previous=>previous.id===s.id&&previous.ssrc===s.ssrc).packetsReceived))error='RTP packet counter regressed';
  if(samples[i].state.returnVideoFrames<samples[i-1].state.returnVideoFrames)error='Video frame counter regressed';
 }
 const first=samples[0],last=samples.at(-1);
 return {resumed_at_ms:resumedAtMs??null,post_resume_samples:samples.length,observations_without_valid_audio_stats:after.length-samples.length,first_observed_at_ms:first?.at_ms??null,last_observed_at_ms:last?.at_ms??null,receiver_epoch:first?identities(first):null,video_frames:!error?last.state.returnVideoFrames-first.state.returnVideoFrames:0,audio_packets:!error?packets(last)-packets(first):0,error,scope:'receiver growth after actual SDK signaling resume; does not establish WAN outage or lip-sync offset'};
}
