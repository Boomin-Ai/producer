#!/usr/bin/env python3
"""Agent-shaped geometry authoring and rehearsal over the real bounded CLI.
Dimensions and resources are synthetic; no native capture or output is changed.
"""
import argparse
import copy
import json
import subprocess
import tempfile


def run(binary):
    fixture = json.loads(subprocess.check_output([binary, 'layout-fixture']))
    with tempfile.TemporaryDirectory(prefix='producer-layout-proof-') as tmp:
        def start():
            return subprocess.Popen([binary, 'serve', '--store', tmp, '--document-id', fixture['id']],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        process = start()

        def raw(method, **kwargs):
            process.stdin.write(json.dumps(dict(method=method, **kwargs)) + '\n')
            process.stdin.flush()
            line = process.stdout.readline()
            assert line, process.stderr.read()
            return json.loads(line)

        def rpc(method, **kwargs):
            reply = raw(method, **kwargs)
            assert reply['ok'], reply
            return reply['result']

        session = rpc('hello')['session']
        revision = 0
        last = None

        def transaction(operations):
            nonlocal revision, last
            command = dict(kind='transaction', operations=operations)
            ticket = rpc('issue', session=session, expected=str(revision), command=command)['ticket']
            result = rpc('submit', session=session, ticket=ticket, command=command)
            assert result['outcome']['status'] == 'saved', result
            assert rpc('submit', session=session, ticket=ticket, command=command) == result
            revision += 1
            last = (ticket, command, result)

        transaction([dict(op='setTitle', title=fixture['title'])])
        for key, value in fixture['sources'].items():
            transaction([dict(op='addSource', id=key, value=value)])
        transaction([dict(op='addSet', id='teaching', value=fixture['sets']['teaching'])])
        before = rpc('inspect', session=session)
        assert before['document'] == fixture

        def layout(inputs=None, offset=0, limit=128):
            return rpc('layout', session=session, set='teaching', layout='tall', inputs=inputs,
                       offset=offset, limit=limit)

        def frame(page, suffix):
            return next(n['frame'] for n in page['nodes'] if n['path'].endswith(suffix))

        fallback = layout()
        observed = dict(document=fixture['id'], sources={'screen': dict(
            identity=fallback['sourceIdentities']['screen'], display=dict(width=4, height=3))})
        adapted = layout(observed)
        assert frame(fallback, '/screen') == dict(x=0.0, y=0.0, width=1080.0, height=608.0)
        assert frame(adapted, '/screen') == dict(x=0.0, y=0.0, width=1080.0, height=810.0)
        assert frame(adapted, '/host')['y'] == 826.0
        assert fallback['documentDigest'] == adapted['documentDigest'] == before['digest']
        assert fallback['geometryDigest'] != adapted['geometryDigest']
        assert rpc('inspect', session=session) == before  # rehearsal is read-only
        pages = [layout(observed, offset=i, limit=1) for i in range(adapted['total'])]
        assert [p['nodes'][0] for p in pages] == adapted['nodes']
        assert pages[-1]['next'] is None
        assert layout(observed, offset=100)['nodes'] == []
        bad = copy.deepcopy(observed); bad['sources']['screen']['identity'] = '0' * 64
        for kwargs, code in [
            (dict(inputs=bad, limit=128), 'LAYOUT_INPUT'),
            (dict(inputs=observed, limit=0), 'LAYOUT_LIMIT'),
            (dict(inputs=observed, limit=129), 'LAYOUT_LIMIT'),
            (dict(inputs=dict(observed, unknown=True), limit=128), 'STRUCTURE'),
        ]:
            reply = raw('layout', session=session, set='teaching', layout='tall', **kwargs)
            assert not reply['ok'] and reply['error']['code'] == code, reply
        denied = raw('layout', session='not-authorized', set='teaching', layout='tall', limit=1)
        assert not denied['ok']
        # A minimal placement operation, not a whole-Set replacement.
        placement = copy.deepcopy(fixture['sets']['teaching']['layouts']['wide']['root']['children'][0]['placement'])
        placement['anchor'] = dict(x=0.0, y=0.0)
        placement['pivot'] = dict(x=0.0, y=0.0)
        transaction([dict(op='setPlacement', set='teaching', layout='wide', path=['root', 'screen'], placement=placement)])
        saved = rpc('inspect', session=session)
        rpc('checkpoint', session=session)
        process.stdin.close(); assert process.wait(timeout=30) == 0
        process = start(); session = rpc('hello')['session']
        ticket, command, receipt = last
        assert rpc('submit', session=session, ticket=ticket, command=command) == receipt
        restored = rpc('inspect', session=session)
        assert restored['document'] == saved['document'] and restored['revision'] == str(revision)
        after = layout(observed)
        assert frame(after, '/screen') == frame(adapted, '/screen')
        assert after['documentDigest'] == restored['digest']
        rpc('disconnect', session=session); process.stdin.close(); assert process.wait(timeout=30) == 0
        print(json.dumps(dict(incrementalCommits=revision, dimensions='synthetic 16:9 fallback -> 4:3 input',
                              screenHeights=[608, 810], hostReflowY=826, paginatedNodes=len(pages),
                              staleInputsRejected=True, rehearsalReadOnly=True, replayEffectsPerTicket=1,
                              restarted=True), indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--binary', required=True)
    run(parser.parse_args().binary)
