"""Owned loopback SFU and headless generated marker recovery; no physical devices."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time

LAB=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--reconnect',choices=['signal','full'],default='full')
parser.add_argument('--reconnect-count',type=int,choices=[1,2,3],default=1)
parser.add_argument('--guests',type=int,choices=[1,3],default=1)
parser.add_argument('--seconds',type=int,default=45)
args=parser.parse_args()
if not 35<=args.seconds<=300:parser.error('Duration must be 35..300 seconds')
if args.seconds<12+40*(args.reconnect_count-1)+20:parser.error('Allow 20 seconds after the last reconnect')
for port in (7880,8990):
    with socket.socket() as probe:probe.bind(('127.0.0.1',port))
name='generated-recovery-'+str(time.time_ns())
env={key:value for key,value in os.environ.items() if not key.startswith('LIVEKIT_LAB_')}
env.update(LIVEKIT_LAB_RUN_NAME=name,LIVEKIT_LAB_GENERATED_RECONNECT=args.reconnect,LIVEKIT_LAB_GENERATED_RECONNECT_COUNT=str(args.reconnect_count),LIVEKIT_LAB_MARKER_IDS='1',LIVEKIT_LAB_SYNC_STREAMS='1',LIVEKIT_LAB_GUESTS=str(args.guests),LIVEKIT_LAB_SECONDS=str(args.seconds),LIVEKIT_LAB_URL='ws://127.0.0.1:7880')
def digest(p):
    result=hashlib.sha256()
    with p.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):result.update(chunk)
    return result.hexdigest()
report={'run':name,'status':'running','guests':args.guests,'seconds':args.seconds,'reconnect':args.reconnect,'reconnect_count':args.reconnect_count,'hardware_capture_used':False,'speaker_playback_used':False,'media_recorded':False,'g1_complete':False,'native_sha256':digest(LAB/'target/debug/producer-guest-rtc-lab'),'sfu_sha256':digest(LAB/'runtime/livekit-server-delayed-report-lab')}
conditions=LAB/'evidence'/f'{name}-conditions.json';conditions.write_text(json.dumps(report,indent=2)+'\n')
owned=[];logs=[]
def start(command,label,port):
    log=(LAB/'runtime'/f'{name}-{label}.log').open('w');logs.append(log)
    process=subprocess.Popen(command,cwd=LAB,env=env,stdout=log,stderr=subprocess.STDOUT);owned.append(process)
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        if process.poll() is not None:raise RuntimeError(f'{label} failed before readiness')
        with socket.socket() as probe:
            probe.settimeout(.1)
            if probe.connect_ex(('127.0.0.1',port))==0:return
        time.sleep(.1)
    raise RuntimeError(f'{label} readiness timed out')
try:
    start([str(LAB/'runtime/livekit-server-delayed-report-lab'),'--dev','--bind','127.0.0.1','--rtc.enable_loopback_candidate','--rtc.tcp_port','0'],'sfu',7880)
    start(['node','web/server.mjs'],'web',8990)
    fixture=subprocess.Popen(['node','web/generated-recovery-smoke.mjs'],cwd=LAB,env=env,start_new_session=True)
    try:
        code=fixture.wait(timeout=args.seconds+75)
        if code:raise RuntimeError(f'Generated recovery failed ({code}); numeric evidence retained')
    finally:
        if fixture.poll() is None:
            os.killpg(fixture.pid,signal.SIGTERM)
            try:fixture.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(fixture.pid,signal.SIGKILL);fixture.wait()
    report['status']='completed'
finally:
    if report['status']=='running':report['status']='failed'
    conditions.write_text(json.dumps(report,indent=2)+'\n')
    for process in reversed(owned):
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
    for log in logs:log.close()
print(name)
