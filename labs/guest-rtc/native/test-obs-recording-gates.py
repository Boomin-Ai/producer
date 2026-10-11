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

    def test_complete_local_measurement(self):
        self.assertTrue(gates.evaluate(self.report(), self.markers(), 1)['local_obs_acceptance_passed'])

    def test_good_sync_does_not_hide_slow_readiness(self):
        self.assertFalse(gates.evaluate(self.report(6000000), self.markers(), 1)['local_obs_acceptance_passed'])

    def test_missing_both_streams_is_not_loss_free(self):
        markers = self.markers(); markers['missing_video_labels_within_observed_span'] = [7, 8]
        self.assertFalse(gates.evaluate(self.report(), markers, 1)['local_obs_acceptance_passed'])

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


if __name__ == '__main__': unittest.main()
