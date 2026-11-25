#import "sdk/objc/api/video_frame_buffer/RTCNativeMutableI420Buffer.h"
// Producer RTC: one device-to-device WebRTC endpoint. No room service or SFU.
// The parent exchanges descriptions over stdin/stdout and owns the session lifetime.
#import <AVFoundation/AVFoundation.h>
#import "RTCPeerConnectionFactory.h"
#import "RTCPeerConnection.h"
#import "RTCConfiguration.h"
#import "RTCDataChannel.h"
#import "RTCDataChannelConfiguration.h"
#import "RTCMediaConstraints.h"
#import "RTCSessionDescription.h"
#import "RTCIceServer.h"
#import "RTCIceCandidate.h"
#import "RTCStatisticsReport.h"
#import "RTCAudioTrack.h"
#import "RTCAudioProcessingState.h"
#import "RTCVideoTrack.h"
#import "RTCVideoCodecInfo.h"
#import "RTCVideoSource.h"
#import "RTCRtpReceiver.h"
#import "RTCSSLAdapter.h"
#import "sdk/objc/components/capturer/RTCCameraVideoCapturer.h"
#import "sdk/objc/base/RTCVideoRenderer.h"
#import "sdk/objc/base/RTCVideoFrame.h"
#import "sdk/objc/base/RTCI420Buffer.h"
#import "sdk/objc/base/RTCAudioRenderer.h"
#include "libyuv.h"
#include <atomic>
#include <mach/mach.h>
#include <sys/resource.h>
#include <unistd.h>
#include <vector>

static int programFD = -1;
static std::atomic_int rehearsalWarmPermille{0}, rehearsalToneHz{0};
static std::atomic_int rehearsalHz{541};
static std::atomic_ulong audioCallbacks{0}, videoCallbacks{0}, delivered{0};
static std::atomic_int writeError{0}, inputRate{0},inputSize{0};
static void emit(NSDictionary *event) {
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    @synchronized ([NSFileHandle fileHandleWithStandardOutput]) {
        fwrite(bytes.bytes, 1, bytes.length, stdout); fputc('\n', stdout); fflush(stdout);
    }
}
static void fail(NSString *reason) { emit(@{@"phase":@"failed", @"reason":reason}); exit(1); }

@interface StudioPeer : NSObject <RTCPeerConnectionDelegate, RTCVideoRenderer, RTCAudioRenderer, RTCDataChannelDelegate>
@property RTCPeerConnectionFactory *factory;
@property RTCPeerConnection *pc;
@property RTCVideoSource *source;
@property RTCCameraVideoCapturer *camera;
@property RTCAudioTrack *mic;
@property RTCAudioTrack *receivedAudio;
@property (atomic) BOOL guestMuted;
@property RTCVideoTrack *receivedVideo;
@property RTCVideoTrack *video;
@property RTCDataChannel *tally;
@property BOOL operatorSide;
@property BOOL stageMonitor;
@property BOOL staged;
@property BOOL fixture;
@property BOOL localSet;
@property BOOL descriptionSent;
@property dispatch_queue_t mediaQueue;
@property dispatch_semaphore_t audioBudget;
@property dispatch_semaphore_t videoBudget;
@end

