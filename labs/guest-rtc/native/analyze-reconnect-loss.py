"""Keep reconnect loss gates intact; correlate source labels without mixing clocks."""
import argparse
import hashlib
import json
from pathlib import Path


def output_outcomes(playback, stream, receipts):
    trace = playback.get(f'{stream}_output_marker_trace')
    events = trace.get('events', []) if isinstance(trace, dict) else []
    rows = []
    for receipt in receipts:
        label = receipt.get('label' if stream == 'video' else 'id_mod16')
        target = receipt.get('scheduled_target_ns')
        epoch = receipt.get('publication_epoch')
        outcomes = [e for e in events if target is not None and epoch is not None
            and e.get('label') == label and e.get('scheduled_target_ns') == target
            and e.get('publication_epoch') == epoch]
        rows.append({'receipt': receipt, 'outcomes': outcomes})
    return {'evidence_available': isinstance(trace, dict),
            'trace_overflow': trace.get('overflow') if isinstance(trace, dict) else None,
            'receipts': rows,
            'scope': 'Exact label, original OBS-clock target and publication epoch only. Native submission is not proof of successful recording.'}


def analyze(native, browser, markers):
    selected = next((r for r in browser.get('reports', []) if r.get('identity') == 'guest-1'), {})
    source = selected.get('source_markers')
    missing = markers.get('missing_video_labels_within_observed_span', [])
    paired = {p['id'] for p in markers.get('pairs', [])}
    unpaired = sorted({v['id'] for v in markers.get('video_markers', []) if v['id'] not in paired})
    lost = []
    playback = native.get('audio_master_playback', {})
    for label in sorted(set(missing) | set(unpaired)):
        row = {'label': label, 'source_evidence_available': isinstance(source, dict),
               'video_missing_from_recording': label in missing, 'recorded_video_unpaired': label in unpaired,
               'cause': 'unresolved; source generation alone does not prove delivery'}
        for kind in ('audio', 'video'):
            observed = [m for m in (source or {}).get(kind, []) if m['id'] == label]
            row[f'source_{kind}_observations'] = observed
        row['both_generated_at_source'] = bool(row['source_audio_observations'] and row['source_video_observations'])
        receipts = native.get('audio_master_playback', {}).get('decoded_video_marker_receipts', [])
        row['native_video_receipts'] = [r for r in receipts if r['label'] == label]
        row['native_video_received'] = bool(row['native_video_receipts'])
        row['native_video_scheduled_by_clock'] = any(r.get('scheduled_target_ns') is not None for r in row['native_video_receipts'])
        row['audio_receipt_evidence_available'] = 'decoded_audio_marker_receipts' in playback
        row['native_audio_receipts_near_video'] = [a for a in playback.get('decoded_audio_marker_receipts', [])
            if a['id_mod16'] == label % 16 and any(a['binding_since_us'] == v['binding_since_us'] and abs(a['received_us']-v['received_us'])<=120000 for v in row['native_video_receipts'])]
        row['native_video_output'] = output_outcomes(playback, 'video', row['native_video_receipts'])
        row['native_audio_output'] = output_outcomes(playback, 'audio', row['native_audio_receipts_near_video'])
        lost.append(row)
    epochs = {}
    for event in native.get('audio_master_playback', {}).get('startup_milestones', []):
        epoch = epochs.setdefault(event['binding_since_us'], {'binding_since_us': event['binding_since_us'], 'milestones_ms': {}})
        epoch['milestones_ms'][event['milestone']] = event['since_binding_us'] / 1000
    injections = [e for e in native.get('lifecycle', []) if e.get('event') == 'reconnect_injected']
    triggered = [e for e in injections if e.get('input_pulse_trigger') is not None]
    receipts = native.get('audio_master_playback', {}).get('decoded_video_marker_receipts', [])
    pulse_verified = bool(triggered) and len(triggered) == len(injections) and all(
        isinstance(e['input_pulse_trigger'], list) and len(e['input_pulse_trigger']) == 2
        and any([r['label'], r['received_us']] == e['input_pulse_trigger'] for r in receipts)
        for e in triggered)
    queued = [e for e in injections if e.get('queued_av_pulse_trigger') is not None]
    queued_verified = bool(queued) and len(queued) == len(injections) and all(
        isinstance(e['queued_av_pulse_trigger'], list) and len(e['queued_av_pulse_trigger']) == 3
        and any(v.get('output_accepted') is True and [v['label'],v['received_us']] == e['queued_av_pulse_trigger'][:2]
            and any(a.get('output_accepted') is True and a['id_mod16'] == v['label']%16
                and a['received_us'] == e['queued_av_pulse_trigger'][2]
                and a['binding_since_us'] == v['binding_since_us']
                and abs(a['received_us']-v['received_us'])<=120000
                for a in playback.get('decoded_audio_marker_receipts', [])) for v in receipts)
        for e in queued)
    injection_outcomes = []
    for e in queued:
        pulse = e['queued_av_pulse_trigger']
        if not isinstance(pulse, list) or len(pulse) != 3: continue
        video = [v for v in receipts if [v['label'],v['received_us']] == pulse[:2]]
        audio = [a for a in playback.get('decoded_audio_marker_receipts', [])
                 if a['id_mod16'] == pulse[0]%16 and a['received_us'] == pulse[2]
                 and any(a['binding_since_us'] == v['binding_since_us'] for v in video)]
        injection_outcomes.append({'label': pulse[0], 'video': output_outcomes(playback, 'video', video),
                                   'audio': output_outcomes(playback, 'audio', audio)})
    return {'missing_recorded_labels': lost, 'binding_readiness': list(epochs.values()),
            'injected_marker_output_outcomes': injection_outcomes,
            'pulse_trigger_receipts_verified': pulse_verified,
            'queued_av_trigger_receipts_verified': queued_verified,
            'unmatched_recorded_video_labels': unpaired,
            'native_reconnect_events': [e for e in native.get('lifecycle', []) if e.get('event') in ('reconnect_injected', 'reconnecting', 'reconnected')],
            'source_errors': source.get('errors') if isinstance(source, dict) else None,
            'loss_gate_relaxed': False, 'transport_loss_proven': False, 'g1_complete': False,
            'clock_domains': 'Label identity joins only. Readiness is within each native binding monotonic epoch. Source AudioContext, lifecycle and OBS PTS are not subtracted from one another.',
            'scope': 'Selected guest-1 only. A decoded receipt proves this video label reached the playback kernel; a clock target does not prove native submission or recording. Audio receipt and final drop causality remain separate.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run')
    args = parser.parse_args()
    if not args.run.startswith('generated-recovery-') or not args.run.removeprefix('generated-recovery-').isdigit():
        parser.error('Expected generated recovery run name')
    evidence = Path(__file__).resolve().parents[1] / 'evidence'
    paths = [evidence / f'{args.run}{suffix}.json' for suffix in ('', '-browser', '-obs-numbered')]
    result = analyze(*(json.loads(p.read_text()) for p in paths))
    result['run'] = args.run
    result['input_sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    (evidence / f'{args.run}-reconnect-loss.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'run': args.run, 'missing': result['missing_recorded_labels'], 'loss_gate_relaxed': False}))
    conditions = json.loads((evidence / f'{args.run}-conditions.json').read_text())
    if conditions.get('reconnect_on_input_pulse') and not result['pulse_trigger_receipts_verified']:
        raise SystemExit('Requested pulse-overlap injections lack matching native decode receipts')
    if conditions.get('reconnect_on_queued_pulse') and not result['queued_av_trigger_receipts_verified']:
        raise SystemExit('Requested queued A/V overlap lacks matching accepted decode receipts')


if __name__ == '__main__':
    main()
