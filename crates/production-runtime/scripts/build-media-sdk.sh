#!/bin/sh
# Isolated lab SDK only. Does not change engine/obs.lock or app bundles.
set -eu
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
SDK="$REPO/target/native-media-sdk"
mkdir -p "$SDK"
ARCHIVE="$SDK/ffmpeg-8.0.3.tar.xz"
EXPECTED=6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818
if [ ! -f "$ARCHIVE" ]; then
    curl --fail --location --silent --show-error https://ffmpeg.org/releases/ffmpeg-8.0.3.tar.xz -o "$ARCHIVE"
fi
ACTUAL=$(shasum -a 256 "$ARCHIVE" | cut -d ' ' -f 1)
[ "$ACTUAL" = "$EXPECTED" ] || { echo 'FFmpeg archive digest mismatch' >&2; exit 1; }
if [ ! -f "$SDK/ffmpeg-8.0.3/configure" ]; then tar -xf "$ARCHIVE" -C "$SDK"; fi
cd "$SDK/ffmpeg-8.0.3"
./configure --prefix="$SDK/install" --disable-everything --disable-autodetect --disable-doc --disable-debug --disable-network --disable-avdevice --enable-shared --disable-static --enable-avcodec --enable-avformat --enable-swscale --enable-swresample --enable-avfilter --enable-decoder=rawvideo,pcm_s16le,pcm_s16be,mpeg4,aac,h264 --enable-encoder=rawvideo,pcm_s16le,pcm_s16be,mpeg4,aac --enable-demuxer=mov,rawvideo,pcm_s16le --enable-muxer=mov,mp4,rawvideo,pcm_s16le,framemd5,framecrc --enable-protocol=file,pipe --enable-parser=mpeg4video,aac,h264 --enable-bsf=null,extract_extradata --enable-filter=aresample,scale,format,aformat,anull,null,buffer,buffersink,abuffer,abuffersink,setpts,asetpts,trim,atrim
make -j2
make install
mkdir -p "$SDK/install/share/licenses/ffmpeg"
cp LICENSE.md COPYING.LGPLv2.1 "$SDK/install/share/licenses/ffmpeg/"
printf '\nSDK: %s\nSet FFMPEG_DIR to this path for --features ffmpeg.\n' "$SDK/install"
