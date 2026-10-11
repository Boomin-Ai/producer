"""Acceptance for generated native OBS recordings; transport success is separate."""
import math


def evaluate(native, markers, expected_epochs, readiness_budget_ms=1500):
    milestones = native.get('audio_master_playback', {}).get('startup_milestones', [])
    epochs = {}
    for item in milestones:
        binding = item.get('binding_since_us')
        if isinstance(binding, int) and not isinstance(binding, bool):
            epochs.setdefault(binding, {})[item.get('milestone')] = item.get('since_binding_us')
    measured = []
    reasons = []
    if len(epochs) != expected_epochs:
        reasons.append('binding epoch count differs from expected')
    for binding, values in sorted(epochs.items()):
        delays = {}
        for stream in ('audio', 'video'):
            value = values.get(f'first_{stream}_scheduled')
            valid = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
            delays[stream] = value / 1000 if valid else None
            if not valid:
                reasons.append(f'epoch {binding}: missing or invalid {stream} readiness')
            elif value / 1000 > readiness_budget_ms:
                reasons.append(f'epoch {binding}: {stream} readiness exceeded budget')
        measured.append({'binding_since_us': binding, 'first_scheduled_ms': delays})
    if markers.get('local_numbered_marker_gate_passed') is not True:
        reasons.append('numbered recording marker gate failed')
    missing = markers.get('missing_video_labels_within_observed_span')
    if not isinstance(missing, list) or missing:
        reasons.append('missing marker labels within observed recording span')
    if markers.get('audio_pts_discontinuities') != 0:
        reasons.append('audio presentation timestamp continuity not established')
    return {'local_obs_acceptance_passed': not reasons, 'failure_reasons': reasons,
            'binding_epochs': measured, 'expected_binding_epochs': expected_epochs,
            'readiness_budget_ms': readiness_budget_ms,
            'budget_scope': 'prototype local per-binding readiness, not WAN service guarantee',
            'startup_and_tail_loss_qualified': False, 'lip_sync_qualified': False, 'g1_complete': False}
