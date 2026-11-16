#!/usr/bin/env python3
"""Author, persist, restart and rehearse Shows through authenticated stdio.
All resources and cue deliveries remain symbolic; no app profile or device.
"""
import argparse
import copy
import json
import subprocess
import tempfile


def run(binary):
    document = json.loads(subprocess.check_output([binary, 'nested-fixture']))
    original = document['shows']['pilot']['segments'][0]
    document['shows']['pilot']['segments'].extend([
        dict(original, id='question', title='Question'),
        dict(original, id='static', title='Static controls', sequence=None),
    ])
    target = document['sequences']['timeline']['instances'][0]['targetBindings'][0]['to']
    events = [
        {'kind': 'start', 'at': '0'},
        {'kind': 'override', 'at': '0', 'scope': 'segment', 'owner': 'host',
         'target': target, 'value': {'type': 'number', 'value': 0.8}},
        {'kind': 'pause', 'at': '1000000000', 'scope': 'run', 'owner': 'operator', 'reason': 'manual'},
        {'kind': 'pause', 'at': '1000000000', 'scope': 'segment', 'owner': 'visibility', 'reason': 'hidden'},
        {'kind': 'enter', 'at': '2000000000', 'segment': 'question'},
        {'kind': 'advance', 'at': '3000000000'},
        {'kind': 'resume', 'at': '3000000000', 'scope': 'run', 'owner': 'operator', 'reason': 'manual'},
        {'kind': 'advance', 'at': '3500000000'},
        {'kind': 'seek', 'at': '4000000000', 'to': {'ticks': '0', 'rate': 1}},
        {'kind': 'advance', 'at': '4500000000'},
        {'kind': 'stop', 'at': '5000000000'},
        {'kind': 'start', 'at': '6000000000'},
        {'kind': 'enter', 'at': '7000000000', 'segment': 'static'},
        {'kind': 'close', 'at': '8000000000'},
    ]
    with tempfile.TemporaryDirectory(prefix='producer-show-proof-') as tmp:
        def start():
            return subprocess.Popen([binary, 'serve', '--store', tmp, '--document-id', document['id']],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
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

        session = rpc('hello')['session']
        revision = 0

        def transaction(operations):
            nonlocal revision
            command = {'kind': 'transaction', 'operations': operations}
            ticket = rpc('issue', session=session, expected=str(revision), command=command)['ticket']
            result = rpc('submit', session=session, ticket=ticket, command=command)
            assert result['outcome']['status'] == 'saved', result
            assert rpc('submit', session=session, ticket=ticket, command=command) == result
            revision += 1

        transaction([{'op': 'setTitle', 'title': document['title']}])
        for collection, operation in [('assets', 'addAsset'), ('sources', 'addSource'),
                                      ('components', 'addComponent'), ('sets', 'addSet')]:
            for key, value in document[collection].items():
                transaction([{'op': operation, 'id': key, 'value': value}])
        for key in ['pulse', 'motif', 'timeline', 'opener']:
            transaction([{'op': 'addSequence', 'id': key, 'value': document['sequences'][key]}])
        transaction([{'op': 'addShow', 'id': 'pilot', 'value': document['shows']['pilot']}])
        saved = rpc('inspect', session=session)
        assert saved['document'] == document

        def rehearse():
            result = rpc('simulateShow', session=session, show='pilot', events=events)
            assert result['synthetic']
            rows = result['samples']
            assert len(rows) == len(events)
            assert rows[0]['ownership']['scopes'] == 4 and rows[1]['overrides'] == 1
            assert rows[4]['overrides'] == 0 and rows[4]['paused']
            assert rows[4]['occurrence'] != rows[0]['occurrence']
            assert not rows[4]['cleanup']['retiring']
            assert rows[5]['timeline']['position'] == {'ticks': '0', 'rate': 1}
            assert not rows[8]['timeline']['cues']  # seek is silent, not a cue replay
            assert not rows[10]['active'] and rows[10]['ownership']['scopes'] == 2
            assert rows[11]['run'] == '2' and rows[11]['occurrence'] != rows[0]['occurrence']
            assert rows[12]['timeline'] is None
            assert rows[13]['closed'] and rows[13]['ownership']['retiring'] == 1
            assert all(row['setResource'] == rows[0]['setResource'] for row in rows)
            assert rpc('inspect', session=session)['digest'] == saved['digest']
            return rows

        before = rehearse()
        for args in [dict(session='untrusted', events=events),
                     dict(session=session, events=[events[0]] * 129),
                     dict(session=session, events=[dict(events[0], arbitraryAuthority=True)])]:
            assert not raw('simulateShow', show='pilot', **args)['ok']
        rpc('checkpoint', session=session)
        process.stdin.close()
        assert process.wait(timeout=30) == 0
        process = start()
        session = rpc('hello')['session']
        assert rpc('inspect', session=session)['document'] == document
        after = rehearse()
        assert before[0]['execution'] != after[0]['execution']
        assert before[0]['setResource'] != after[0]['setResource']

        def semantic(value):
            if isinstance(value, dict):
                return {k: semantic(v) for k, v in value.items() if k != 'execution'}
            if isinstance(value, list):
                return [semantic(v) for v in value]
            return value

        assert semantic(before) == semantic(after)
        rpc('disconnect', session=session)
        process.stdin.close()
        assert process.wait(timeout=30) == 0
        print(json.dumps({'incrementalCommits': revision, 'simulationEvents': len(events),
                          'segmentOverridesReleased': True, 'operatorPausePreserved': True,
                          'setLifetimePreserved': True, 'newOccurrenceOnReentry': True,
                          'replayedIdenticalAfterRestart': True, 'silentSeek': True,
                          'freshExecutionAfterRestart': True, 'effectsDispatched': False,
                          'fixtureDigest': saved['digest']}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    run(parser.parse_args().binary)
