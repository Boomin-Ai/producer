"""Package disposable RTC camera sync lab; ad-hoc development only."""
from pathlib import Path
import plistlib,shutil,subprocess
lab=Path(__file__).resolve().parents[1]
binary=lab/'target/debug/producer-guest-rtc-lab'
app=Path.home()/'Applications/Producer Camera Sync Lab.app'
macos=app/'Contents/MacOS';macos.mkdir(parents=True,exist_ok=True)
shutil.copy2(binary,macos/binary.name)
info={'CFBundleExecutable':binary.name,'CFBundleIdentifier':'ai.boomin.producer.camera-sync-lab','CFBundleName':'Producer Camera Sync Lab','CFBundleDisplayName':'Producer Camera Sync Lab','CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'0.1','LSMinimumSystemVersion':'13.0','NSCameraUsageDescription':'Capture your built-in camera for an explicit local LiveKit camera/audio synchronization test.','NSMicrophoneUsageDescription':'Capture microphone audio for an explicit local LiveKit camera/audio synchronization test. Review recordings stay privately on this Mac.','NSHighResolutionCapable':True}
(app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
subprocess.run(['codesign','--force','--sign','-',str(app)],check=True)
subprocess.run(['codesign','--verify','--strict',str(app)],check=True)
print(app)
