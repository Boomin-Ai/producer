import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('reconnect_loss', Path(__file__).with_name('analyze-reconnect-loss.py'))
loss = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loss)


class EvidenceTests(unittest.TestCase):
    def test_final_outcome_join_requires_exact_clock_target_and_publication_epoch(self):
        receipt = {'id_mod16':7, 'scheduled_target_ns':5000, 'publication_epoch':3}
        events = [dict(label=7, scheduled_target_ns=5001, publication_epoch=3, disposition='submitted'),
                  dict(label=7, scheduled_target_ns=5000, publication_epoch=4, disposition='submitted'),
                  dict(label=7, scheduled_target_ns=5000, publication_epoch=3, disposition='clock_reanchor')]
        result = loss.output_outcomes({'audio_output_marker_trace':{'events':events, 'overflow':0}}, 'audio', [receipt])
        self.assertEqual(result['receipts'][0]['outcomes'], [events[2]])
        self.assertEqual(result['trace_overflow'], 0)
        self.assertEqual(loss.output_outcomes({}, 'audio', [receipt])['receipts'][0]['outcomes'], [])
        self.assertFalse(loss.output_outcomes({}, 'audio', [receipt])['evidence_available'])
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

    def test_decoded_receipt_and_clock_admission_are_separate(self):
        native = {'audio_master_playback': {'decoded_video_marker_receipts': [
            {'label': 7, 'scheduled_target_ns': None}, {'label': 23, 'scheduled_target_ns': 4000}]}}
        result = loss.analyze(native, {}, {'missing_video_labels_within_observed_span': [7, 23, 24]})
        rows = result['missing_recorded_labels']
        self.assertTrue(rows[0]['native_video_received'])
        self.assertFalse(rows[0]['native_video_scheduled_by_clock'])
        self.assertTrue(rows[1]['native_video_scheduled_by_clock'])
        self.assertFalse(rows[2]['native_video_received'])
        self.assertFalse(result['transport_loss_proven'])

    def test_pulse_trigger_must_match_exact_decoded_label_and_time(self):
        native = {'audio_master_playback': {'decoded_video_marker_receipts': [{'label': 7, 'received_us': 200}]},
                  'lifecycle': [{'event': 'reconnect_injected', 'input_pulse_trigger': [7, 200]}]}
        self.assertTrue(loss.analyze(native, {}, {})['pulse_trigger_receipts_verified'])
        native['lifecycle'][0]['input_pulse_trigger'] = [7, 201]
        self.assertFalse(loss.analyze(native, {}, {})['pulse_trigger_receipts_verified'])

    def test_queued_av_trigger_requires_acceptance_same_epoch_and_fresh_label_pair(self):
        video={'label':23,'received_us':200000,'binding_since_us':100,'output_accepted':True}
        audio={'id_mod16':7,'received_us':220000,'binding_since_us':100,'output_accepted':True}
        native={'audio_master_playback':{'decoded_video_marker_receipts':[video],'decoded_audio_marker_receipts':[audio]},
                'lifecycle':[{'event':'reconnect_injected','queued_av_pulse_trigger':[23,200000,220000]}]}
        self.assertTrue(loss.analyze(native,{}, {})['queued_av_trigger_receipts_verified'])
        for key,value in [('binding_since_us',101),('output_accepted',False),('id_mod16',8)]:
            old=audio[key];audio[key]=value
            self.assertFalse(loss.analyze(native,{}, {})['queued_av_trigger_receipts_verified'])
            audio[key]=old

    def test_unpaired_recorded_video_is_traced_without_being_called_missing(self):
        result=loss.analyze({}, {}, {'video_markers':[{'id':7},{'id':8}],'pairs':[{'id':7}]})
        row=result['missing_recorded_labels'][0]
        self.assertEqual(row['label'],8)
        self.assertFalse(row['video_missing_from_recording'])
        self.assertTrue(row['recorded_video_unpaired'])
        self.assertFalse(row['audio_receipt_evidence_available'])


if __name__ == '__main__':
    unittest.main()
