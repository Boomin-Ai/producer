import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('gates', Path(__file__).with_name('obs-recording-gates.py'))
gates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gates)


class RecordingGates(unittest.TestCase):
    def report(self, delay=1000000):
        return {'audio_master_playback': {'startup_milestones': [
            {'binding_since_us': 1, 'milestone': 'audio_bound', 'since_binding_us': 0},
            {'binding_since_us': 1, 'milestone': 'first_audio_scheduled', 'since_binding_us': delay},
            {'binding_since_us': 1, 'milestone': 'first_video_scheduled', 'since_binding_us': delay}]}}

    def markers(self):
        return {'local_numbered_marker_gate_passed': True,
                'missing_video_labels_within_observed_span': [], 'audio_pts_discontinuities': 0}

    def with_workers(self):
        native = self.report(); playback = native['audio_master_playback']
        playback['delivery_on_dedicated_threads'] = True
        for stream in ('audio', 'video'):
            playback[f'{stream}_presentation_queue_after_shutdown'] = {'active_after_shutdown': False, 'worker_failed': False, 'pending': 0}
        playback['decoded_audio_drain_after_shutdown'] = {'active_after_shutdown': False, 'worker_failed': False, 'queue': {'pending_frames': 0}}
        return native

    def test_declared_shutdown_drain_must_finish_with_input_sealed(self):
        native = self.with_workers(); playback = native['audio_master_playback']
        playback['scheduled_output_drain_required'] = True
        for stream in ('audio', 'video'):
            playback[f'{stream}_presentation_queue_after_shutdown']['sealed_for_finish'] = True
        self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_obs_acceptance_passed'])
        valid = {'timed_out': False, 'new_input_sealed': True, 'pending_after_audio_video': [0, 0]}
        playback['scheduled_output_drain'] = valid.copy()
        self.assertTrue(gates.evaluate(native, self.markers(), 1)['local_obs_acceptance_passed'])
        for field, value in [('timed_out', True), ('new_input_sealed', False), ('pending_after_audio_video', [1, 0])]:
            playback['scheduled_output_drain'] = {**valid, field: value}
            self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_obs_acceptance_passed'])

        playback['scheduled_output_drain'] = valid.copy()
        for stream in ('audio', 'video'):
            output = playback[f'{stream}_presentation_queue_after_shutdown']
            output['sealed_for_finish'] = False
            self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_obs_acceptance_passed'])
            output['sealed_for_finish'] = True

    def test_clock_worker_health_is_required_for_isolated_playback(self):
        native = self.with_workers()
        playback = native['audio_master_playback']
        playback['clock_on_dedicated_thread'] = True
        self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_obs_acceptance_passed'])
        playback['dedicated_clock_worker'] = {'active_after_shutdown': False, 'worker_failed': False}
        self.assertTrue(gates.evaluate(native, self.markers(), 1)['local_obs_acceptance_passed'])
        for field in ('active_after_shutdown', 'worker_failed'):
            playback['dedicated_clock_worker'][field] = True
            self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_obs_acceptance_passed'])
            playback['dedicated_clock_worker'][field] = False

    def test_delivery_workers_are_required_to_stop_cleanly(self):
        self.assertTrue(gates.evaluate(self.with_workers(), self.markers(), 1)['local_obs_acceptance_passed'])
        for stream in ('audio', 'video'):
            for field, value in [('active_after_shutdown', True), ('worker_failed', True), ('pending', 1)]:
                native = self.with_workers()
                native['audio_master_playback'][f'{stream}_presentation_queue_after_shutdown'][field] = value
                result = gates.evaluate(native, self.markers(), 1)
                self.assertFalse(result['local_obs_acceptance_passed'])
                self.assertTrue(result['local_readiness_gate_passed'])
                self.assertFalse(result['local_delivery_worker_gate_passed'])

    def test_missing_or_retained_decoded_drain_cannot_qualify(self):
        for field, value in [('active_after_shutdown', True), ('worker_failed', True), ('queue', {'pending_frames': 1}), ('queue', None)]:
            native = self.with_workers()
            native['audio_master_playback']['decoded_audio_drain_after_shutdown'][field] = value
            self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_obs_acceptance_passed'])
        native = self.with_workers(); native['audio_master_playback'].pop('decoded_audio_drain_after_shutdown')
        self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_obs_acceptance_passed'])

    def test_complete_local_measurement(self):
        self.assertTrue(gates.evaluate(self.report(), self.markers(), 1)['local_obs_acceptance_passed'])
        self.assertTrue(gates.evaluate(self.report(), self.markers(), 1)['local_readiness_gate_passed'])

    def test_good_sync_does_not_hide_slow_readiness(self):
        self.assertFalse(gates.evaluate(self.report(6000000), self.markers(), 1)['local_obs_acceptance_passed'])
        self.assertFalse(gates.evaluate(self.report(6000000), self.markers(), 1)['local_readiness_gate_passed'])

    def test_missing_both_streams_is_not_loss_free(self):
        markers = self.markers(); markers['missing_video_labels_within_observed_span'] = [7, 8]
        self.assertFalse(gates.evaluate(self.report(), markers, 1)['local_obs_acceptance_passed'])
        self.assertTrue(gates.evaluate(self.report(), markers, 1)['local_readiness_gate_passed'])

    def test_missing_recovery_epoch(self):
        self.assertFalse(gates.evaluate(self.report(), self.markers(), 2)['local_obs_acceptance_passed'])

    def test_incomplete_epoch(self):
        native = self.report(); native['audio_master_playback']['startup_milestones'].pop()
        self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_obs_acceptance_passed'])

    def test_invalid_delay(self):
        for delay in (-1, float('nan'), float('inf'), None, True):
            self.assertFalse(gates.evaluate(self.report(delay), self.markers(), 1)['local_obs_acceptance_passed'])

    def test_missing_analysis_and_pts_gap(self):
        self.assertFalse(gates.evaluate(self.report(), {}, 1)['local_obs_acceptance_passed'])
        markers = self.markers(); markers['audio_pts_discontinuities'] = 1
        self.assertFalse(gates.evaluate(self.report(), markers, 1)['local_obs_acceptance_passed'])

    def with_partial(self, later_binding=100001):
        native = self.report()
        for row in native['audio_master_playback']['startup_milestones']:
            row['binding_since_us'] = later_binding
        native['audio_master_playback']['startup_milestones'].insert(0, {
            'binding_since_us': 1, 'milestone': 'audio_bound', 'since_binding_us': 0})
        return native

    def test_partial_pair_replacement_is_retained_and_coalesced(self):
        result = gates.evaluate(self.with_partial(), self.markers(), 1)
        self.assertTrue(result['local_readiness_gate_passed'])
        self.assertEqual(result['superseded_binding_epochs'], [1])
        self.assertEqual(result['binding_epochs'][0]['first_scheduled_ms']['audio'], 1100)

    def test_reset_does_not_restart_latency_budget(self):
        result = gates.evaluate(self.with_partial(2000001), self.markers(), 1)
        self.assertFalse(result['local_readiness_gate_passed'])
        self.assertEqual(result['binding_epochs'][0]['first_scheduled_ms']['audio'], 3000)

    def test_unfinished_final_reset_cannot_hide_behind_earlier_output(self):
        native = self.report()
        native['audio_master_playback']['startup_milestones'].append({
            'binding_since_us': 2000001, 'milestone': 'audio_bound', 'since_binding_us': 0})
        self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_readiness_gate_passed'])

    def test_extra_completed_reset_is_not_silently_coalesced(self):
        native = self.report()
        native['audio_master_playback']['startup_milestones'] += [dict(row, binding_since_us=2000001)
            for row in list(native['audio_master_playback']['startup_milestones'])]
        self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_readiness_gate_passed'])

    def test_invalid_superseded_readiness_is_still_rejected(self):
        native = self.with_partial()
        native['audio_master_playback']['startup_milestones'].insert(0, {
            'binding_since_us': 1, 'milestone': 'first_audio_scheduled', 'since_binding_us': -1})
        self.assertFalse(gates.evaluate(native, self.markers(), 1)['local_readiness_gate_passed'])


if __name__ == '__main__': unittest.main()
