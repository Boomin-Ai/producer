"""Build admission-aware experiment beside unchanged delayed-control SFU."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess

LAB=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('base_builder',LAB/'native/build-sfu-lab.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
go,source=base.prepare(early_report=True,delayed_report=True)
manifest_path=LAB/'evidence/sfu-subscriber-report-provenance.json'
manifest=json.loads(manifest_path.read_text())
patch=LAB/'native/sfu-subscriber-report.patch'
if base.digest(patch)!=manifest['patch_sha256']:raise RuntimeError('Subscriber patch provenance mismatch')
for name,expected in manifest['base_files_sha256'].items():
    if base.digest(source/name)!=expected:raise RuntimeError('Base source mismatch: '+name)
candidate=LAB/'runtime/livekit-sfu-subscriber-source'
if not candidate.exists():
    shutil.copytree(source,candidate)
    subprocess.run(['patch','--batch','-p1','-i',str(patch)],cwd=candidate,check=True)
for name,expected in manifest['patched_files_sha256'].items():
    if base.digest(candidate/name)!=expected:raise RuntimeError('Candidate source mismatch: '+name)
for name,expected in manifest['module_files_sha256'].items():
    if base.digest(source/name)!=expected or base.digest(candidate/name)!=expected:
        raise RuntimeError('Module provenance mismatch: '+name)
# Verify every other Go source remains the pinned baseline, including all RTP guards.
for original in source.rglob('*.go'):
    relative=original.relative_to(source).as_posix()
    if relative not in manifest['patched_files_sha256'] and base.digest(original)!=base.digest(candidate/relative):
        raise RuntimeError('Unexpected candidate mutation: '+relative)
cache=LAB/'runtime/go-build-cache'
warm_cache_bytes=sum(p.stat().st_size for p in cache.rglob('*') if p.is_file()) if cache.exists() else 0
required_free=int(1.5*1024**3) if warm_cache_bytes>512*1024**2 else 3*1024**3
if shutil.disk_usage(LAB).free<required_free:raise RuntimeError('Need 3 GiB for cold build or 1.5 GiB with populated pinned compiler cache')
env=dict(os.environ,GOMAXPROCS='1',GOMEMLIMIT='256MiB',GOTOOLCHAIN='local',GOCACHE=str(LAB/'runtime/go-build-cache'),GOPATH=str(LAB/'runtime/go-work'))
subprocess.run([str(go),'-C',str(candidate),'test','pkg/sfu/buffer/lab_subscriber_sr_request.go','pkg/sfu/buffer/lab_subscriber_sr_request_test.go'],env=env,check=True)
manifest['helper_tests_passed']=True
manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
binary=LAB/'runtime/livekit-server-subscriber-report-lab'
subprocess.run([str(go),'-C',str(candidate),'build','-p','1','-trimpath','-ldflags=-s -w','-o',str(binary),'./cmd/server'],env=env,check=True)
test_env=dict(env,GOMEMLIMIT='1GiB')
subprocess.run([str(go),'-C',str(candidate),'test','-p','1','-ldflags=-s -w','./pkg/sfu/buffer','./pkg/rtc','-run','TestSubscriber|TestLab','-count=1'],env=test_env,check=True)
manifest.update(full_server_build_passed=True,buffer_and_wrapper_tests_passed=True,built_binary_sha256=base.digest(binary))
manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
print('Built subscriber-aware SFU',manifest['built_binary_sha256'])
