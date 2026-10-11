import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('reconnect_loss', Path(__file__).with_name('analyze-reconnect-loss.py'))
loss = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loss)


class EvidenceTests(unittest.TestCase):
    def test_missing_source_is_unknown_not_transport_loss(self):
        result = loss.analyze({}, {}, {'missing_video_labels_within_observed_span': [7]})
        self.assertFalse(result['missing_recorded_labels'][0]['source_evidence_available'])
        self.assertFalse(result['transport_loss_proven'])
        self.assertFalse(result['loss_gate_relaxed'])

    def test_exact_label_join_does_not_reuse_modulo_audio_identity(self):
        source = {'audio': [{'id': 7}, {'id': 23}], 'video': [{'id': 23}], 'errors': []}
        result = loss.analyze({}, {'reports': [{'identity': 'guest-1', 'source_markers': source}]},
                              {'missing_video_labels_within_observed_span': [7, 23]})
        self.assertFalse(result['missing_recorded_labels'][0]['both_generated_at_source'])
        self.assertTrue(result['missing_recorded_labels'][1]['both_generated_at_source'])
        self.assertFalse(result['transport_loss_proven'])

    def test_binding_delays_use_only_native_epoch_intervals(self):
        events = [{'binding_since_us': 100, 'milestone': 'audio_bound', 'since_binding_us': 5000},
                  {'binding_since_us': 900000, 'milestone': 'audio_bound', 'since_binding_us': 8000}]
        result = loss.analyze({'audio_master_playback': {'startup_milestones': events}}, {}, {})
        self.assertEqual([r['milestones_ms']['audio_bound'] for r in result['binding_readiness']], [5, 8])


if __name__ == '__main__':
    unittest.main()
