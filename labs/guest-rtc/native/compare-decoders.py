"""Compare independent audio decoding against archived AVFoundation observations."""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess

lab=Path(__file__).resolve().parents[1]
results=[]
for path in sorted((lab/'evidence').glob('obs-audio-master-*-markers.json')):
    avf=json.loads(path.read_text())
    mp4=lab/'runtime'/avf['recording']
    if not mp4.exists():raise RuntimeError(f'Missing archived lab recording: {mp4.name}')
    decoded=subprocess.run([str(lab/'runtime/decode-audio-markers'),str(mp4)],
        env=dict(os.environ,DYLD_LIBRARY_PATH='/Applications/Producer.app/Contents/Frameworks'),
        capture_output=True,text=True,check=True)
    audio=json.loads(decoded.stdout)
    output=path.with_name(path.name.removesuffix('-markers.json')+'-ffmpeg-audio.json')
    output.write_text(json.dumps(audio,indent=2)+'\n')
    videos=avf['video_marker_pts_ms'];used=set();pairs=[];missing=0
    for edge in audio['audio_marker_pts_ms']:
        candidates=[i for i,v in enumerate(videos) if i not in used and abs(v-edge)<400]
        if not candidates:missing+=1;continue
        index=min(candidates,key=lambda i:abs(videos[i]-edge));used.add(index)
        pairs.append({'audio_ms':edge,'video_ms':videos[index],'video_minus_audio_ms':videos[index]-edge})
    offsets=sorted(abs(p['video_minus_audio_ms']) for p in pairs)
    p95=offsets[math.floor((len(offsets)-1)*.95+.5)] if offsets else None
    originals=avf['audio_marker_pts_ms']
    differences=[b-a for a,b in zip(originals,audio['audio_marker_pts_ms'])] if len(originals)==len(audio['audio_marker_pts_ms']) else None
    results.append({'recording':avf['recording'],'recording_sha256':hashlib.sha256(mp4.read_bytes()).hexdigest(),
        'audio_decoder':audio['decoder'],'video_decoder':avf['decoder'],
        'ffmpeg_minus_avfoundation_audio_ms':differences,
        'original_avfoundation_abs_p95_ms':avf['recorded_av_abs_p95_ms'],
        'independent_audio_abs_p95_ms':p95,'pairs':pairs,
        'unmatched_audio':missing,'unmatched_video':len(videos)-len(used),
        'independent_audio_local_gate_passed':len(pairs)>=5 and missing==0 and len(videos)==len(used) and p95<=80,
        'g1_complete':False,'physical_aec_qualified':False})
(lab/'evidence/decoder-comparison.json').write_text(json.dumps(results,indent=2)+'\n')
print(f'Compared {len(results)} archived recordings; original failure evidence retained')
