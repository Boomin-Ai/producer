"""Verify bounded playback and trace timing without treating a local pass as G1."""
import hashlib
import json
from pathlib import Path

lab = Path(__file__).resolve().parents[1]
results = []
bootstrap_exercised = {"audio": False, "video": False}

def pair(left, right, key, window):
    used = set()
    matches = []
    for entry in left:
        candidates = [i for i, value in enumerate(right)
                      if i not in used and abs(value[key] - entry[key]) < window]
        if candidates:
            index = min(candidates, key=lambda i: abs(right[i][key] - entry[key]))
            used.add(index)
            matches.append((entry, right[index]))
    return matches, len(left) - len(matches), len(right) - len(used)

for path in sorted((lab / 'evidence').glob('transport-obs-audio-master-*.json')):
    if path.stem.endswith(('-browser', '-packet')):
        continue
    r = json.loads(path.read_text())
    playback = r['audio_master_playback']
    mixer = r['timed_mixer_probe']
    assert playback['clock']['audio_master'] and not playback['obs_sync_qualified']
    clock = playback['clock']
    if 'failure_reasons' in clock:
        reasons = clock['failure_reasons']
        assert sum(n for reason, n in reasons.items() if reason.startswith('video_')) == clock['video_rejected']
        assert sum(reasons.get(reason, 0) for reason in ['binding_clear', 'audio_generation_changed',
            'audio_deadline_out_of_bounds', 'audio_sequence_regressed']) == clock['clock_resets']
        assert len(clock['diagnostics']) <= 64
        assert all(event['reason'] in reasons and event['repetitions'] > 0 for event in clock['diagnostics'])
    assert not r['g1_complete'] and not r['obs_recording']['qualified']
    if 'video_max_lead_ms' in clock:
        bound = clock['video_max_lead_ms']
        assert bound in [250, 400]
        assert clock['video_observed_max_lead_us'] <= bound * 1000
        if clock['video_submitted']:
            assert 0 <= clock['video_mean_lead_us'] <= clock['video_observed_max_lead_us']
        queue = playback['video_presentation_queue_after_shutdown']
        assert queue['capacity'] == (14 if bound == 400 else 8)
    if 'audio_labels' in playback:
        labels = playback['audio_labels']
        assert labels['observations_only'] and labels['capacity'] == 192
        assert len(labels['points']) <= labels['capacity']
        assert labels['observations'] >= len(labels['points'])
        assert all(abs(p['label_step_error_us']) <= labels['max_label_step_error_us'] and
            abs(p['label_shift_since_start_us']) <= labels['max_label_shift_us'] for p in labels['points'])
    if 'startup_milestones' in playback:
        milestones = playback['startup_milestones']
        assert len(milestones) <= playback['startup_milestone_capacity'] == 64
        keys = [(p['binding_since_us'], p['milestone']) for p in milestones]
        assert len(keys) == len(set(keys))
        assert all(p['since_binding_us'] == p['observed_us'] - p['binding_since_us'] >= 0 for p in milestones)
        assert any(p['milestone'] == 'first_audio_scheduled' for p in milestones)
        assert any(p['milestone'] == 'first_video_scheduled' for p in milestones)
    if playback.get('audio_labels', {}).get('reanchors_segmented'):
        points = playback['audio_labels']['points']
        assert all(p['epoch'] <= playback['audio_labels']['presentation_epochs'] for p in points)
        for previous, current in zip(points, points[1:]):
            assert current['epoch'] >= previous['epoch']
            if current['epoch'] != previous['epoch']:
                assert current['label_step_error_us'] == current['label_shift_since_start_us'] == 0
    if 'binding_discovery_after_shutdown' in playback:
        discovery = playback['binding_discovery_after_shutdown']
        assert discovery['capacity'] == 1 and discovery['peak_active'] <= 1
        assert discovery['active'] == 0 and discovery['spawned'] > 0
        assert discovery['spawned'] == discovery['completed'] + discovery['cancelled'] + discovery['failed']
        assert discovery['timed_out'] <= discovery['completed']
        assert discovery['stale_epoch_results'] <= discovery['completed']
        assert discovery['overall_timeout_ms'] == 250
        assert not discovery['presentation_loop_awaits_stats']
    if playback.get('first_report_bootstrap', False):
        assert 'five-second bound' in playback['startup_policy']
        # Enabling bootstrap does not require using it: a fresh two-report
        # map may already be ready when the other track starts presentation.
        for kind, field in [('audio', 'audio_bootstrap_blocks'), ('video', 'video_bootstrap_frames')]:
            assert isinstance(playback[field], int) and playback[field] >= 0
            bootstrap_exercised[kind] |= playback[field] > 0
        assert not clock['sender_capture_time_qualified']
    assert playback['audio_binding'] and playback['video_binding']
    assert mixer['sources_alive'] == 0 and mixer['sources_created'] == mixer['sources_destroyed']
    for source in mixer['sources']:
        assert not source['active'] and source['pcm_pending'] == 0
        assert source['frames'] == sum(source[k] for k in
            ['pcm_consumed', 'pcm_overflow', 'pcm_stale', 'pcm_retired', 'pcm_format_rejected'])
    assert r['audio_worker_lifecycle']['alive_after_retirement'] == 0
    if playback.get('scheduled_handoff', False):
        for kind in ['audio', 'video']:
            queue = playback[f'{kind}_presentation_queue_after_shutdown']
            assert queue['pending'] == 0
            assert queue['pushed'] == sum(queue[k] for k in ['submitted', 'overflow', 'late', 'flushed', 'pending'])
    suffix = path.stem.removeprefix('transport-')
    analysis = json.loads((lab / 'evidence' / f'{suffix}-markers.json').read_text())
    browser = json.loads(path.with_name(path.stem + '-browser.json').read_text())
    assert browser['return_transport_observed'] and not browser['physical_speaker_playout_used']
    summary = {'run': path.stem, 'evidence_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'recorded_abs_p95_ms': analysis['recorded_av_abs_p95_ms'],
        'matched_markers': len(analysis['pairs']),
        'unmatched_audio': analysis['unmatched_audio_markers'],
        'unmatched_video': analysis['unmatched_video_markers'],
        'local_marker_gate_passed': analysis['observed_marker_test_pass'],
        'bounded_accounting_verified': True, 'g1_complete': False}
    probe = r['obs_recording'].get('raw_video_pipeline_probe')
    if probe:
        assert probe['callbacks_quiescent_after_unregister'] and not probe['registered']
        assert probe['overflow'] == 0 and probe.get('audio_overflow', 0) == 0
        lifecycle = r['audio_worker_lifecycle']['pipeline_probe_lifecycle']
        assert lifecycle['alive'] == 0 and lifecycle['created'] == lifecycle['destroyed']
        trace = []
        for kind, field in [('audio', 'audio_markers'), ('video', 'markers')]:
            if field not in probe:
                continue
            inputs = [dict(m, timestamp_ns=m['obs_target_ns'])
                      for m in playback['input_marker_deadlines'] if m['kind'] == kind]
            pairs, missing, extra = pair(inputs, probe[field], 'timestamp_ns', 400_000_000)
            trace.append({'kind': kind, 'input_to_raw_output_ms':
                [(out['timestamp_ns'] - inp['timestamp_ns']) / 1e6 for inp, out in pairs],
                'unmatched_input': missing, 'unmatched_output': extra})
        summary['raw_pipeline_trace'] = trace
        if 'audio_markers' in probe:
            pairs, missing, extra = pair(probe['audio_markers'], probe['markers'], 'timestamp_ns', 400_000_000)
            raw_offsets = [(v['timestamp_ns'] - a['timestamp_ns']) / 1e6 for a, v in pairs]
            summary['raw_video_minus_audio_ms'] = raw_offsets
            summary['raw_unmatched_audio'] = missing
            summary['raw_unmatched_video'] = extra
            # Only compare ordered pulse lists when every level has complete matching.
            if not missing and not extra and not summary['unmatched_audio'] and not summary['unmatched_video'] and len(raw_offsets) == len(analysis['pairs']):
                summary['recording_minus_raw_offset_ms'] = [
                    recorded['video_minus_audio_ms'] - raw
                    for recorded, raw in zip(analysis['pairs'], raw_offsets)]
    results.append(summary)
