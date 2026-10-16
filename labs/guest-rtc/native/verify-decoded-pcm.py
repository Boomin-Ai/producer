"""Check online paired-PCM evidence, not recorded synchronization acceptance."""
import hashlib
import json
from pathlib import Path

lab = Path(__file__).resolve().parents[1]
results = []
for name in ['transport-decoded-pcm-stereo-rejoin', 'transport-decoded-pcm-audio-jitter', 'transport-decoded-pcm-step-jitter']:
    path = lab / 'evidence' / (name + '.json')
    r = json.loads(path.read_text())
    online = r['decoded_pcm_origin_handoff']
    mixer = r['timed_mixer_probe']
    assert online['online'] and not online['obs_connected']
    assert not online['capture_time_qualified'] and not r['g1_complete']
    assert online['capacity_rejected'] == 0 and mixer['capacity_exceeded'] == 0
    assert mixer['sources_alive'] == 0 and mixer['sources_created'] == mixer['sources_destroyed']
    native = {s['generation']: s for s in mixer['sources']}
    sources = online['sources']
    current_audio_ssrcs = {s['ssrc'] for s in r['receiver_stats'] if s['kind'] == 'audio'}
    assert len(current_audio_ssrcs) == 3
    assert len(sources) == (6 if name.endswith('rejoin') else 3)
    for source in sources:
        record = native[source['generation']]
        assert not record['active'] and record['pcm_pending'] == 0
        assert record['pcm_format_rejected'] == 0
        assert record['frames'] == sum(record[k] for k in
            ['pcm_consumed', 'pcm_overflow', 'pcm_stale', 'pcm_retired', 'pcm_format_rejected'])
        assert record['pcm_consumed'] == source['blocks_consumed']
        assert source['blocks_consumed'] == source['origins_mapped'] + source['origins_unavailable']
        assert source['nonzero_pcm_blocks'] > 5
        if source['ssrc'] in current_audio_ssrcs:
            assert source['origins_mapped'] > 100
        assert source['ssrc'] == record['ssrc']
        if source['origins_mapped']:
            assert any(s['channels'] == 2 for s in source['origin_observations'])
        assert all(s['origin_ntp_us'] > 0 for s in source['origin_observations'])
    browser = json.loads((lab / 'evidence' / (name + '-browser.json')).read_text())
    relay = json.loads((lab / 'evidence' / (name + '-packet.json')).read_text())
    assert browser['return_transport_observed'] and not browser['physical_speaker_playout_used']
    if name.endswith('jitter'):
        assert relay['profile'] == 'audio-jitter'
        affected = [s for kind,s in relay['packets'].items() if kind.endswith(':audio')]
        assert affected and sum(s['delayed'] for s in affected) > 100
        assert sum(s['dropped'] for s in affected) > 5
    if name.endswith('step-jitter'):
        assert all(s['consecutive_mapped_pairs'] > 100 for s in sources)
        assert all(s['first_mapped_sequence'] > 1 for s in sources)
    results.append({'run':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'generations':len(sources),'mapped_blocks':sum(s['origins_mapped'] for s in sources),
        'native_pcm_blocks':sum(s['blocks_consumed'] for s in sources),
        'nonzero_pcm_blocks':sum(s['nonzero_pcm_blocks'] for s in sources),
        'native_pcm_accounting_verified':True,'online_mapping_verified':True,
        'native_pull_contention':mixer['contention_dropped'],
        'clock_resets':sum(s['clock_resets'] for s in sources),
        'max_origin_step_error_vs_10ms_pcm_us':max(s.get('max_origin_step_error_vs_10ms_pcm_us',0) for s in sources),
        'obs_synchronization_qualified':False})
(lab / 'evidence/decoded-pcm-verification.json').write_text(json.dumps(results,indent=2)+'\n')
print('Verified paired native PCM, online origin mapping, retirement and measured audio impairment')
