"""Read CLI credentials into memory; never print keys or persist an env copy."""
import re
import shlex
import subprocess


def parse_environment(text):
    values = {}
    for line in text.splitlines():
        key, separator, value = line.partition('=')
        if separator and key in ('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'):
            parts = shlex.split(value)
            if len(parts) != 1:
                raise ValueError('Invalid CLI credential format')
            values[key] = parts[0]
    if not all(values.get(k) for k in ('LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET')):
        raise ValueError('CLI project credentials are incomplete')
    if not re.fullmatch(r'wss://[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.livekit\.cloud', values['LIVEKIT_URL']):
        raise ValueError('Expected an exact LiveKit Cloud TLS project URL')
    return values


def credentials(project, directory):
    result = subprocess.run(['lk', '--quiet', '--project', project, 'app', 'env', str(directory)],
                            capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=20)
    if result.returncode:
        raise RuntimeError('LiveKit CLI project credential lookup failed')
    return parse_environment(result.stdout)
