"""Correlate generated guest audio SR receipt and native subscriber admission."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path

lab = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('run')
args = parser.parse_args()
if not args.run.startswith('generated-recovery-') or not all(c.isalnum() or c == '-' for c in args.run):
    parser.error('Expected generated recovery run name')
log = lab / 'runtime' / f'{args.run}-sfu.log'
report_path = lab / 'evidence' / f'{args.run}.json'
report = json.loads(report_path.read_text())
rows = []
for line in log.read_text().splitlines():
    for kind in ('lab early audio sender report request', 'lab subscriber audio sender report request', 'lab buffer sender report received', 'downtrack added', 'lab publisher sender report'):
        separator = '\t' + kind + '\t'
        if separator not in line: continue
        event = json.loads(line.split(separator, 1)[1])
        if kind not in ('lab publisher sender report', 'downtrack added') and event.get('mime') != 'audio/opus': continue
        wall = event.get('lab_wall_us')
        if wall is None:
            wall = round(datetime.datetime.strptime(line.split('\t')[0], '%Y-%m-%dT%H:%M:%S.%f%z').timestamp() * 1e6)
        rows.append(dict(event, event=kind, wall_us=wall))
tracks = sorted({row['trackID'] for row in rows if row['event'] == 'lab buffer sender report received' and row.get('participant', '').startswith('guest-')})
summaries = []
for track in tracks:
    events = [row for row in rows if row.get('trackID') == track]
    receipts = [row for row in events if row['event'] == 'lab buffer sender report received']
    forwards = [row for row in events if row['event'] == 'lab publisher sender report' and row.get('participant') == 'native-host']
    subscriber_ids = {row.get('subscriberID') for row in forwards}
    additions = [row for row in events if row['event'] == 'downtrack added' and row.get('subscriberID') in subscriber_ids]
    first = receipts[0]
    summaries.append({'track_id': track, 'publisher': first['participant'],
        'first_receipt_subscribers': first['lab_subscribers'],
        'subscriber_requests': [{'sfu_wall_us': row['wall_us'], 'number_in_budget_window': row['lab_request_number']} for row in events if row['event'] == 'lab subscriber audio sender report request'],
        'first_receipt_sfu_wall_us': first['wall_us'],
        'first_native_forward_after_initial_receipt_ms': (forwards[0]['wall_us'] - first['wall_us']) / 1000 if forwards else None,
        'native_admissions': [{'added_sfu_wall_us': added['wall_us'],
            'first_forward_after_add_ms': next(((row['wall_us'] - added['wall_us']) / 1000 for row in forwards if row['wall_us'] >= added['wall_us'] and row.get('subscriberID') == added.get('subscriberID')), None)} for added in additions]})
acceptance_spec = __import__('importlib.util', fromlist=['util'])
spec = acceptance_spec.spec_from_file_location('obs_gates', lab / 'native/obs-recording-gates.py')
gates = acceptance_spec.module_from_spec(spec); spec.loader.exec_module(gates)
conditions = json.loads((lab / 'evidence' / f'{args.run}-conditions.json').read_text())
markers = json.loads((lab / 'evidence' / f'{args.run}-obs-numbered.json').read_text())
acceptance = gates.evaluate(report, markers, 1 + (conditions['reconnect_count'] if conditions['reconnect'] == 'full' else 0))
(lab / 'evidence' / f'{args.run}-obs-acceptance.json').write_text(json.dumps(acceptance, indent=2) + '\n')
output = {'run': args.run, 'sfu_trace_sha256': hashlib.sha256(log.read_bytes()).hexdigest(),
    'native_report_sha256': hashlib.sha256(report_path.read_bytes()).hexdigest(), 'guest_audio_tracks': summaries,
    'clock_domains': 'Receipt/admission deltas use SFU wall time only. Native readiness uses per-binding monotonic intervals only. No subtraction across clock domains.',
    'interpretation': 'Reports received without subscribers cannot initialize a subsequently bound downstream. A fresh post-switch report is still required by the upstream timestamp-offset validity guard; cached report seeding alone is insufficient.',
    'g1_complete': False}
(lab / 'evidence' / f'{args.run}-subscription-order.json').write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps(output, indent=2))
