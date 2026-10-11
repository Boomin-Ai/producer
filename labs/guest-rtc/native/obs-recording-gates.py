"""Acceptance for generated native OBS recordings; transport success is separate."""
import math


def valid_delay(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def evaluate(native, markers, expected_epochs, readiness_budget_ms=1500):
    milestones = native.get('audio_master_playback', {}).get('startup_milestones', [])
    epochs = {}
    for item in milestones:
        binding = item.get('binding_since_us')
        if isinstance(binding, int) and not isinstance(binding, bool):
            epochs.setdefault(binding, {})[item.get('milestone')] = item.get('since_binding_us')
    measured, superseded, reasons = [], [], []
    pending = []
    # SDK audio/video subscriptions can each invalidate playback while replacing
    # the same pair. Keep every intermediate epoch, but measure completed output
    # from the FIRST pending reset; a later reset cannot restart the budget.
    for binding, values in sorted(epochs.items()):
        pending.append(binding)
        delays = {stream: values.get(f'first_{stream}_scheduled') for stream in ('audio', 'video')}
        for stream, value in delays.items():
            if value is not None and not valid_delay(value):
                reasons.append(f'epoch {binding}: invalid {stream} readiness')
        if all(valid_delay(value) for value in delays.values()):
            start = pending[0]
            adjusted = {stream: (binding - start + value) / 1000 for stream, value in delays.items()}
            for stream, delay in adjusted.items():
                if delay > readiness_budget_ms:
                    reasons.append(f'epoch {binding}: {stream} readiness exceeded budget including preceding resets')
            measured.append({'binding_since_us': binding, 'recovery_started_us': start,
                             'superseded_binding_epochs': pending[:-1], 'first_scheduled_ms': adjusted})
            superseded.extend(pending[:-1])
            pending = []
    if len(measured) != expected_epochs:
        reasons.append('completed output epoch count differs from expected')
    if pending:
        reasons.append('final binding epoch has no completed audio/video output')
    readiness_reasons = list(reasons)
    playback = native.get('audio_master_playback', {})
    worker_reasons = []
    if playback.get('delivery_on_dedicated_threads') is True:
        for stream in ('audio', 'video'):
            report = playback.get(f'{stream}_presentation_queue_after_shutdown')
            if not isinstance(report, dict) or report.get('active_after_shutdown') is not False or report.get('worker_failed') is not False or report.get('pending') != 0:
                worker_reasons.append(f'{stream} delivery worker shutdown not established')
        drain = playback.get('decoded_audio_drain_after_shutdown')
        if not isinstance(drain, dict) or drain.get('active_after_shutdown') is not False or drain.get('worker_failed') is not False or not isinstance(drain.get('queue'), dict) or drain['queue'].get('pending_frames') != 0:
            worker_reasons.append('decoded audio drain shutdown not established')
    reasons.extend(worker_reasons)
    if markers.get('local_numbered_marker_gate_passed') is not True:
        reasons.append('numbered recording marker gate failed')
    missing = markers.get('missing_video_labels_within_observed_span')
    if not isinstance(missing, list) or missing:
        reasons.append('missing marker labels within observed recording span')
    if markers.get('audio_pts_discontinuities') != 0:
        reasons.append('audio presentation timestamp continuity not established')
    return {'local_obs_acceptance_passed': not reasons, 'failure_reasons': reasons,
            'local_delivery_worker_gate_passed': not worker_reasons, 'delivery_worker_failure_reasons': worker_reasons,
            'local_readiness_gate_passed': not readiness_reasons, 'readiness_failure_reasons': readiness_reasons,
            'binding_epochs': measured, 'raw_binding_epoch_count': len(epochs),
            'superseded_binding_epochs': superseded, 'unfinished_binding_epochs': pending,
            'expected_binding_epochs': expected_epochs, 'readiness_budget_ms': readiness_budget_ms,
            'budget_scope': 'prototype local recovery from earliest pending reset, not WAN service guarantee',
            'startup_and_tail_loss_qualified': False, 'lip_sync_qualified': False, 'g1_complete': False}
