#!/bin/sh
set -eu
: "${WEBRTC_ARCHIVE_DIR:?Set WEBRTC_ARCHIVE_DIR to a native Google WebRTC SDK with headers and lib/libwebrtc.a}"
src=$(dirname "$0")
inc="$WEBRTC_ARCHIVE_DIR/include"
"$CXX" -std=c++20 -DNDEBUG -fno-rtti -fobjc-arc -O2 -Wno-deprecated-declarations -isysroot "$SDKROOT" -mmacosx-version-min=13 -I"$inc" -I"$inc/sdk/objc/base" -I"$inc/sdk/objc/api/peerconnection" -I"$inc/third_party/libyuv/include" "$src/peer.mm" "$WEBRTC_ARCHIVE_DIR/lib/libwebrtc.a" -Wl,-S -Wl,-dead_strip -Wl,-ObjC -framework Foundation -framework AVFoundation -framework AVFAudio -framework AudioToolbox -framework CoreAudio -framework AppKit -framework CoreMedia -framework CoreGraphics -framework VideoToolbox -framework CoreVideo -framework OpenGL -framework Metal -framework MetalKit -framework QuartzCore -framework IOKit -framework IOSurface -framework ScreenCaptureKit -framework Security -framework Network -framework CoreFoundation -o "$1"