@implementation StudioPeer
- (void)sendDescription {
    @synchronized (self) {
        if (self.descriptionSent || !self.localSet || self.pc.iceGatheringState != RTCIceGatheringStateComplete) return;
        RTCSessionDescription *s = self.pc.localDescription;
        if (![s.sdp containsString:@"a=candidate:"]) fail(@"No reachable interface for a direct call");
        self.descriptionSent = YES;
        emit(@{@"description":@{@"protocol":@"producer-rtc/1", @"type":s.type == RTCSdpTypeOffer ? @"offer" : @"answer", @"sdp":s.sdp}});
    }
}
- (void)makeDescription:(BOOL)offer {
    if (offer) {
        self.operatorSide=YES;
        self.tally=[self.pc dataChannelForLabel:@"producer-stage/1" configuration:[RTCDataChannelConfiguration new]];
        self.tally.delegate=self;
    }
    RTCMediaConstraints *constraints = [[RTCMediaConstraints alloc] initWithMandatoryConstraints:nil optionalConstraints:nil];
    RTCCreateSessionDescriptionCompletionHandler ready = ^(RTCSessionDescription *s, NSError *error) {
        if (error || !s) fail(@"Could not create the direct call description");
        [self.pc setLocalDescription:s completionHandler:^(NSError *e) {
            if (e) fail(@"Could not prepare the direct call");
            @synchronized (self) { self.localSet = YES; }
            [self sendDescription];
        }];
    };
    if (offer) [self.pc offerForConstraints:constraints completionHandler:ready];
    else [self.pc answerForConstraints:constraints completionHandler:ready];
}
- (void)apply:(NSDictionary*)d {
    if (![d[@"protocol"] isEqual:@"producer-rtc/1"] || ![d[@"sdp"] isKindOfClass:NSString.class] ||
        !([d[@"type"] isEqual:@"offer"] || [d[@"type"] isEqual:@"answer"]) || [d[@"sdp"] length] > 65536 ||
        [d[@"sdp"] containsString:@" typ relay"]) fail(@"Invalid direct-only call code");
    BOOL offer = [d[@"type"] isEqual:@"offer"];
    if (self.fixture && offer) rehearsalHz.store(730);
    RTCSessionDescription *remote = [[RTCSessionDescription alloc] initWithType:offer ? RTCSdpTypeOffer : RTCSdpTypeAnswer sdp:d[@"sdp"]];
    [self.pc setRemoteDescription:remote completionHandler:^(NSError *error) {
        if (error) fail(@"The code does not match this call");
        if (offer) [self makeDescription:NO];
    }];
}
- (void)peerConnection:(RTCPeerConnection*)p didChangeConnectionState:(RTCPeerConnectionState)s {
    NSArray *names = @[@"new",@"connecting",@"connected",@"disconnected",@"failed",@"closed"];
    if ((NSUInteger)s < names.count) emit(@{@"phase":names[s]});
}
- (void)peerConnection:(RTCPeerConnection*)p didChangeIceGatheringState:(RTCIceGatheringState)s { [self sendDescription]; }
- (void)peerConnection:(RTCPeerConnection*)p didChangeSignalingState:(RTCSignalingState)s {}
- (void)peerConnection:(RTCPeerConnection*)p didAddStream:(RTCMediaStream*)s {}
- (void)peerConnection:(RTCPeerConnection*)p didRemoveStream:(RTCMediaStream*)s {}
- (void)peerConnectionShouldNegotiate:(RTCPeerConnection*)p {}
- (void)peerConnection:(RTCPeerConnection*)p didChangeIceConnectionState:(RTCIceConnectionState)s {}
- (void)peerConnection:(RTCPeerConnection*)p didGenerateIceCandidate:(RTCIceCandidate*)c {}
- (void)peerConnection:(RTCPeerConnection*)p didRemoveIceCandidates:(NSArray*)c {}
- (void)peerConnection:(RTCPeerConnection*)p didOpenDataChannel:(RTCDataChannel*)c {
    if (self.operatorSide || ![c.label isEqual:@"producer-stage/1"] || self.tally) { [c close]; return; }
    self.tally=c; c.delegate=self;
}
- (void)publishTally {
    if (!self.operatorSide || self.tally.readyState!=RTCDataChannelStateOpen) return;
    uint8_t value=self.staged?1:0;
    [self.tally sendData:[[RTCDataBuffer alloc] initWithData:[NSData dataWithBytes:&value length:1] isBinary:YES]];
}
- (void)dataChannelDidChangeState:(RTCDataChannel*)channel {
    dispatch_async(dispatch_get_main_queue(),^{ [self publishTally]; });
}
- (void)dataChannel:(RTCDataChannel*)channel didReceiveMessageWithBuffer:(RTCDataBuffer*)buffer {
    if (self.operatorSide || channel!=self.tally || !buffer.isBinary || buffer.data.length!=1) return;
    uint8_t value=*(const uint8_t*)buffer.data.bytes;
    if (value<=1) emit(@{@"stageTally":@(value==1)});
}
- (void)peerConnection:(RTCPeerConnection*)p didAddReceiver:(RTCRtpReceiver*)r streams:(NSArray*)s {
    if ([r.track isKindOfClass:RTCAudioTrack.class]) {self.receivedAudio=(RTCAudioTrack*)r.track; self.receivedAudio.isEnabled=!self.guestMuted; [self.receivedAudio addRenderer:self];}
    if ([r.track isKindOfClass:RTCVideoTrack.class]) {self.receivedVideo=(RTCVideoTrack*)r.track; [self.receivedVideo addRenderer:self];}
}
- (void)setSize:(CGSize)size {}
// FD 3 is a bounded, process-local media pipe to the native mixer/compositor.
- (void)enqueue:(NSData*)packet budget:(dispatch_semaphore_t)budget {
    dispatch_async(self.mediaQueue, ^{
        const uint8_t *p = (const uint8_t*)packet.bytes; size_t left = packet.length;
        while (left) { ssize_t n = write(programFD,p,left); if (n <= 0) {writeError=errno;break;} p += n; left -= n; }
        if (!left) delivered++;
        dispatch_semaphore_signal(budget);
    });
}
- (void)renderFrame:(RTCVideoFrame*)frame {
    videoCallbacks++;
    if (programFD < 0 || !frame || dispatch_semaphore_wait(self.videoBudget, DISPATCH_TIME_NOW)) return;
    id<RTCI420Buffer> b = [frame.buffer toI420];
    if (!b || b.width<=0 || b.height<=0) { dispatch_semaphore_signal(self.videoBudget); return; }
    // Size for the upright picture before handing it to the bounded room reader.
    const bool quarterTurn=frame.rotation==90 || frame.rotation==270;
    const int maxWidth=quarterTurn?360:640, maxHeight=quarterTurn?640:360;
    if (b.width>maxWidth || b.height>maxHeight || ((b.width|b.height)&1)) {
        const double scale=std::min({1.0,double(maxWidth)/b.width,double(maxHeight)/b.height});
        const int w=std::max(2,int(b.width*scale)&~1), h=std::max(2,int(b.height*scale)&~1);
        RTCMutableI420Buffer *scaled=[[RTCMutableI420Buffer alloc] initWithWidth:w height:h];
        if (!scaled || libyuv::I420Scale(b.dataY,b.strideY,b.dataU,b.strideU,b.dataV,b.strideV,
                b.width,b.height,scaled.mutableDataY,scaled.strideY,scaled.mutableDataU,scaled.strideU,
                scaled.mutableDataV,scaled.strideV,w,h,libyuv::kFilterBilinear)) {
            dispatch_semaphore_signal(self.videoBudget); return;
        }
        b=scaled;
    }
    if (frame.rotation!=0) {
        RTCMutableI420Buffer *upright=[[RTCMutableI420Buffer alloc] initWithWidth:quarterTurn?b.height:b.width
                height:quarterTurn?b.width:b.height];
        if (!upright || libyuv::I420Rotate(b.dataY,b.strideY,b.dataU,b.strideU,b.dataV,b.strideV,
                upright.mutableDataY,upright.strideY,upright.mutableDataU,upright.strideU,
                upright.mutableDataV,upright.strideV,b.width,b.height,(libyuv::RotationMode)frame.rotation)) {
            dispatch_semaphore_signal(self.videoBudget); return;
        }
        b=upright;
    }
    if (self.fixture) {
        int warm=0,total=0;
        for(int y=b.height/4;y<3*b.height/4;y+=8) for(int x=b.width/4;x<3*b.width/4;x+=8) {
            warm+=b.dataV[(y/2)*b.strideV+x/2]>144 && b.dataU[(y/2)*b.strideU+x/2]<106;
            total++;
        }
        rehearsalWarmPermille=1000*warm/std::max(1,total);
    }
    if(self.stageMonitor && ((b.width|b.height)&1)){dispatch_semaphore_signal(self.videoBudget);return;}
    size_t bytes=self.stageMonitor?b.width*b.height*3/2:b.width*b.height*4;
    NSMutableData *packet = [NSMutableData dataWithLength:5 + bytes];
    uint8_t *out = (uint8_t*)packet.mutableBytes;
    out[0]=self.stageMonitor?'N':'W'; uint16_t w=b.width,h=b.height; memcpy(out+1,&w,2); memcpy(out+3,&h,2);
    if(self.stageMonitor) libyuv::I420ToNV12(b.dataY,b.strideY,b.dataU,b.strideU,b.dataV,b.strideV,out+5,w,out+5+w*h,w,w,h);
    else libyuv::I420ToARGB(b.dataY,b.strideY,b.dataU,b.strideU,b.dataV,b.strideV,out+5,w*4,w,h);
    // Local People monitor, sampled from the same decoded camera as the program.
    if (!self.stageMonitor) {
        const double scale=std::min(160.0/w,90.0/h);
        const uint16_t tw=std::max(2,int(w*scale)&~1), th=std::max(2,int(h*scale)&~1);
        RTCMutableI420Buffer *thumb=[[RTCMutableI420Buffer alloc] initWithWidth:tw height:th];
        if (!libyuv::I420Scale(b.dataY,b.strideY,b.dataU,b.strideU,b.dataV,b.strideV,w,h,
                thumb.mutableDataY,thumb.strideY,thumb.mutableDataU,thumb.strideU,
                thumb.mutableDataV,thumb.strideV,tw,th,libyuv::kFilterBilinear)) {
            NSUInteger offset=packet.length;
            [packet increaseLengthBy:5+tw*th*3/2];
            uint8_t *header=(uint8_t*)packet.mutableBytes+offset;
            header[0]='T'; memcpy(header+1,&tw,2); memcpy(header+3,&th,2);
            uint8_t *nv12=header+5;
            libyuv::I420ToNV12(thumb.dataY,thumb.strideY,thumb.dataU,thumb.strideU,
                thumb.dataV,thumb.strideV,nv12,tw,nv12+tw*th,tw,tw,th);
        }
    }
    [self enqueue:packet budget:self.videoBudget];
}
- (void)renderPCMBuffer:(AVAudioPCMBuffer*)pcm {
    if (self.guestMuted) return;
    audioCallbacks++;inputRate=pcm.format.sampleRate;inputSize=pcm.frameLength;
    if (programFD < 0 || pcm.format.sampleRate != 48000 || pcm.frameLength != 480 || !pcm.format.channelCount) return;
    if (dispatch_semaphore_wait(self.audioBudget,DISPATCH_TIME_NOW)) return;
    NSMutableData *p=[NSMutableData dataWithLength:961]; uint8_t *o=(uint8_t*)p.mutableBytes; o[0]='A';
    for (int i=0;i<480;i++) {
        int idx=i*(pcm.format.isInterleaved?pcm.format.channelCount:1); int16_t v=0;
        if (pcm.int16ChannelData) v=pcm.int16ChannelData[0][idx];
        else if (pcm.floatChannelData) v=lrintf(fmaxf(-1,fminf(1,pcm.floatChannelData[0][idx]))*32767);
        memcpy(o+1+i*2,&v,2);
    }
    if(self.fixture) {
        double power[2]={};
        const int frequencies[]={541,730};
        for(int f=0;f<2;f++){
            double omega=2*M_PI*frequencies[f]/48000.,coef=2*cos(omega),last=0,prev=0;
            for(int i=0;i<480;i++){int16_t v;memcpy(&v,o+1+2*i,2);double next=v+coef*last-prev;prev=last;last=next;}
            power[f]=last*last+prev*prev-coef*last*prev;
        }
        if(std::max(power[0],power[1])>1e8) rehearsalToneHz=power[0]>power[1]?541:730;
    }
    [self enqueue:p budget:self.audioBudget];
}
- (void)stats {
    [self.pc statisticsWithCompletionHandler:^(RTCStatisticsReport *report) {
        NSMutableDictionary *summary=[NSMutableDictionary dictionary];
        task_vm_info_data_t memory={}; mach_msg_type_number_t count=TASK_VM_INFO_COUNT;
        if(task_info(mach_task_self(),TASK_VM_INFO,(task_info_t)&memory,&count)==KERN_SUCCESS)
            summary[@"footprintBytes"]=@(memory.phys_footprint);
        struct rusage cpu={};
        if(getrusage(RUSAGE_SELF,&cpu)==0) summary[@"cpuSeconds"]=@(cpu.ru_utime.tv_sec+cpu.ru_stime.tv_sec+(cpu.ru_utime.tv_usec+cpu.ru_stime.tv_usec)/1e6);
        summary[@"mediaHandoff"]=@{@"audioCallbacks":@(audioCallbacks.load()),@"videoCallbacks":@(videoCallbacks.load()),@"packetsWritten":@(delivered.load()),@"writeErrno":@(writeError.load()),@"audioRate":@(inputRate.load()),@"audioFrames":@(inputSize.load())};
        summary[@"thermalState"]=@(NSProcessInfo.processInfo.thermalState);
        unsigned publicCandidates=0;
        for (RTCStatistics *stat in report.statistics.allValues) {
            NSDictionary *v=stat.values;
            if ([stat.type isEqual:@"local-candidate"] && [v[@"candidateType"] isEqual:@"srflx"]) publicCandidates++;
            if ([stat.type isEqual:@"transport"] && v[@"selectedCandidatePairId"]) {
                NSDictionary *pair=report.statistics[v[@"selectedCandidatePairId"]].values;
                for (NSString *side in @[@"local",@"remote"]) {
                    NSString *key=[side stringByAppendingString:@"CandidateId"];
                    summary[side]=report.statistics[pair[key]].values[@"candidateType"] ?: @"unknown";
                }
                for (NSString *key in @[@"bytesSent",@"bytesReceived",@"currentRoundTripTime"]) if(pair[key]) summary[key]=pair[key];
            }
            if ([v[@"kind"] isEqual:@"audio"] && ([stat.type isEqual:@"media-source"] || [stat.type isEqual:@"outbound-rtp"])) {
                NSMutableDictionary *audio=[NSMutableDictionary dictionary];
                for (NSString *key in @[@"audioLevel",@"totalAudioEnergy",@"totalSamplesDuration",@"packetsSent",@"bytesSent"])
                    if(v[key]) audio[key]=v[key];
                summary[[stat.type isEqual:@"media-source"]?@"microphoneSource":@"microphoneSend"]=audio;
            }
            if ([stat.type isEqual:@"outbound-rtp"] && [v[@"kind"] isEqual:@"video"]) {
                summary[@"videoFramesEncoded"]=v[@"framesEncoded"] ?: @0;
            }
            if ([stat.type isEqual:@"inbound-rtp"] && v[@"kind"]) {
                NSMutableDictionary *track=[NSMutableDictionary dictionary];
                for (NSString *key in @[@"bytesReceived",@"packetsReceived",@"packetsLost",@"framesDecoded",@"jitter",@"concealedSamples",@"totalSamplesReceived"]) if(v[key]) track[key]=v[key];
                summary[v[@"kind"]]=track;
            }
        }
        if(!self.fixture) {
            RTCAudioProcessingComponentState *aec=self.factory.audioProcessingState.echoCancellation;
            summary[@"echoCancellation"]=@{@"softwareActive":@(aec.softwareActive),@"platformActive":@(aec.platformActive)};
        }
        if(self.fixture) summary[@"rehearsalToneHz"]=@(rehearsalToneHz.load());
        if(self.fixture) summary[@"rehearsalWarmPermille"]=@(rehearsalWarmPermille.load());
        summary[@"publicCandidates"]=@(publicCandidates);
        emit(@{@"stats":summary});
    }];
}
@end
#include "rehearsal.inc"
int main(int argc, const char **argv) { @autoreleasepool {
    if(getenv("PRODUCER_RTC_MEDIA_FD")) programFD=atoi(getenv("PRODUCER_RTC_MEDIA_FD"));
    signal(SIGPIPE,SIG_IGN); RTCInitializeSSL();
    NSArray *args=NSProcessInfo.processInfo.arguments;
    StudioPeer *peer=[StudioPeer new];
    peer.stageMonitor=[args containsObject:@"--stage-monitor"];
    peer.fixture=[args containsObject:@"--rehearsal"];
    peer.mediaQueue=dispatch_queue_create("producer.rtc.program",DISPATCH_QUEUE_SERIAL);
    peer.audioBudget=dispatch_semaphore_create(12); peer.videoBudget=dispatch_semaphore_create(2);
    RTCDefaultVideoEncoderFactory *enc=[RTCDefaultVideoEncoderFactory new];
    for (RTCVideoCodecInfo *codec in RTCDefaultVideoEncoderFactory.supportedCodecs) if ([codec.name isEqual:@"VP8"]) {enc.preferredCodec=codec;break;}
    RTCDefaultVideoDecoderFactory *dec=[RTCDefaultVideoDecoderFactory new];
    if(peer.fixture) peer.factory=[[RTCPeerConnectionFactory alloc] initWithEncoderFactory:enc decoderFactory:dec audioDevice:[RehearsalAudio new]];
    else peer.factory=[[RTCPeerConnectionFactory alloc] initWithEncoderFactory:enc decoderFactory:dec];
    RTCConfiguration *config=[RTCConfiguration new];
    config.sdpSemantics=RTCSdpSemanticsUnifiedPlan;
    config.continualGatheringPolicy=RTCContinualGatheringPolicyGatherOnce;
    if(![args containsObject:@"--lan"]) config.iceServers=@[[[RTCIceServer alloc] initWithURLStrings:@[@"stun:stun.cloudflare.com:3478"]]];
    RTCMediaConstraints *constraints=[[RTCMediaConstraints alloc] initWithMandatoryConstraints:nil optionalConstraints:nil];
    peer.pc=[peer.factory peerConnectionWithConfiguration:config constraints:constraints delegate:peer];
    if(!peer.pc) fail(@"Could not initialize native WebRTC");
    peer.mic=[peer.factory audioTrackWithTrackId:@"studio-mic"];
    if(!peer.fixture) {
        RTCAudioProcessingOptionsResult *result=[peer.mic setAudioProcessingOptions:RTCAudioProcessingOptions.communicationOptions];
        if(!result.success) emit(@{@"warning":@"Could not apply voice processing to the studio microphone"});
    }
    peer.mic.isEnabled=![args containsObject:@"--start-muted"];
    emit(@{@"microphoneEnabled":@(peer.mic.isEnabled)});
    peer.source=[peer.factory videoSource];
    [peer.source adaptOutputFormatToWidth:640 height:360 fps:30];
    peer.video=[peer.factory videoTrackWithSource:peer.source trackId:@"studio-camera"];
    [peer.pc addTrack:peer.mic streamIds:@[@"producer"]]; [peer.pc addTrack:peer.video streamIds:@[@"producer"]];
    if(getenv("PRODUCER_STAGE_RETURN_FD")) {
        int fd=atoi(getenv("PRODUCER_STAGE_RETURN_FD"));
        RTCVideoCapturer *capture=[[RTCVideoCapturer alloc] initWithDelegate:peer.source];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
            std::vector<uint8_t> nv12(640*360*3/2);
            while(true) { @autoreleasepool {
                size_t n=0;
                while(n<nv12.size()) {
                    ssize_t got=read(fd,nv12.data()+n,nv12.size()-n);
                    if(got<=0) return;
                    n+=got;
                }
                RTCMutableI420Buffer *b=[[RTCMutableI420Buffer alloc] initWithWidth:640 height:360];
                libyuv::NV12ToI420(nv12.data(),640,nv12.data()+640*360,640,b.mutableDataY,b.strideY,b.mutableDataU,b.strideU,b.mutableDataV,b.strideV,640,360);
                auto ns=std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
                [peer.source capturer:capture didCaptureVideoFrame:[[RTCVideoFrame alloc] initWithBuffer:b rotation:RTCVideoRotation_0 timeStampNs:ns]];
            }}
        });
    } else if(peer.fixture) rehearsalVideo(peer);
    else if ([args containsObject:@"--camera"]) {
        peer.camera=[[RTCCameraVideoCapturer alloc] initWithDelegate:peer.source];
        AVCaptureDevice *device=RTCCameraVideoCapturer.captureDevices.firstObject;
        AVCaptureDeviceFormat *format=nil;
        for(AVCaptureDeviceFormat *f in (device ? [RTCCameraVideoCapturer supportedFormatsForDevice:device] : @[])) {
            CMVideoDimensions dims=CMVideoFormatDescriptionGetDimensions(f.formatDescription);
            if(dims.width==640 && f.videoSupportedFrameRateRanges.firstObject.maxFrameRate>=30) {format=f; break;}
        }
        if(device && format) [peer.camera startCaptureWithDevice:device format:format fps:30 completionHandler:^(NSError *err){if(err) emit(@{@"warning":@"Camera unavailable"});}];
    }
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{
        char line[120000];
        while(fgets(line,sizeof(line),stdin)) { @autoreleasepool {
            if(!strchr(line,'\n')) fail(@"Call code too large");
            NSDictionary *cmd=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:line length:strlen(line)] options:0 error:nil];
            if(![cmd isKindOfClass:NSDictionary.class]) fail(@"Invalid call command");
            dispatch_async(dispatch_get_main_queue(),^{
                if([cmd[@"offer"] isEqual:@YES]) [peer makeDescription:YES];
                else if([cmd[@"microphone"] isKindOfClass:NSNumber.class]) {peer.mic.isEnabled=[cmd[@"microphone"] boolValue];emit(@{@"microphoneEnabled":@(peer.mic.isEnabled)});}
                else if([cmd[@"camera"] isKindOfClass:NSNumber.class]) {peer.video.isEnabled=[cmd[@"camera"] boolValue];emit(@{@"cameraEnabled":@(peer.video.isEnabled)});}
                else if(peer.operatorSide && [cmd[@"guestMuted"] isKindOfClass:NSNumber.class]) {
                    peer.guestMuted=[cmd[@"guestMuted"] boolValue];
                    peer.receivedAudio.isEnabled=!peer.guestMuted;
                    emit(@{@"guestMuted":@(peer.guestMuted)});
                }
                else if(peer.operatorSide && [cmd[@"stage"] isKindOfClass:NSNumber.class]) { peer.staged=[cmd[@"stage"] boolValue]; [peer publishTally]; }
                else if([cmd[@"description"] isKindOfClass:NSDictionary.class]) [peer apply:cmd[@"description"]];
            });
        }}
        _exit(0);
    });
    [NSTimer scheduledTimerWithTimeInterval:1 repeats:YES block:^(NSTimer*t){[peer stats];}];
    [NSRunLoop.currentRunLoop run];
    return 0;
}}
