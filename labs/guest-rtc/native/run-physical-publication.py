"""Explicit local microphone publication; loopback only, no voice recording in browser."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time
LAB = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--publish-microphone', action='store_true')
parser.add_argument('--play-guest', action='store_true', help='Play the remote speech fixture through native speakers (local microphone never monitored)')
parser.add_argument('--wait-for-start', action='store_true', help='Wait for the visible browser Start speaker test button before microphone capture')
parser.add_argument('--guest-rejoin', action='store_true', help='Have the remote guest leave and rejoin after five seconds')
parser.add_argument('--reconnect', choices=['signal','full'], help='Exercise actual SDK reconnect after five seconds')
parser.add_argument('--seconds', type=int, default=20)
args = parser.parse_args()
if not 5 <= args.seconds <= 300:
    parser.error('--seconds must be 5..300')
if not args.publish_microphone:
    parser.error('Explicit --publish-microphone required; microphone will be sent to the local SFU')
if args.guest_rejoin and args.reconnect:
    parser.error("Use --guest-rejoin or --reconnect separately")
if (args.reconnect or args.guest_rejoin) and (not args.play_guest or args.seconds<20):
    parser.error("Reconnect/rejoin requires --play-guest and at least 20 seconds")
for port in (7880,8990):
    with socket.socket() as probe:
        probe.bind(('127.0.0.1',port))
name='physical-publication-'+str(time.time_ns())
env=dict(os.environ)
for key in list(env):
    if key.startswith('LIVEKIT_LAB_'):
        env.pop(key)
env.update(LIVEKIT_LAB_PHYSICAL_CAPTURE='1',LIVEKIT_LAB_PHYSICAL_SPEECH=str(LAB/'runtime/near-speech.wav'),LIVEKIT_LAB_URL='ws://127.0.0.1:7880',LIVEKIT_LAB_RUN_NAME=name,LIVEKIT_LAB_SECONDS=str(args.seconds))
if args.guest_rejoin:env["LIVEKIT_LAB_GUEST_REJOIN"]="1"
if args.reconnect:env["LIVEKIT_LAB_MONITOR_RECONNECT"]=args.reconnect
if args.play_guest:env["LIVEKIT_LAB_GUEST_MONITOR"]="1"
if args.wait_for_start:env["LIVEKIT_LAB_WAIT_FOR_START"]="1"
owned=[]
logs=[]
report={'run_name':name,'status':'running','loopback_only':True,'physical_microphone_publication_requested':True,'browser_voice_recorded':False,'seconds':args.seconds,'g1_complete':False,'guest_monitor_requested':args.play_guest,'wait_for_user_start':args.wait_for_start,'sdk_reconnect_requested':args.reconnect,'guest_rejoin_requested':args.guest_rejoin}
def digest_file(path):
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):
            digest.update(chunk)
    return digest.hexdigest()
report['native_binary_sha256']=digest_file(LAB/'target/debug/producer-guest-rtc-lab')
report['sfu_binary_sha256']=digest_file(LAB/'runtime/livekit-server-delayed-report-lab')
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
        code=fixture.wait(timeout=args.seconds+360 if args.wait_for_start else args.seconds+45)
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
