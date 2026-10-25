#!/usr/bin/env python3
"""Real OBS endpoint ownership test; generated frames only, no devices/network."""
from pathlib import Path
import json, hashlib, os, subprocess, tempfile
root=Path(__file__).resolve().parents[1]
engine=Path(os.environ.get('PRODUCER_ENGINE_DIR','/Applications/Producer.app/Contents'))
frameworks=engine/'Frameworks'
if not (frameworks/'libobs.framework').is_dir():
    raise SystemExit('Installed native engine framework is required')
with tempfile.TemporaryDirectory(prefix='producer-rtc-ingest-proof-') as directory:
    out=Path(directory);obj=out/'ingest.o';binary=out/'proof'
    subprocess.run(['clang','-c',str(root/'src-tauri/src/live/guest_ingest.c'),'-o',str(obj)],check=True)
    subprocess.run(['rustc','--edition','2021','--test',str(root/'tests/rtc_ingest_native.rs'),'-C','debuginfo=0','-L','framework='+str(frameworks),'-C','link-arg='+str(obj),'-C','link-arg=-framework','-C','link-arg=libobs','-C','link-arg=-Wl,-rpath,'+str(frameworks),'-o',str(binary)],check=True)
    result=subprocess.run([str(binary)],capture_output=True,text=True,timeout=30)
    passed=result.returncode==0 and '1 passed; 0 failed' in result.stdout
    files=['src-tauri/src/live/rtc_ingest.rs','src-tauri/src/live/guest_ingest.c','src-tauri/src/live/guest_ingest.h','tests/rtc_ingest_native.rs','scripts/test-rtc-ingest-native.py']
    report={'passed':passed,'repeated_source_cycles':20,'generated_video_only':True,'sdk_or_devices_used':False,'checks':['replacement invalidates old delivery','duplicate timestamps rejected','short planes rejected','concurrent delivery stopped before release','retirement removes registration','late old retirement preserves replacement','weak source owners expire','partial initialization rejects null source'],'source_sha256':{file:hashlib.sha256((root/file).read_bytes()).hexdigest() for file in files},'qualification':'OBS endpoint ownership only; not ordinary-room LiveKit timing or AEC'}
    (root/'docs/evidence/rtc-native-endpoint-2026-10-12.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
    if not passed:raise SystemExit('Native endpoint proof failed; no qualification claimed')
