"""Build a tiny independent decoder against installed Producer FFmpeg 7.1.1."""
import ctypes
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request

if sys.platform != 'darwin':raise RuntimeError('This diagnostic currently requires macOS')
lab=Path(__file__).resolve().parents[1]
frameworks=Path('/Applications/Producer.app/Contents/Frameworks')
util=ctypes.CDLL(str(frameworks/'libavutil.dylib'))
util.av_version_info.restype=ctypes.c_char_p
if util.av_version_info()!=b'n7.1.1':raise RuntimeError('Installed FFmpeg must match pinned 7.1.1 headers')
root=lab/'runtime/ffmpeg-headers'
with urllib.request.urlopen('https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n7.1.1.tar.gz',timeout=30) as response:
    with tarfile.open(fileobj=response,mode='r|gz') as archive:
        for entry in archive:
            parts=Path(entry.name).parts
            if entry.isfile() and len(parts)==3 and parts[1] in ['libavutil','libavcodec','libavformat'] and parts[2].endswith('.h'):
                dest=root/parts[1]/parts[2]
                dest.parent.mkdir(parents=True,exist_ok=True)
                dest.write_bytes(archive.extractfile(entry).read())
# Generated configuration needed by public headers on supported little-endian Macs.
(root/'libavutil/avconfig.h').write_text('#define AV_HAVE_BIGENDIAN 0\n#define AV_HAVE_FAST_UNALIGNED 1\n')
subprocess.run(['clang','-Wall','-Wextra','-Werror','-I',str(root),
    str(lab/'native/decode-audio-markers.c'),'-L'+str(frameworks),
    '-lavformat','-lavcodec','-lavutil','-Wl,-rpath,'+str(frameworks),
    '-o',str(lab/'runtime/decode-audio-markers')],check=True)
print('Built independent audio decoder; no capture or playback')
