"""Explicit local microphone publication; loopback only, no voice recording in browser."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import time
LAB = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--publish-microphone', action='store_true')
args = parser.parse_args()
if not args.publish_microphone:
    parser.error('Explicit --publish-microphone required; microphone will be sent to the local SFU')
for port in (7880,8990):
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',port))
name='physical-publication-'+str(time.time_ns())
env=dict(os.environ)
for key in list(env):
    if key.startswith('LIVEKIT_LAB_'):
        env.pop(key)
env.update(LIVEKIT_LAB_PHYSICAL_CAPTURE='1',LIVEKIT_LAB_PHYSICAL_SPEECH=str(LAB/'runtime/near-speech.wav'),LIVEKIT_LAB_URL='ws://127.0.0.1:7880',LIVEKIT_LAB_RUN_NAME=name)
owned=[]
logs=[]
report={'run_name':name,'status':'running','loopback_only':True,'physical_microphone_publication_requested':True,'browser_voice_recorded':False,'g1_complete':False}
conditions=LAB/'evidence'/f'{name}-conditions.json'
conditions.write_text(json.dumps(report,indent=2)+'\n')
def start(command,label,port):
    stream=(LAB/'runtime'/f'{name}-{label}.log').open('w');logs.append(stream)
    process=subprocess.Popen(command,cwd=LAB,env=env,stdout=stream,stderr=subprocess.STDOUT);owned.append(process)
    for _ in range(100):
        if process.poll() is not None:raise RuntimeError(f'{label} exited before listening')
        with socket.socket() as probe:
            probe.settimeout(.1)
            if probe.connect_ex(('127.0.0.1',port))==0:return
        time.sleep(.1)
    raise RuntimeError(f'{label} listener timeout')
try:
    start([str(LAB/'runtime/livekit-server-delayed-report-lab'),'--dev','--bind','127.0.0.1','--rtc.enable_loopback_candidate','--rtc.tcp_port','0'],'sfu',7880)
    start(['node','web/server.mjs'],'web',8990)
    fixture=subprocess.Popen(['node','web/physical-smoke.mjs','--publish-microphone'],cwd=LAB,env=env,start_new_session=True)
    try:
        code=fixture.wait(timeout=60)
        if code:raise RuntimeError(f'Physical fixture exited {code}; retain diagnostics')
    finally:
        if fixture.poll() is None:
            import signal
            os.killpg(fixture.pid,signal.SIGTERM)
            try:fixture.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(fixture.pid,signal.SIGKILL);fixture.wait()
    report['status']='completed'
finally:
    if report['status']=='running':report['status']='failed'
    conditions.write_text(json.dumps(report,indent=2)+'\n')
    for process in reversed(owned):
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
    for stream in logs:stream.close()
print(name)
