#!/usr/bin/env python3
"""Exercise bounded raw framing, large imports/replies and restart via the executor.

Only a temporary experimental store; no app profile, socket, device or output.
Concurrency/revocation/pressure tests live in service/tests/executor.rs.
"""
import argparse
import json
import subprocess
import tempfile
import time

FRAME_BYTES = 8 * 1024 * 1024 + 64 * 1024


def run(binary):
    with tempfile.TemporaryDirectory(prefix='producer-service-proof-') as store:
        process = None

        def start():
            return subprocess.Popen(
                [binary, 'serve', '--store', store, '--document-id', 'service-proof'],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        def raw(data):
            process.stdin.write(data + b'\n')
            process.stdin.flush()
            line = process.stdout.readline(FRAME_BYTES + 2)
            assert line and line.endswith(b'\n') and len(line) <= FRAME_BYTES + 1, 'bounded reply absent'
            return json.loads(line)

        def rpc(method, **kwargs):
            reply = raw(json.dumps(dict(method=method, **kwargs), separators=(',', ':')).encode())
            assert reply['ok'], reply
            return reply['result']

        def close():
            process.stdin.close()
            assert process.wait(timeout=30) == 0, process.stderr.read().decode()
            process.stdout.close()
            process.stderr.close()

        began = time.monotonic()
        try:
            process = start()
            for data, code in [
                (b'{"method":"hello","author":true}', 'STRUCTURE'),
                (b'{"method":"hello","method":"hello"}', 'RAW_JSON'),
                (b'\xff', 'RAW_UTF8'),
            ]:
                assert raw(data)['error']['code'] == code
            greeting = rpc('hello')
            session = greeting['session']
            assert rpc('services', session=session)['registeredSessions'] == 1
            document = rpc('inspect', session=session)['document']
            # Each string is within 64KiB; the document is within 4KiB of 8MiB.
            document['metadata'] = {f'pad-{n:03}': 'x' * (64 * 1024) for n in range(127)}
            target = 8 * 1024 * 1024 - 4096
            size = lambda: len(json.dumps(document, separators=(',', ':')).encode())
            document['metadata']['tail'] = 'x' * (target - size() - len(',"tail":""'))
            encoded_size = size()
            assert target - 8 <= encoded_size <= target
            command = dict(kind='import', document=document)
            ticket = rpc('issue', session=session, expected='0', command=command)['ticket']
            receipt = rpc('submit', session=session, ticket=ticket, command=command)
            assert receipt['outcome']['status'] == 'saved'
            assert rpc('submit', session=session, ticket=ticket, command=command) == receipt
            inspected = rpc('inspect', session=session)
            assert inspected['document'] == document and inspected['revision'] == '1'
            rpc('checkpoint', session=session)
            close()
            process = start()
            greeting = rpc('hello')
            session = greeting['session']
            assert greeting['revision'] == '1'
            assert rpc('inspect', session=session)['document'] == document
            assert rpc('submit', session=session, ticket=ticket, command=command) == receipt
            close()
            process = start()
            output, error = process.communicate(b' ' * (FRAME_BYTES + 1) + b'\n{"method":"hello"}\n', timeout=30)
            assert process.returncode != 0 and not output
            assert json.loads(error)['code'] == 'RAW_LIMIT'
            print(json.dumps(dict(
                rawFailuresRejected=3, subsequentValidRequest=True,
                encodedDocumentBytes=encoded_size, largeReplyWithinBudget=True,
                savedRevisions=1, restartReceiptReused=True,
                oversizeClosesPipeWithoutExecutingSuffix=True,
                elapsedSeconds=round(time.monotonic() - began, 3)), indent=2))
        finally:
            if process and process.poll() is None:
                process.kill()
                process.communicate(timeout=30)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    run(parser.parse_args().binary)
