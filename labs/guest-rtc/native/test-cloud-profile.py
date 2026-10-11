import unittest
from cloud_profile import parse_environment


class ProfileTests(unittest.TestCase):
    def test_quoted_values_are_parsed_without_shell_expansion(self):
        values = parse_environment('LIVEKIT_URL="wss://test-rtc.livekit.cloud"\nLIVEKIT_API_KEY=dummy\nLIVEKIT_API_SECRET="$(dummy)"\n')
        self.assertEqual(values['LIVEKIT_API_SECRET'], '$(dummy)')

    def test_incomplete_or_non_project_credentials_are_rejected(self):
        prefix = 'LIVEKIT_API_KEY=dummy\nLIVEKIT_API_SECRET=dummy\nLIVEKIT_URL='
        for url in ['ws://test.livekit.cloud', 'wss://test.livekit.cloud.evil', 'wss://user@test.livekit.cloud', 'wss://test.livekit.cloud?token=dummy']:
            with self.assertRaises(ValueError): parse_environment(prefix + url)
        with self.assertRaises(ValueError): parse_environment('LIVEKIT_URL=wss://test.livekit.cloud')


if __name__ == '__main__': unittest.main()
