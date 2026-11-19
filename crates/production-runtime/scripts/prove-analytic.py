#!/usr/bin/env python3
"""Independent SHA/Fraction oracle across real CLI author/save/restart boundaries.
Synthetic reconstruction inputs only: no window, media or GPU is opened.
"""
import argparse, copy, hashlib, json, pathlib, struct, subprocess, tempfile
from fractions import Fraction

def time(value):
    return Fraction(int(value['ticks']), value['rate'])

def wire(value):
    return {'ticks': str(value.numerator), 'rate': value.denominator}

def seed(document, source, descriptor, path):
    def part(value):
        b = value.encode(); return struct.pack('>Q', len(b)) + b
    raw = b'producer.analytic/1\0' + part(document) + part(source) + struct.pack('>Q', int(descriptor['seed']))
    raw += b'\0' if descriptor['scope'] == 'source' else b'\1' + part(path)
    return list(struct.unpack('>4I', hashlib.sha256(raw).digest()[:16]))

def mapped(maps, at):
    for m in maps:
        start, duration = time(m['range']['start']), time(m['range']['duration'])
        if not start <= at < start + duration: return None
        available = m['sourceRange']; origin, length = time(available['start']), time(available['duration'])
        offset = time(m['sourceIn']) - origin + (at - start) * Fraction(m['speed']['numerator'], m['speed']['denominator'])
        if m['looping']: offset %= length
        at = origin + offset
        assert origin <= at < origin + length
    return at

def expected(document, effect, at):
    local = mapped(effect['maps'], at)
    if local is None: return None
    descriptor = document['sources'][effect['source']]['scene']['reconstruction']
    phase = local / time(descriptor['period']); cycle = phase.numerator // phase.denominator
    q32 = int((phase - cycle) * 2**32)
    return dict(version='producer.analytic/1', seed=seed(document['id'], effect['source'], descriptor, effect['path']), time=wire(local), cycle=str(cycle), phaseQ32=q32)

def authored_effects(document, root):
    # Independently expand the AUTHOR document; do not accept the compiled maps
    # as an oracle for how placement starts, ancestor speed/trim or rebinding work.
    def walk(key, path):
        sequence = document['sequences'][key]
        out = [dict(path=path+'/placements/'+p['id'], source=p['source'], placement=p, maps=[]) for p in sequence['placements']]
        for instance in sequence['instances']:
            child = document['sequences'][instance['sequence']]
            mapping = dict(range=instance['range'], sourceRange=dict(start=wire(Fraction(0)), duration=child['duration']), sourceIn=instance['sourceIn'], speed=instance['speed'], looping=instance['looping'])
            bindings = {b['from']: b['to'] for b in instance['sourceBindings']}
            for p in walk(instance['sequence'], path+'/instances/'+instance['id']):
                p['source'] = bindings.get(p['source'], p['source'])
                p['maps'].insert(0, mapping); out.append(p)
        return out
    out = []
    for p in walk(root, 'sequences/'+root):
        source = document['sources'][p['source']]
        if source['kind'] != 'graphics' or 'reconstruction' not in source['scene']: continue
        placement = p.pop('placement')
        p['maps'].append(dict(range=placement['range'], sourceRange=dict(start=wire(Fraction(0)), duration=placement['range']['duration']), sourceIn=wire(Fraction(0)), speed=dict(numerator=1, denominator=1), looping=False))
        out.append(p)
    return out

