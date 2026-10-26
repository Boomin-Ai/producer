#!/usr/bin/env python3
"""Local system GPU samples annotated by the opt-in native acceptance phase.

Includes all applications: compare adjacent controlled phases, never attribute
an individual system percentage entirely to Producer. Stops on final receipt.
"""
import datetime,json,os,pathlib,plistlib,subprocess,time
proof=pathlib.Path.home()/'Library/Application Support/ai.boomin.producer.sets-v2-dev/sets-v2-ui-proof.json'
out=pathlib.Path(os.environ.get('PRODUCER_GPU_PROOF','/private/tmp/producer-scene3d-gpu.jsonl'))
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
with out.open('w') as stream:
 for i in range(600):
  try: stage=json.loads(proof.read_text())
  except (OSError,ValueError): stage={}
  raw=plistlib.loads(subprocess.check_output(['ioreg','-r','-c','AGXAccelerator','-a']))
  stats=next((r['PerformanceStatistics'] for r in raw if 'PerformanceStatistics' in r),{})
  data={k:stats.get(k) for k in ['Device Utilization %','Renderer Utilization %','Tiler Utilization %','In use system memory','recoveryCount']}
  data.update(at=datetime.datetime.now(datetime.timezone.utc).isoformat(),phase=stage.get('stage'),kind=stage.get('kind'))
  stream.write(json.dumps(data)+'\n');stream.flush()
  if i>5 and stage.get('kind')=='managed-scene3d-studio' and stage.get('ok') is not None and stage.get('at','')>started:break
  time.sleep(1)
