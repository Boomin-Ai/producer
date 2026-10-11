"""Explicit LiveKit Cloud compatibility test in an owned, temporary media room."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time
from cloud_profile import credentials
from port_preflight import check_ports

LAB = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--project', required=True, help='Locally authenticated CLI project name')
parser.add_argument('--guests', type=int, choices=[1, 3], default=1)
parser.add_argument('--seconds', type=int, default=60)
parser.add_argument('--reconnect', choices=['none', 'signal', 'full'], default='none')
parser.add_argument('--reconnect-count', type=int, choices=[1, 2, 3], default=1)
parser.add_argument('--require-obs-gates', action='store_true')
args = parser.parse_args()
if not 35 <= args.seconds <= 300: parser.error('Duration must be 35..300 seconds')
if args.reconnect != 'none' and args.seconds < 32 + 40*(args.reconnect_count-1): parser.error('Allow 20 seconds after the last reconnect')
check_ports((8990,))
if shutil.disk_usage(LAB).free < 1024**3: raise RuntimeError('Need 1 GiB free for recording')
settings = credentials(args.project, LAB/'runtime')
name = 'generated-recovery-' + str(time.time_ns())
room = 'producer-g1-cloud-' + name.removeprefix('generated-recovery-')
recording = LAB/'runtime'/f'{name}-obs.mp4'
env = {k:v for k,v in os.environ.items() if not k.startswith('LIVEKIT_LAB_')}
env.update(LIVEKIT_LAB_RUN_NAME=name, LIVEKIT_LAB_GUESTS=str(args.guests), LIVEKIT_LAB_SECONDS=str(args.seconds),
           LIVEKIT_LAB_GENERATED_RECONNECT_COUNT=str(args.reconnect_count), LIVEKIT_LAB_SYNC_STREAMS='1',
           LIVEKIT_LAB_MARKER_IDS='1', LIVEKIT_LAB_CLOUD_TEST='1', LIVEKIT_LAB_CLOUD_ROOM=room,
           LIVEKIT_LAB_URL=settings['LIVEKIT_URL'], LIVEKIT_LAB_TIMED_MIXER='1', LIVEKIT_LAB_RTCP_PROBE='1',
           LIVEKIT_LAB_AUDIO_MASTER='1', LIVEKIT_LAB_SCHEDULE_HANDOFF='1', LIVEKIT_LAB_OBS_PIPELINE_PROBE='1',
           LIVEKIT_LAB_OBS_FINALIZED_MP4='1', LIVEKIT_LAB_FIRST_REPORT_BOOTSTRAP='1',
           LIVEKIT_LAB_EXTENDED_VIDEO_BUFFER='1', LIVEKIT_LAB_FAST_RTCP='1', LIVEKIT_LAB_RTCP_TRACE='1',
           LIVEKIT_LAB_OBS_RECORDING=str(recording), DYLD_FRAMEWORK_PATH='/Applications/Producer.app/Contents/Frameworks',
           DYLD_LIBRARY_PATH='/Applications/Producer.app/Contents/Frameworks')
if args.reconnect != 'none': env['LIVEKIT_LAB_GENERATED_RECONNECT'] = args.reconnect
if args.reconnect == 'full': env['LIVEKIT_LAB_PRESERVE_RECONNECT_OUTPUT'] = '1'
server_env = {**env, **settings}
media_env = {k:v for k,v in env.items() if k not in ('LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET')}
def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            result.update(chunk)
    return result.hexdigest()
report = {'run':name, 'provider':'LiveKit Cloud', 'project_url':settings['LIVEKIT_URL'], 'room':room,
          'guests':args.guests, 'seconds':args.seconds, 'reconnect':args.reconnect, 'reconnect_count':args.reconnect_count,
          'native_sha256':digest(LAB/'target/debug/producer-guest-rtc-lab'), 'custom_sfu_patch_available':False,
          'hardware_capture_used':False, 'speaker_playback_used':False, 'media_scope':'generated selected guest-1 only',
          'status':'running', 'g1_complete':False, 'production_deployed':False}
conditions = LAB/'evidence'/f'{name}-conditions.json'
conditions.write_text(json.dumps(report,indent=2)+'\n')
server = fixture = None
log = (LAB/'runtime'/f'{name}-web.log').open('w')
try:
    server = subprocess.Popen(['node','web/server.mjs'],cwd=LAB,env=server_env,stdout=log,stderr=subprocess.STDOUT)
    deadline = time.monotonic()+20
    while True:
        if server.poll() is not None: raise RuntimeError('Cloud fixture server failed before readiness; private runtime log retained')
        with socket.socket() as probe:
            probe.settimeout(.1)
            if probe.connect_ex(('127.0.0.1',8990))==0: break
        if time.monotonic()>deadline: raise RuntimeError('Cloud fixture server readiness timed out')
        time.sleep(.1)
    fixture = subprocess.Popen(['node','web/generated-recovery-smoke.mjs'],cwd=LAB,env=media_env,start_new_session=True)
    code = fixture.wait(timeout=args.seconds+90)
    report['fixture_exit_code']=code
    if code: raise RuntimeError('Cloud media fixture failed; numeric evidence retained')
    for script,suffix in [('analyze-recording.swift','-obs-markers'),('analyze-numbered-recording.swift','-obs-numbered')]:
        subprocess.run(['swift','-suppress-warnings',script,str(recording),str(LAB/'evidence'/f'{name}{suffix}.json')],cwd=LAB,check=True,timeout=60)
    spec=importlib.util.spec_from_file_location('obs_gates',LAB/'native/obs-recording-gates.py')
    gates=importlib.util.module_from_spec(spec);spec.loader.exec_module(gates)
    native=json.loads((LAB/'evidence'/f'{name}.json').read_text())
    markers=json.loads((LAB/'evidence'/f'{name}-obs-numbered.json').read_text())
    acceptance=gates.evaluate(native,markers,1+(args.reconnect_count if args.reconnect=='full' else 0))
    (LAB/'evidence'/f'{name}-obs-acceptance.json').write_text(json.dumps(acceptance,indent=2)+'\n')
    report.update(status='completed',local_obs_acceptance_passed=acceptance['local_obs_acceptance_passed'],recording_sha256=digest(recording))
    subprocess.run(['python3','native/analyze-reconnect-loss.py',name],cwd=LAB,check=True,timeout=10)
    print('Cloud OBS acceptance:',acceptance['local_obs_acceptance_passed'],acceptance['failure_reasons'])
finally:
    if report['status']=='running': report['status']='failed'
    if fixture is not None and fixture.poll() is None:
        os.killpg(fixture.pid,signal.SIGTERM)
        try: fixture.wait(timeout=5)
        except subprocess.TimeoutExpired: os.killpg(fixture.pid,signal.SIGKILL);fixture.wait()
    if server is not None and server.poll() is None:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill();server.wait()
    log.close()
    try:
        cleanup=subprocess.run(['lk','--quiet','--project',args.project,'--yes','room','delete',room],capture_output=True,text=True,timeout=20)
        report['owned_room_delete_exit_code']=cleanup.returncode
    except (OSError, subprocess.TimeoutExpired):
        report['owned_room_delete_exit_code']=None
        report['owned_room_cleanup_failed']=True
    # Refuse to publish a diagnostic file if a server credential escaped into it.
    for path in (LAB/'evidence').glob(name+'*.json'):
        if any(value in path.read_text() for value in (settings['LIVEKIT_API_KEY'],settings['LIVEKIT_API_SECRET'])):
            path.unlink()
            report['credential_scan_failed']=True
    conditions.write_text(json.dumps(report,indent=2)+'\n')
print(name)
if report.get('credential_scan_failed') or report.get('owned_room_delete_exit_code') != 0:
    raise SystemExit('Cloud fixture cleanup or credential check failed; inspect numeric conditions')
if args.require_obs_gates and not report.get('local_obs_acceptance_passed'): raise SystemExit(2)
