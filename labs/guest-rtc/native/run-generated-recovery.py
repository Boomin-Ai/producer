"""Owned loopback SFU and headless generated marker recovery; no physical devices."""
import argparse
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time
from port_preflight import check_ports

LAB=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--reconnect',choices=['none','signal','full'],default='full')
parser.add_argument('--reconnect-count',type=int,choices=[1,2,3],default=1)
timing=parser.add_mutually_exclusive_group()
timing.add_argument('--subscriber-report',action='store_true',default=True,help='Use bounded fresh audio timing requests after forwarding begins (default)')
timing.add_argument('--control-report',dest='subscriber_report',action='store_false',help='Reproduce the old admission-insensitive timing control')
parser.add_argument('--require-obs-gates',action='store_true',help='Exit unsuccessfully if local OBS sync/readiness/loss acceptance fails')
parser.add_argument('--obs-recording',action='store_true',help='Record generated guest-1 through native OBS audio-master presentation')
parser.add_argument('--room-loop-playback',action='store_true',help='Control: keep clock processing on the room loop')
parser.add_argument('--guests',type=int,choices=[1,3],default=1)
parser.add_argument('--seconds',type=int,default=45)
args=parser.parse_args()
if args.require_obs_gates and not args.obs_recording:parser.error('--require-obs-gates requires --obs-recording')
if not 35<=args.seconds<=300:parser.error('Duration must be 35..300 seconds')
if args.reconnect!='none' and args.seconds<12+40*(args.reconnect_count-1)+20:parser.error('Allow 20 seconds after the last reconnect')
check_ports((7880,8990))
name='generated-recovery-'+str(time.time_ns())
sfu=LAB/'runtime'/('livekit-server-subscriber-report-lab' if args.subscriber_report else 'livekit-server-delayed-report-lab')
env={key:value for key,value in os.environ.items() if not key.startswith('LIVEKIT_LAB_')}
env.update(LIVEKIT_LAB_RUN_NAME=name,LIVEKIT_LAB_GENERATED_RECONNECT_COUNT=str(args.reconnect_count),LIVEKIT_LAB_MARKER_IDS='1',LIVEKIT_LAB_SYNC_STREAMS='1',LIVEKIT_LAB_GUESTS=str(args.guests),LIVEKIT_LAB_SECONDS=str(args.seconds),LIVEKIT_LAB_URL='ws://127.0.0.1:7880')
if args.room_loop_playback:env['LIVEKIT_LAB_ROOM_LOOP_PLAYBACK']='1'
if args.reconnect!='none':env['LIVEKIT_LAB_GENERATED_RECONNECT']=args.reconnect
if args.subscriber_report:env['LIVEKIT_LAB_SUBSCRIBER_AUDIO_SR']='1'
recording=LAB/'runtime'/f'{name}-obs.mp4'
if args.obs_recording:
    if shutil.disk_usage(LAB).free<1024**3:raise RuntimeError('Need 1 GiB free for generated OBS recording')
    env.update(DYLD_FRAMEWORK_PATH='/Applications/Producer.app/Contents/Frameworks',DYLD_LIBRARY_PATH='/Applications/Producer.app/Contents/Frameworks',LIVEKIT_LAB_TIMED_MIXER='1',LIVEKIT_LAB_RTCP_PROBE='1',LIVEKIT_LAB_AUDIO_MASTER='1',LIVEKIT_LAB_SCHEDULE_HANDOFF='1',LIVEKIT_LAB_OBS_PIPELINE_PROBE='1',LIVEKIT_LAB_OBS_FINALIZED_MP4='1',LIVEKIT_LAB_FIRST_REPORT_BOOTSTRAP='1',LIVEKIT_LAB_EXTENDED_VIDEO_BUFFER='1',LIVEKIT_LAB_FAST_RTCP='1',LIVEKIT_LAB_RTCP_TRACE='1',LIVEKIT_LAB_DELAYED_AUDIO_SR='1',LIVEKIT_LAB_OBS_RECORDING=str(recording))
def digest(p):
    result=hashlib.sha256()
    with p.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):result.update(chunk)
    return result.hexdigest()
report={'run':name,'status':'running','guests':args.guests,'isolated_playback_candidate':args.obs_recording and not args.room_loop_playback,'seconds':args.seconds,'reconnect':args.reconnect,'reconnect_count':args.reconnect_count,'hardware_capture_used':False,'speaker_playback_used':False,'media_recorded':args.obs_recording,'media_scope':'generated selected guest-1 only' if args.obs_recording else 'none','obs_recording_requested':args.obs_recording,'g1_complete':False,'native_sha256':digest(LAB/'target/debug/producer-guest-rtc-lab'),'sfu_sha256':digest(sfu),'subscriber_report_candidate':args.subscriber_report}
if args.subscriber_report:
    provenance=LAB/'evidence/sfu-subscriber-report-provenance.json'
    expected=json.loads(provenance.read_text())
    if not expected.get('full_server_build_passed') or expected.get('built_binary_sha256')!=report['sfu_sha256']:
        raise RuntimeError('Subscriber SFU binary/provenance mismatch; rebuild the candidate first')
    snapshot=LAB/'evidence'/f'{name}-sfu-provenance.json'
    snapshot.write_bytes(provenance.read_bytes())
    report['sfu_provenance_file']=snapshot.name
    report['sfu_provenance_sha256']=digest(snapshot)
    report['sfu_request_delay_ms']=expected['delay_ms']
    report['sfu_request_trigger']=expected['trigger']
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
    start([str(sfu),'--dev','--bind','127.0.0.1','--rtc.enable_loopback_candidate','--rtc.tcp_port','0'],'sfu',7880)
    start(['node','web/server.mjs'],'web',8990)
    fixture=subprocess.Popen(['node','web/generated-recovery-smoke.mjs'],cwd=LAB,env=env,start_new_session=True)
    try:
        code=fixture.wait(timeout=args.seconds+75)
        if code:raise RuntimeError(f'Generated recovery failed ({code}); numeric evidence retained')
        if args.obs_recording:
            subprocess.run(['swift','-suppress-warnings','analyze-recording.swift',str(recording),str(LAB/'evidence'/f'{name}-obs-markers.json')],cwd=LAB,check=True,timeout=60)
            report['recording_sha256']=digest(recording)
            report['recording_bytes']=recording.stat().st_size
            report['marker_analysis']=f'{name}-obs-markers.json'
            numbered=LAB/'evidence'/f'{name}-obs-numbered.json'
            subprocess.run(['swift','-suppress-warnings','analyze-numbered-recording.swift',str(recording),str(numbered)],cwd=LAB,check=True,timeout=60)
            spec=importlib.util.spec_from_file_location('obs_gates',LAB/'native/obs-recording-gates.py')
            gates=importlib.util.module_from_spec(spec);spec.loader.exec_module(gates)
            acceptance=gates.evaluate(json.loads((LAB/'evidence'/f'{name}.json').read_text()),json.loads(numbered.read_text()),1+(args.reconnect_count if args.reconnect=='full' else 0))
            acceptance_path=LAB/'evidence'/f'{name}-obs-acceptance.json'
            acceptance_path.write_text(json.dumps(acceptance,indent=2)+'\n')
            report.update(numbered_marker_analysis=numbered.name,obs_acceptance=acceptance_path.name,local_obs_acceptance_passed=acceptance['local_obs_acceptance_passed'])
            print('Local OBS acceptance:',acceptance['local_obs_acceptance_passed'],acceptance['failure_reasons'])
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

if args.require_obs_gates and not report.get('local_obs_acceptance_passed',False):raise SystemExit(2)
