"""Separate raw mix, pre-mux packet timeline, container timing and decoded markers."""
import json
import statistics
from pathlib import Path

lab = Path(__file__).resolve().parents[1]
results = []
for path in sorted((lab/'evidence').glob('transport-obs-audio-master-*.json')):
    if path.stem.endswith(('-browser','-packet')):continue
    report = json.loads(path.read_text())
    probe = report['obs_recording'].get('raw_video_pipeline_probe', {})
    if 'packet_probe' not in probe: continue
    packets = probe['packet_probe']
    assert not packets['registered'] and packets['overflow'] == 0
    assert packets['count'] == len(packets['stamps'])
    assert probe['callbacks_quiescent_after_unregister']
    suffix = path.stem.removeprefix('transport-')
    decoded = json.loads((lab/'evidence'/f'{suffix}-markers.json').read_text())
    container = json.loads((lab/'evidence'/f'{suffix}-container.json').read_text())
    tracks = []
    for video,kind,field in [(True,'video','markers'),(False,'audio','audio_markers')]:
        stamps = [p for p in packets['stamps'] if p['video']==video]
        assert stamps and all(p['timebase_den']>0 for p in stamps)
        pts = [p['pts']*p['timebase_num']*1000/p['timebase_den'] for p in stamps]
        # sys DTS preserves the OBS monotonic origin. PTS-DTS allows reordered frames.
        origins = [p['sys_dts_usec']/1000-p['dts']*p['timebase_num']*1000/p['timebase_den'] for p in stamps]
        origin = statistics.median(origins)
        assert max(origins)-min(origins)<0.01
        raw_pts = []
        for marker in probe[field]:
            pts_ms = marker['timestamp_ns']/1e6-origin
            if not raw_pts or pts_ms-raw_pts[-1]>=150:
                raw_pts.append(pts_ms)
        edges = decoded[f'{kind}_marker_pts_ms']
        assert len(raw_pts)==len(edges)
        samples = next(t['sample_timings'] for t in container['tracks'] if t['kind']==kind)
        tracks.append({'kind':kind,'pre_mux_packet_count':len(stamps),'container_timing_count':len(samples),
            'sys_clock_minus_packet_dts_ms':origin,'origin_range_ms':max(origins)-min(origins),
            'first_packet_pts_ms':pts[:5],'first_container_pts_ms':[p['pts_ms'] for p in samples[:5]],
            'raw_marker_projected_packet_pts_ms':raw_pts,'decoded_marker_pts_ms':edges,
            'decoded_minus_raw_projected_ms':[b-a for a,b in zip(raw_pts,edges)],
            'composition_minus_system_pts_ms':[p['composition_ns']/1e6-p['sys_dts_usec']/1000 for p in stamps if p['composition_ns']],
            'packet_timing_count':sum(p['composition_ns'] is not None for p in stamps)})
    results.append({'run':path.stem,'audio_priming_samples':report['obs_recording']['audio_priming_samples'],
        'container_mode':report['obs_recording'].get('container_mode','fragmented-default'),
        'local_abs_av_p95_ms':decoded['recorded_av_abs_p95_ms'],'local_gate_passed':decoded['observed_marker_test_pass'],
        'tracks':tracks,'g1_complete':False})
r=json.loads((lab/'evidence/obs-packet-pipeline-lifecycle.json').read_text())
assert len(r['cycles'])==4 and r['cycles'][-1]['cancelled']
for cycle in r['cycles']:
    assert cycle['probe_lifecycle']['alive']==0
    assert cycle['probe_lifecycle']['created']==cycle['probe_lifecycle']['destroyed']
    assert cycle['threads_after_shutdown']<=r['warm_threads']+2
    assert cycle['fds_after_shutdown']<=r['warm_fds']+2
    if cycle['finish']:
        probe=cycle['finish']['raw_video_pipeline_probe']
        assert not probe['packet_probe']['registered'] and probe['callbacks_quiescent_after_unregister']
partial=r['partial_initialization']
assert partial['injected_after_packet_callback_registration']
assert partial['probe_lifecycle']['alive']==0
assert partial['probe_lifecycle']['created']==partial['probe_lifecycle']['destroyed']
(lab/'evidence/packet-timing-verification.json').write_text(json.dumps(results,indent=2)+'\n')
print(f'Verified {len(results)} pre-mux timing traces and three-callback lifetime cleanup')
