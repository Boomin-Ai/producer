// Deterministic device substitute used only by the two-endpoint rehearsal.
#import "sdk/objc/components/audio/RTCAudioDevice.h"
#import "sdk/objc/components/video_codec/RTCDefaultVideoEncoderFactory.h"
#import "sdk/objc/components/video_codec/RTCDefaultVideoDecoderFactory.h"
#import "sdk/objc/api/video_frame_buffer/RTCNativeMutableI420Buffer.h"
#include <thread>
#include <chrono>
#include <mach/mach_time.h>
@interface RehearsalAudio : NSObject <RTCAudioDevice> {
    std::atomic_bool _alive, _playing, _recording;
    std::thread _clock;
}
@property id<RTCAudioDeviceDelegate> delegate;
@end
@implementation RehearsalAudio
- (double)deviceInputSampleRate { return 48000; }
- (double)deviceOutputSampleRate { return 48000; }
- (NSInteger)inputNumberOfChannels { return 1; }
- (NSInteger)outputNumberOfChannels { return 1; }
- (double)inputIOBufferDuration { return .01; }
- (double)outputIOBufferDuration { return .01; }
- (double)inputLatency { return 0; }
- (double)outputLatency { return 0; }
- (BOOL)isInitialized { return _alive; }
- (BOOL)isPlaying { return _playing; }
- (BOOL)isRecording { return _recording; }
- (BOOL)isPlayoutInitialized { return YES; }
- (BOOL)isRecordingInitialized { return YES; }
- (BOOL)initializePlayout { return YES; }
- (BOOL)initializeRecording { return YES; }
- (BOOL)startPlayout { _playing=true; return YES; }
- (BOOL)stopPlayout { _playing=false; return YES; }
- (BOOL)startRecording { _recording=true; return YES; }
- (BOOL)stopRecording { _recording=false; return YES; }
- (BOOL)initializeWithDelegate:(id<RTCAudioDeviceDelegate>)delegate {
    if (_alive.exchange(true)) return NO;
    _clock=std::thread([self,delegate]{
        auto next=std::chrono::steady_clock::now();
        double sample=0;
        while (self->_alive) { @autoreleasepool {
            int16_t pcm[480]; AudioBufferList list={1,{{1,sizeof(pcm),pcm}}};
            AudioTimeStamp ts={}; ts.mSampleTime=sample; ts.mHostTime=mach_absolute_time();
            ts.mFlags=kAudioTimeStampSampleTimeValid|kAudioTimeStampHostTimeValid;
            AudioUnitRenderActionFlags flags=0;
            if(self->_playing) delegate.getPlayoutData(&flags,&ts,0,480,&list);
            if(self->_recording) {
                const int hz=rehearsalHz.load();
                for(int i=0;i<480;i++) pcm[i]=6000*sin((i+sample)*2*M_PI*hz/48000.);
                delegate.deliverRecordedData(&flags,&ts,1,480,&list,nullptr,nil);
            }
            sample+=480; next+=std::chrono::milliseconds(10); std::this_thread::sleep_until(next);
        }}
    });
    return YES;
}
- (BOOL)terminateDevice { _alive=false; if(_clock.joinable()) _clock.join(); return YES; }
@end
static void rehearsalVideo(StudioPeer *peer) {
    RTCVideoCapturer *capturer=[[RTCVideoCapturer alloc] initWithDelegate:peer.source];
    __block unsigned tick=0;
    [NSTimer scheduledTimerWithTimeInterval:1./30 repeats:YES block:^(NSTimer *t) {
        RTCMutableI420Buffer *buf=[[RTCMutableI420Buffer alloc] initWithWidth:640 height:360];
        for(unsigned y=0;y<360;y++) {
            auto *row=buf.mutableDataY+y*buf.strideY;
            for(unsigned x=0;x<640;x++) row[x]=32+(x+tick*3)%190;
        }
        memset(buf.mutableDataU,90,buf.strideU*180);
        memset(buf.mutableDataV,160,buf.strideV*180);
        tick++;
        RTCVideoFrame *frame=[[RTCVideoFrame alloc] initWithBuffer:buf rotation:RTCVideoRotation_0 timeStampNs:std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()];
        [peer.source capturer:capturer didCaptureVideoFrame:frame];
    }];
}
