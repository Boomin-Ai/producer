#!/usr/bin/env python3
"""Real stdio/file-store proof of process-owned services; no app profile/media."""
import argparse
import json
import subprocess
import tempfile


def run(binary):
    with tempfile.TemporaryDirectory(prefix='producer-host-proof-') as store:
        def start():
            return subprocess.Popen([binary, 'serve', '--store', store, '--document-id', 'host-proof'],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True)
        process = start()

        def raw(method, **kwargs):
            process.stdin.write(json.dumps(dict(method=method, **kwargs)) + '\n')
            process.stdin.flush()
            line = process.stdout.readline()
            assert line, process.stderr.read()
            return json.loads(line)

        def rpc(method, **kwargs):
            result = raw(method, **kwargs)
            assert result['ok'], result
            return result['result']

        sessions = [rpc('hello')['session'] for _ in range(4)]
        s = sessions[0]
        assert raw('hello')['error']['code'] == 'SERVICE_LIMIT'
        observers = [rpc('observe', session=s)['observer'] for _ in range(4)]
        assert raw('observe', session=s)['error']['code'] == 'SERVICE_LIMIT'
        assert raw('observerPoll', session=sessions[1], observer=observers[0])['error']['code'] == 'AUTH_REQUIRED'
        assert raw('services', session='invalid')['error']['code'] == 'AUTH_REQUIRED'
        services = rpc('services', session=s)['services']
        assert services['sessions'] == services['observers'] == 4 and services['documents'] == 1
        snapshot = rpc('observerPoll', session=s, observer=observers[0])
        assert snapshot['kind'] == 'snapshot' and snapshot['total'] == 1
        projection = json.loads(bytes(snapshot['bytes']))
        assert set(projection) == {'documentId', 'revision', 'digest', 'sets', 'shows', 'sourceCount'}
        rpc('observerComplete', session=s, observer=observers[0], cursor=snapshot['cursor'], digest=snapshot['digest'])
        command = dict(kind='transaction', operations=[dict(op='setTitle', title='Host-owned draft')])
        ticket = rpc('issue', session=s, expected='0', command=command)['ticket']
        receipt = rpc('submit', session=s, ticket=ticket, command=command)
        assert receipt['outcome']['status'] == 'saved'
        history = rpc('inspect', session=s)['history']
        assert history['entries'] == 1 and history['maxEntries'] == 16
        assert history['encodedBytes'] <= history['maxEncodedBytes'] == 32 * 1024 * 1024
        assert history['structuralUnits'] <= history['maxStructuralUnits'] == 2 * 1048576
        assert rpc('submit', session=s, ticket=ticket, command=command) == receipt
        delta = rpc('observerPoll', session=s, observer=observers[0])
        assert delta['kind'] == 'delta' and delta['value']['digest'] == receipt['digest']
        assert delta['value']['revision'] == '1'
        rpc('observerSnapshot', session=s, observer=observers[0])
        assert rpc('observerPoll', session=s, observer=observers[0])['revision'] == '1'
        rpc('unobserve', session=s, observer=observers[0])
        assert rpc('services', session=s)['services']['observers'] == 3
        rpc('disconnect', session=s)
        assert raw('inspect', session=s)['error']['code'] == 'AUTH_REQUIRED'
        services = rpc('services', session=sessions[1])['services']
        assert services['sessions'] == 3 and services['observers'] == 0
        assert services['submissions'] == services['flights'] == services['wireBytes'] == 0
        rpc('hello')  # Reuses capacity after actual disconnect cleanup.
        rpc('checkpoint', session=sessions[1])
        process.stdin.close()
        assert process.wait(timeout=30) == 0
        process = start()
        s = rpc('hello')['session']
        assert rpc('submit', session=s, ticket=ticket, command=command) == receipt
        assert rpc('inspect', session=s)['document']['title'] == 'Host-owned draft'
        assert rpc('inspect', session=s)['history']['entries'] == 0
        assert rpc('services', session=s)['services']['observers'] == 0
        rpc('disconnect', session=s)
        process.stdin.close()
        assert process.wait(timeout=30) == 0
        print(json.dumps(dict(singleProcessHost=True, sessionLimit=4, observerLimit=4,
                              observerOwnership=True, redactedProjection=True, savedRevisions=1,
                              restartReceiptReused=True, disconnectedCapacityReused=True), indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    run(parser.parse_args().binary)
