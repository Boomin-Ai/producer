"""Keep reconnect loss gates intact; correlate source labels without mixing clocks."""
import argparse
import hashlib
import json
from pathlib import Path


def analyze(native, browser, markers):
    selected = next((r for r in browser.get('reports', []) if r.get('identity') == 'guest-1'), {})
    source = selected.get('source_markers')
    missing = markers.get('missing_video_labels_within_observed_span', [])
    lost = []
    for label in missing:
        row = {'label': label, 'source_evidence_available': isinstance(source, dict),
               'cause': 'unresolved; source generation alone does not prove delivery'}
        for kind in ('audio', 'video'):
            observed = [m for m in (source or {}).get(kind, []) if m['id'] == label]
            row[f'source_{kind}_observations'] = observed
        row['both_generated_at_source'] = bool(row['source_audio_observations'] and row['source_video_observations'])
        lost.append(row)
    epochs = {}
    for event in native.get('audio_master_playback', {}).get('startup_milestones', []):
        epoch = epochs.setdefault(event['binding_since_us'], {'binding_since_us': event['binding_since_us'], 'milestones_ms': {}})
        epoch['milestones_ms'][event['milestone']] = event['since_binding_us'] / 1000
    return {'missing_recorded_labels': lost, 'binding_readiness': list(epochs.values()),
            'native_reconnect_events': [e for e in native.get('lifecycle', []) if e.get('event') in ('reconnect_injected', 'reconnecting', 'reconnected')],
            'source_errors': source.get('errors') if isinstance(source, dict) else None,
            'loss_gate_relaxed': False, 'transport_loss_proven': False, 'g1_complete': False,
            'clock_domains': 'Label identity joins only. Readiness is within each native binding monotonic epoch. Source AudioContext, lifecycle and OBS PTS are not subtracted from one another.',
            'scope': 'Selected guest-1 only; missing audio/video marker causality remains open until packet/decode evidence establishes receipt.'}


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


if __name__ == '__main__':
    main()