for name in ['obs-pipeline-lifecycle', 'obs-media-pipeline-lifecycle']:
    cycles = json.loads((lab / 'evidence' / f'{name}.json').read_text())
    assert len(cycles['cycles']) == 4 and cycles['cycles'][-1]['cancelled']
    for cycle in cycles['cycles']:
        counters = cycle['probe_lifecycle']
        assert counters['alive'] == 0 and counters['created'] == counters['destroyed']
        assert cycle['threads_after_shutdown'] <= cycles['warm_threads'] + 2
        assert cycle['fds_after_shutdown'] <= cycles['warm_fds'] + 2
        if cycle['finish']:
            assert cycle['finish']['raw_video_pipeline_probe']['callbacks_quiescent_after_unregister']
    if name == 'obs-media-pipeline-lifecycle':
        partial = cycles['partial_initialization']
        assert partial['injected_after_callback_registration']
        assert partial['probe_lifecycle']['alive'] == 0
        assert partial['probe_lifecycle']['created'] == partial['probe_lifecycle']['destroyed']
        assert partial['threads_after_shutdown'] <= cycles['warm_threads'] + 2
        assert partial['fds_after_shutdown'] <= cycles['warm_fds'] + 2
(lab / 'evidence/audio-master-verification.json').write_text(json.dumps(results, indent=2) + '\n')
print(f'Verified {len(results)} recorded runs, queue accounting, probe retirement and preserved qualification failures')

assert all(bootstrap_exercised.values()), "Archived fixtures must exercise both bootstrap paths"
