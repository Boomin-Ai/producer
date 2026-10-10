// Node-side serialization only; no microphone/device calls.
export function decodedVoiceWav(chunks,sampleCount,rate,seconds) {
 if(rate!==48000 || !Number.isInteger(seconds) || seconds<5 || seconds>60)throw new Error('Voice review must be 48 kHz and bounded to 60 seconds');
 if(!Number.isInteger(sampleCount)||sampleCount<1||sampleCount>(seconds+5)*rate)throw new Error('Invalid decoded sample count');
 if(!Array.isArray(chunks)||chunks.length>seconds+6)throw new Error('Too many decoded chunks');
 const buffers=chunks.map(chunk=>{
  if(typeof chunk!=='string'||chunk.length>128004||!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk))throw new Error('Invalid PCM chunk');
  const data=Buffer.from(chunk,'base64');
  if(data.length>96000||data.length%2)throw new Error('Invalid PCM block length');
  return data;
 });
 const data=Buffer.concat(buffers);
 if(data.length!==sampleCount*2)throw new Error('Decoded sample accounting mismatch');
 const wav=Buffer.alloc(44+data.length);
 wav.write('RIFF',0);wav.writeUInt32LE(36+data.length,4);wav.write('WAVEfmt ',8);
 wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
 wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
 wav.write('data',36);wav.writeUInt32LE(data.length,40);data.copy(wav,44);
 return wav;
}