def run(binary):
    document = json.loads(subprocess.check_output([binary, 'analytic-fixture']))
    with tempfile.TemporaryDirectory(prefix='producer-analytic-proof-') as tmp:
        file = pathlib.Path(tmp) / 'document.json'; file.write_text(json.dumps(document))
        def plans():
            file.write_text(json.dumps(document))
            return json.loads(subprocess.check_output([binary, 'compile', str(file)]))
        plan = plans(); effects = authored_effects(document, 'timeline'); assert len(effects) == 4
        assert [{k:e[k] for k in ['path','source','maps']} for e in plan['sequences']['timeline']['effects']] == effects
        for effect in effects:
            descriptor = document['sources'][effect['source']]['scene']['reconstruction']
            assert plan['sequences']['timeline']['effects'][effects.index(effect)]['clock']['seed'] == seed(document['id'], effect['source'], descriptor, effect['path'])
        def start():
            return subprocess.Popen([binary, 'serve', '--store', str(pathlib.Path(tmp)/'store'), '--document-id', document['id']], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        process = start()
        def rpc(method, **kw):
            process.stdin.write(json.dumps(dict(method=method, **kw)) + '\n'); process.stdin.flush()
            line = process.stdout.readline(); assert line, process.stderr.read()
            result = json.loads(line); assert result['ok'], result
            return result['result']
        def close():
            process.stdin.close(); assert process.wait(timeout=30) == 0
        session = rpc('hello')['session']; revision = 0; last = None
        def transaction(ops, saved=True):
            nonlocal revision, last
            cmd = dict(kind='transaction', operations=ops)
            ticket = rpc('issue', session=session, expected=str(revision), command=cmd)['ticket']
            result = rpc('submit', session=session, ticket=ticket, command=cmd)
            assert (result['outcome']['status'] == 'saved') == saved, result
            assert rpc('submit', session=session, ticket=ticket, command=cmd) == result
            if saved: revision += 1
            last = ticket, cmd, result
        transaction([dict(op='setTitle', title=document['title'])])
        for collection, op in [('assets','addAsset'), ('sources','addSource'), ('components','addComponent'), ('sets','addSet')]:
            for key, value in document[collection].items(): transaction([dict(op=op, id=key, value=value)])
        for key in ['pulse', 'motif', 'timeline', 'opener']:
            transaction([dict(op='addSequence', id=key, value=document['sequences'][key])])
        for key, value in document['shows'].items(): transaction([dict(op='addShow', id=key, value=value)])
        assert rpc('inspect', session=session)['document'] == document
        checked = 0
        # Deliberately nonmonotonic, unrelated to wall-clock order. Includes exact
        # entry/end, parent loops, trims, rational rates and repeated seeks.
        times = [Fraction(i, 17) for i in range(136)] + [Fraction(8), Fraction(1,2), Fraction(0), Fraction(3,2)]
        times = times[::2] + list(reversed(times[1::2]))
        def check(at):
            nonlocal checked
            result = rpc('evaluate', session=session, sequence='timeline', time=wire(at))
            assert result['effects'] == [expected(document, effect, at) for effect in effects], result
            checked += len(effects)
            return result['effects']
        for at in times: check(at)
        before = check(Fraction(1, 2))
        events = [dict(kind='start', at='0'), dict(kind='advance', at='500000000'), dict(kind='seek', at='1000000000', to=wire(Fraction(1,2))), dict(kind='pause', at='1000000000', owner='host'), dict(kind='advance', at='9000000000'), dict(kind='stop', at='9000000000')]
        timeline = rpc('simulateTimeline', session=session, sequence='timeline', looping=True, events=events)['samples']
        assert timeline[1]['effects'] == before == timeline[2]['effects'] == timeline[4]['effects']
        assert not timeline[2]['cues'] and not timeline[4]['cues']
        assert all(v is None for v in timeline[-1]['effects'])
        show = rpc('simulateShow', session=session, show='pilot', events=[dict(kind='start', at='0'), dict(kind='advance', at='500000000')])['samples']
        assert show[1]['timeline']['effects'] == before
        descriptor = copy.deepcopy(document['sources']['stage']['scene']['reconstruction'])
        descriptor['seed'] = '42'
        transaction([dict(op='setAnalyticReconstruction', source='stage', value=descriptor)])
        document['sources']['stage']['scene']['reconstruction'] = descriptor
        plan = plans(); effects = authored_effects(document, 'timeline')
        after = check(Fraction(1,2)); assert after != before
        digest = rpc('inspect', session=session)['digest']
        invalid = copy.deepcopy(descriptor); invalid['period'] = wire(Fraction(0))
        transaction([dict(op='setTitle', title='must not persist'), dict(op='setAnalyticReconstruction', source='stage', value=invalid)], False)
        assert rpc('inspect', session=session)['digest'] == digest
        transaction([dict(op='setAnalyticReconstruction', source='host', value=descriptor)], False)
        assert rpc('inspect', session=session)['digest'] == digest
        ticket, command, result = last
        rpc('checkpoint', session=session); close()
        process = start(); session = rpc('hello')['session']
        assert rpc('inspect', session=session)['document'] == document
        assert rpc('submit', session=session, ticket=ticket, command=command) == result
        assert check(Fraction(1,2)) == after
        close()
        print(json.dumps(dict(durableCommits=revision, oracleEffectComparisons=checked, nestedEffects=4, exactSeedShaOracle=True, exactFractionOracle=True, malformedCandidateAtomic=True, checkpointRestart=True, stableReceipt=True, seekIsSilent=True, syntheticOnly=True), indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--binary', required=True); run(parser.parse_args().binary)
