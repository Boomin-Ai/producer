// Narrow macOS device/GPU/encoder adapter. Rust owns layout, state, time and commands.
#import "room.h"
#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreText/CoreText.h>
#import <Metal/Metal.h>
#import <QuartzCore/QuartzCore.h>
#import <stdatomic.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

double nr_host_time(void) { return CACurrentMediaTime(); }
static NSString *const shader = @
"#include <metal_stdlib>\nusing namespace metal;\n"
"struct D { float4 rect,uv,color,color_to,border,metrics,surface,accent,material; float opacity; uint kind,source,reserved; };\n"
"struct V { float4 p [[position]]; float2 uv; };\n"
"vertex V vs(uint i [[vertex_id]], constant D& d [[buffer(0)]]) { const float2 v[6]={float2(0,0),float2(1,0),float2(0,1),float2(0,1),float2(1,0),float2(1,1)}; V o; o.uv=v[i]; float2 p=d.rect.xy+o.uv*d.rect.zw; o.p=float4(p.x*2-1,1-p.y*2,0,1);return o;}\n"
"fragment float4 fs(V v [[stage_in]], constant D& d [[buffer(0)]], texture2d<float> t [[texture(0)]]) { constexpr sampler s(filter::linear,address::clamp_to_edge); float2 sz=max(d.metrics.yz,float2(1)); float radius=clamp(d.metrics.x,0.,min(sz.x,sz.y)*.5); float2 q=abs((v.uv-.5)*sz)-sz*.5+radius; float sd=length(max(q,0.))+min(max(q.x,q.y),0.)-radius; float aa=max(fwidth(sd),.7); float mask=1-smoothstep(-aa*.5,aa*.5,sd); float2 dir=float2(cos(d.surface.x),sin(d.surface.x)); float ramp=clamp(dot((v.uv-.5)*sz,dir)/max(dot(abs(dir),sz),1.)+.5,0.,1.); float4 c=mix(d.color,d.color_to,ramp); if(d.material.x==1.){float phase=d.material.w*d.material.z*.08; float field=.5+.28*sin(v.uv.x*8.+v.uv.y*5.+phase)+.16*sin(v.uv.x*17.-v.uv.y*11.-phase*.7); float blend=clamp(.5+.5*sin(v.uv.x*4.+v.uv.y*3.+field*2.),0.,1.); c=mix(d.color,d.color_to,blend); c=mix(c,d.accent,smoothstep(.15,.95,v.uv.y)*.85); float2 cell=fract(v.uv*sz/max(d.material.y,2.))-.5; float dots=1.-smoothstep(.15,.27,length(cell)); c.rgb=clamp(c.rgb+float3((dots-.22)*.13),0.,1.); c.a*=clamp(.42+field*.65,0.,1.); } if(d.kind==1)c=t.sample(s,d.uv.xy+v.uv*d.uv.zw); if(d.kind==2)c=float4(d.color.rgb,d.color.a*t.sample(s,v.uv).a); if(d.surface.y>0.){float2 pixel=floor(v.uv*sz); float noise=fract(sin(dot(pixel,float2(12.9898,78.233)))*43758.5453)-.5; c.rgb=clamp(c.rgb+noise*d.surface.y,0.,1.);} float stroke=d.metrics.w>0.?smoothstep(-d.metrics.w-aa*.5,-d.metrics.w+aa*.5,sd)*d.border.a:0.; float alpha=stroke+c.a*(1-stroke); float3 rgb=alpha>0.?(d.border.rgb*stroke+c.rgb*c.a*(1-stroke))/alpha:float3(0);return float4(rgb,alpha*mask*d.opacity); }\n"
// Match GPUI's full-range BT.601 surface shader. Explicit metadata follows it.
"kernel void to_yuv(texture2d<float,access::read> c [[texture(0)]], texture2d<float,access::write> y [[texture(1)]], texture2d<float,access::write> uv [[texture(2)]], uint2 p [[thread_position_in_grid]]) { if(p.x>=c.get_width()||p.y>=c.get_height())return; float3 a=c.read(p).rgb; y.write(float4(dot(a,float3(.299,.587,.114))),p); if((p.x%2==0)&&(p.y%2==0)){ float3 b=(a+c.read(p+uint2(1,0)).rgb+c.read(p+uint2(0,1)).rgb+c.read(p+uint2(1,1)).rgb)*.25; uv.write(float4(dot(b,float3(-.168736,-.331264,.5))+.5,dot(b,float3(.5,-.418688,-.081312))+.5,0,1),p/2); }}\n";

@class NRRoom;
@interface NRFeed : NSObject<AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate>
@property(nonatomic,weak) NRRoom *room;
@property(nonatomic) uint32_t source;
@property(nonatomic) uint64_t generation;
@end

@interface NRRoom : NSObject<SCStreamOutput,SCStreamDelegate> {
@public
    void *_context; NRFrameCallback _frame; NRAudioCallback _audio; NRStatusCallback _status;
    AVCaptureSession *_camera, *_mic; NRFeed *_cameraFeed, *_micFeed;
    NSString *_cameraID, *_micID; uint64_t _cameraGeneration;
    SCStream *_screen; dispatch_queue_t _captureQueue, _screenQueue, _writerQueue;
    id<MTLDevice> _device; id<MTLCommandQueue> _gpuQueue;
    id<MTLRenderPipelineState> _pipeline; id<MTLComputePipelineState> _convert;
    CVMetalTextureCacheRef _cache; id<MTLTexture> _white;
    CVPixelBufferPoolRef _pool[2]; uint32_t _width[2],_height[2]; id<MTLTexture> _rgb[2];
    atomic_int _inflight; atomic_bool _closing, _screenRequested; atomic_int _writerPending,_audioWriterPending; atomic_bool _recordEnabled;
    AVAssetWriter *_writers[5]; AVAssetWriterInput *_video[5],*_sound[5];
    AVAssetWriterInputPixelBufferAdaptor *_adaptors[5]; id _delegates[5];
    uint32_t _trackWidth[5],_trackHeight[5],_trackCount;
    int _program[2],_original[2],_micTrack;
    BOOL _recording,_finishing; double _recordOrigin; atomic_uint_fast64_t _recordSession; atomic_uint _originalMask;
    NRSegmentCallback _segment; atomic_int _segmentInFlight;
}
- (void)status:(uint32_t)source text:(NSString*)text;
- (void)deliver:(uint32_t)source buffer:(CVPixelBufferRef)buffer pts:(double)pts generation:(uint64_t)gen;
@end

#include "recording.inc"

@implementation NRFeed
- (void)captureOutput:(AVCaptureOutput*)output didOutputSampleBuffer:(CMSampleBufferRef)s fromConnection:(AVCaptureConnection*)c {
    NRRoom *room=self.room; if(!room||atomic_load(&room->_closing))return;
    if(self.source==0 && self==room->_cameraFeed) { CVPixelBufferRef b=CMSampleBufferGetImageBuffer(s); if(b){double pts=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(s));if(!isfinite(pts))pts=nr_host_time();[room deliver:0 buffer:b pts:pts generation:self.generation];} }
    else if(room->_audio) {
        // AVCapture converts to bounded interleaved float32 48 kHz stereo.
        AudioStreamBasicDescription const *asbd=CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(s));
        CMBlockBufferRef bb=CMSampleBufferGetDataBuffer(s); char *data=NULL;size_t size=0;
        if(asbd && asbd->mSampleRate==48000 && asbd->mChannelsPerFrame==2 && asbd->mBytesPerFrame==8 && (asbd->mFormatFlags&kAudioFormatFlagIsFloat)
            && bb && CMBlockBufferGetDataPointer(bb,0,NULL,&size,&data)==kCMBlockBufferNoErr && size<=8*8192) {
            double stamp=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(s));
            if(isfinite(stamp))room->_audio(room->_context,(const float*)data,(uint32_t)(size/8),stamp+(double)(size/8)/48000.);
        }
    }
}
@end

@implementation NRRoom
- (void)status:(uint32_t)source text:(NSString*)text { if(_status&&!atomic_load(&_closing))_status(_context,source,(text?:@"Unknown media error").UTF8String); }
- (void)deliver:(uint32_t)source buffer:(CVPixelBufferRef)b pts:(double)pts generation:(uint64_t)gen {
    if(!atomic_load(&_closing)&&_frame)_frame(_context,source,(void*)b,pts,gen);
    if(source<2)recordVideo(self,source+2,b,pts);
}
- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)s ofType:(SCStreamOutputType)t {
    if(t!=SCStreamOutputTypeScreen||!CMSampleBufferIsValid(s))return;
    CFArrayRef attachments=CMSampleBufferGetSampleAttachmentsArray(s,false);
    if(attachments && CFArrayGetCount(attachments)>0) {
        NSDictionary *a=(__bridge NSDictionary*)CFArrayGetValueAtIndex(attachments,0);
        if([a[SCStreamFrameInfoStatus] integerValue]!=SCFrameStatusComplete)return;
    }
    CVPixelBufferRef b=CMSampleBufferGetImageBuffer(s);if(b){double pts=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(s));if(!isfinite(pts))pts=nr_host_time();[self deliver:1 buffer:b pts:pts generation:1];}
}
- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error { [self status:1 text:error.localizedDescription]; }
@end

static id<MTLTexture> cvtexture(NRRoom *r,CVPixelBufferRef b,MTLPixelFormat fmt,size_t width,size_t height,size_t plane,CVMetalTextureRef *keep) {
    CVReturn e=CVMetalTextureCacheCreateTextureFromImage(NULL,r->_cache,b,NULL,fmt,width,height,plane,keep);
    return e==kCVReturnSuccess?CVMetalTextureGetTexture(*keep):nil;
}

void *nr_create(void *ctx,NRFrameCallback frame,NRAudioCallback audio,NRStatusCallback status) {
    @autoreleasepool {
        NRRoom *r=[NRRoom new];r->_context=ctx;r->_frame=frame;r->_audio=audio;r->_status=status;
        atomic_init(&r->_closing,false);atomic_init(&r->_screenRequested,false);atomic_init(&r->_inflight,0);atomic_init(&r->_writerPending,0);atomic_init(&r->_audioWriterPending,0);atomic_init(&r->_recordEnabled,false);atomic_init(&r->_segmentInFlight,0);atomic_init(&r->_recordSession,0);atomic_init(&r->_originalMask,0);
        r->_original[0]=r->_original[1]=r->_micTrack=-1;
        r->_captureQueue=dispatch_queue_create("producer.native.capture",DISPATCH_QUEUE_SERIAL);
        r->_screenQueue=dispatch_queue_create("producer.native.screen",DISPATCH_QUEUE_SERIAL);
        r->_writerQueue=dispatch_queue_create("producer.native.writer",DISPATCH_QUEUE_SERIAL);
        r->_device=MTLCreateSystemDefaultDevice();r->_gpuQueue=[r->_device newCommandQueue];
        MTLTextureDescriptor *white=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:1 height:1 mipmapped:NO];white.storageMode=MTLStorageModeShared;white.usage=MTLTextureUsageShaderRead;
        r->_white=[r->_device newTextureWithDescriptor:white];uint32_t pixel=0xffffffff;[r->_white replaceRegion:MTLRegionMake2D(0,0,1,1) mipmapLevel:0 withBytes:&pixel bytesPerRow:4];
        NSError *e=nil;id<MTLLibrary> lib=[r->_device newLibraryWithSource:shader options:nil error:&e];
        if(!lib){[r status:9 text:e.localizedDescription];return NULL;}
        MTLRenderPipelineDescriptor *p=[MTLRenderPipelineDescriptor new];
        p.vertexFunction=[lib newFunctionWithName:@"vs"];p.fragmentFunction=[lib newFunctionWithName:@"fs"];
        p.colorAttachments[0].pixelFormat=MTLPixelFormatBGRA8Unorm;p.colorAttachments[0].blendingEnabled=YES;
        p.colorAttachments[0].sourceRGBBlendFactor=MTLBlendFactorSourceAlpha;p.colorAttachments[0].destinationRGBBlendFactor=MTLBlendFactorOneMinusSourceAlpha;
        p.colorAttachments[0].sourceAlphaBlendFactor=MTLBlendFactorOne;p.colorAttachments[0].destinationAlphaBlendFactor=MTLBlendFactorOneMinusSourceAlpha;
        r->_pipeline=[r->_device newRenderPipelineStateWithDescriptor:p error:&e];
        r->_convert=[r->_device newComputePipelineStateWithFunction:[lib newFunctionWithName:@"to_yuv"] error:&e];
        if(!r->_pipeline||!r->_convert||CVMetalTextureCacheCreate(NULL,NULL,r->_device,NULL,&r->_cache)!=kCVReturnSuccess)return NULL;
        return (__bridge_retained void*)r;
    }
}

static void startCamera(NRRoom *r) {
    dispatch_async(r->_captureQueue,^{@autoreleasepool {
        if(atomic_load(&r->_closing)||r->_camera)return;
        AVCaptureDevice *d=r->_cameraID?[AVCaptureDevice deviceWithUniqueID:r->_cameraID]:[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];NSError *e=nil;
        AVCaptureDeviceInput *input=[AVCaptureDeviceInput deviceInputWithDevice:d error:&e];
        if(!input){[r status:0 text:e.localizedDescription?:@"No camera connected"];return;}
        AVCaptureSession *s=[AVCaptureSession new];[s beginConfiguration];s.sessionPreset=AVCaptureSessionPreset1280x720;
        if(![s canAddInput:input]){[r status:0 text:@"Camera input unavailable"];return;}[s addInput:input];
        AVCaptureVideoDataOutput *out=[AVCaptureVideoDataOutput new];out.alwaysDiscardsLateVideoFrames=YES;
        out.videoSettings=@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA), (id)kCVPixelBufferMetalCompatibilityKey:@YES};
        r->_cameraFeed=[NRFeed new];r->_cameraFeed.room=r;r->_cameraFeed.source=0;r->_cameraFeed.generation=++r->_cameraGeneration;
        [out setSampleBufferDelegate:r->_cameraFeed queue:r->_captureQueue];
        if(![s canAddOutput:out]){[r status:0 text:@"Camera output unavailable"];return;}[s addOutput:out];[s commitConfiguration];
        if([d lockForConfiguration:&e]) {
            @try {for(AVFrameRateRange *range in d.activeFormat.videoSupportedFrameRateRanges){if(range.minFrameRate<=30&&range.maxFrameRate>=30){d.activeVideoMinFrameDuration=CMTimeMake(1,30);d.activeVideoMaxFrameDuration=CMTimeMake(1,30);break;}}}
            @catch(NSException *exception){[r status:0 text:@"Camera negotiated its native frame rate"];}
            @finally {[d unlockForConfiguration];}
        }
        r->_camera=s;[s startRunning];[r status:0 text:[@"Camera: " stringByAppendingString:d.localizedName]];
    }});
}
char *nr_cameras(void) {
    @autoreleasepool {NSMutableArray *result=[NSMutableArray new];
        for(AVCaptureDevice *d in [AVCaptureDevice devicesWithMediaType:AVMediaTypeVideo])
            [result addObject:@{@"id":d.uniqueID,@"name":d.localizedName,@"default":@([d.uniqueID isEqualToString:[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo].uniqueID])}];
        NSData *data=[NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
}
void nr_camera_device(void *handle,const char *device) {
    NRRoom *r=(__bridge NRRoom*)handle;NSString *identity=[NSString stringWithUTF8String:device];
    dispatch_async(r->_captureQueue,^{
        BOOL active=r->_camera!=nil;
        [r->_camera stopRunning];r->_camera=nil;r->_cameraFeed=nil;r->_cameraID=identity;
        // Selecting a device does not start an unapproved capture session.
        // Initial activation still goes through nr_capture's permission check.
        if(active&&[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]==AVAuthorizationStatusAuthorized)startCamera(r);
    });
}
static void startMic(NRRoom *r) {
    dispatch_async(r->_captureQueue,^{@autoreleasepool {
        if(atomic_load(&r->_closing)||r->_mic)return;
        NSError *e=nil;AVCaptureDevice *d=r->_micID?[AVCaptureDevice deviceWithUniqueID:r->_micID]:[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
        AVCaptureDeviceInput *input=[AVCaptureDeviceInput deviceInputWithDevice:d error:&e];
        if(!input){[r status:3 text:e.localizedDescription?:@"No microphone connected"];return;}
        AVCaptureSession *s=[AVCaptureSession new];[s beginConfiguration];
        AVCaptureAudioDataOutput *out=[AVCaptureAudioDataOutput new];
        out.audioSettings=@{AVFormatIDKey:@(kAudioFormatLinearPCM),AVSampleRateKey:@48000,AVNumberOfChannelsKey:@2,AVLinearPCMBitDepthKey:@32,AVLinearPCMIsFloatKey:@YES,AVLinearPCMIsNonInterleaved:@NO};
        r->_micFeed=[NRFeed new];r->_micFeed.room=r;r->_micFeed.source=3;
        [out setSampleBufferDelegate:r->_micFeed queue:r->_captureQueue];
        if(![s canAddInput:input]||![s canAddOutput:out]){[r status:3 text:@"Microphone format unavailable"];return;}
        [s addInput:input];[s addOutput:out];[s commitConfiguration];r->_mic=s;[s startRunning];[r status:3 text:@"Microphone starting"];
    }});
}
void nr_capture(void *handle,int camera,int screen,int mic) {
    NRRoom *r=(__bridge NRRoom*)handle;
    if(camera) { AVAuthorizationStatus s=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
        if(s==AVAuthorizationStatusNotDetermined)[AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL ok){if(ok)startCamera(r);else[r status:0 text:@"Allow Camera in macOS Privacy settings"];}];
        else if(s==AVAuthorizationStatusAuthorized)startCamera(r);else[r status:0 text:@"Allow Camera in macOS Privacy settings"];
    }
    if(mic) { AVAuthorizationStatus s=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
        if(s==AVAuthorizationStatusNotDetermined)[AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL ok){if(ok)startMic(r);else[r status:3 text:@"Allow Microphone in macOS Privacy settings"];}];
        else if(s==AVAuthorizationStatusAuthorized)startMic(r);else[r status:3 text:@"Allow Microphone in macOS Privacy settings"];
    }
    if(screen&&!atomic_exchange(&r->_screenRequested,true)) {
        // ScreenCaptureKit owns authorization for this provider. A separate
        // CoreGraphics preflight must not prevent the authorized request from
        // reaching it (notably after a local executable is rebuilt).
        [r status:1 text:@"Requesting screen capture"];
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *c,NSError *e){
            if(e||!c.displays.count){atomic_store(&r->_screenRequested,false);[r status:1 text:e.code==SCStreamErrorUserDeclined?@"Allow Screen Recording for Producer Native Dev in macOS Privacy settings":(e.localizedDescription?:@"No display available")];return;}
            if(atomic_load(&r->_closing))return;
            NSMutableArray *exclude=[NSMutableArray new];for(SCRunningApplication *a in c.applications)if(a.processID==getpid())[exclude addObject:a];
            SCContentFilter *f=[[SCContentFilter alloc] initWithDisplay:c.displays.firstObject excludingApplications:exclude exceptingWindows:@[]];
            SCStreamConfiguration *cfg=[SCStreamConfiguration new];cfg.width=1920;cfg.height=1080;cfg.minimumFrameInterval=CMTimeMake(1,30);cfg.queueDepth=3;cfg.pixelFormat=kCVPixelFormatType_32BGRA;cfg.showsCursor=YES;
            SCStream *s=[[SCStream alloc] initWithFilter:f configuration:cfg delegate:r];NSError *err=nil;
            if(![s addStreamOutput:r type:SCStreamOutputTypeScreen sampleHandlerQueue:r->_screenQueue error:&err]){atomic_store(&r->_screenRequested,false);[r status:1 text:err.localizedDescription];return;}
            r->_screen=s;[s startCaptureWithCompletionHandler:^(NSError *err){if(err){r->_screen=nil;atomic_store(&r->_screenRequested,false);}[r status:1 text:err.localizedDescription?:@"Screen sharing"];}];
        }];
    }
}

// Releasing a room source must release its capture without blocking the render lane.
void nr_capture_stop(void *handle,int source) {
    NRRoom *r=(__bridge NRRoom*)handle;
    if(source==1) {
        SCStream *stream=r->_screen;r->_screen=nil;
        atomic_store(&r->_screenRequested,false);
        [stream stopCaptureWithCompletionHandler:^(NSError *e){(void)e;}];
    } else dispatch_async(r->_captureQueue,^{
        if(source==0){[r->_camera stopRunning];r->_camera=nil;r->_cameraFeed=nil;}
        if(source==3){[r->_mic stopRunning];r->_mic=nil;r->_micFeed=nil;}
    });
}

// Independent capture endpoints share no GPU device, textures or output pools.
char *nr_microphones(void) {
    @autoreleasepool { NSMutableArray *result=[NSMutableArray new];
        for(AVCaptureDevice *d in [AVCaptureDevice devicesWithMediaType:AVMediaTypeAudio])
            [result addObject:@{@"id":d.uniqueID,@"name":d.localizedName,@"default":@([d.uniqueID isEqualToString:[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio].uniqueID])}];
        NSData *data=[NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
}
void nr_mic_device(void *handle,const char *device) {
    NRRoom *r=(__bridge NRRoom*)handle; NSString *identity=[NSString stringWithUTF8String:device];
    dispatch_async(r->_captureQueue,^{ BOOL active=r->_mic!=nil;
        [r->_mic stopRunning];r->_mic=nil;r->_micFeed=nil;r->_micID=identity;
        if(active&&[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]==AVAuthorizationStatusAuthorized)startMic(r);
    });
}
void *nr_input_create(void *ctx,NRFrameCallback frame,NRAudioCallback audio,NRStatusCallback status,int mic,const char *device) {
    @autoreleasepool { NRRoom *r=[NRRoom new];
        r->_context=ctx;r->_frame=frame;r->_audio=audio;r->_status=status;
        atomic_init(&r->_closing,false);atomic_init(&r->_recordEnabled,false);
        r->_captureQueue=dispatch_queue_create("producer.native.input",DISPATCH_QUEUE_SERIAL);
        NSString *identity=[NSString stringWithUTF8String:device];
        if(mic)r->_micID=identity;else r->_cameraID=identity;
        void *handle=(__bridge_retained void*)r;nr_capture(handle,!mic,0,mic);return handle;
    }
}
void nr_input_stop(void *handle) {
    NRRoom *r=(__bridge_transfer NRRoom*)handle;atomic_store(&r->_closing,true);
    dispatch_sync(r->_captureQueue,^{[r->_camera stopRunning];[r->_mic stopRunning];r->_cameraFeed=nil;r->_micFeed=nil;});
}

// Control-lane preparation; immutable textures are never rasterized per frame.
void *nr_text_cache(const NRText *specs,size_t count) {
    if(count>128)return NULL;
    @autoreleasepool {
        id<MTLDevice> device=MTLCreateSystemDefaultDevice();if(!device)return NULL;
        NSMutableArray *textures=[NSMutableArray arrayWithCapacity:count];uint64_t pixelsTotal=0;
        for(size_t i=0;i<count;i++) {
            NRText t=specs[i];size_t w=t.width,h=t.height;
            if(!t.value||w<1||h<1||w>4096||h>4096||!isfinite(t.font_size)||t.font_size<6||t.font_size>512||t.weight<100||t.weight>900||t.align>2)return NULL;
            pixelsTotal+=(uint64_t)w*h;if(pixelsTotal>8388608)return NULL;
            NSString *text=[NSString stringWithUTF8String:t.value];if(!text)return NULL;
            NSMutableData *pixels=[NSMutableData dataWithLength:w*h*4];CGColorSpaceRef cs=CGColorSpaceCreateDeviceRGB();
            CGContextRef c=CGBitmapContextCreate(pixels.mutableBytes,w,h,8,w*4,cs,kCGImageAlphaPremultipliedFirst|kCGBitmapByteOrder32Little);CGColorSpaceRelease(cs);if(!c)return NULL;
            CGFloat weights[9]={NSFontWeightUltraLight,NSFontWeightThin,NSFontWeightLight,NSFontWeightRegular,NSFontWeightMedium,NSFontWeightSemibold,NSFontWeightBold,NSFontWeightHeavy,NSFontWeightBlack};
            NSFont *font=[NSFont systemFontOfSize:t.font_size weight:weights[MIN(8,(t.weight-100)/100)]];
            NSMutableParagraphStyle *paragraph=[NSMutableParagraphStyle new];paragraph.alignment=t.align==1?NSTextAlignmentCenter:(t.align==2?NSTextAlignmentRight:NSTextAlignmentLeft);
            NSAttributedString *string=[[NSAttributedString alloc] initWithString:text attributes:@{NSFontAttributeName:font,NSForegroundColorAttributeName:NSColor.whiteColor,NSParagraphStyleAttributeName:paragraph}];
            CTFramesetterRef setter=CTFramesetterCreateWithAttributedString((__bridge CFAttributedStringRef)string);CGPathRef path=CGPathCreateWithRect(CGRectMake(0,0,w,h),NULL);
            CTFrameRef frame=CTFramesetterCreateFrame(setter,CFRangeMake(0,0),path,NULL);CTFrameDraw(frame,c);CFRelease(frame);CGPathRelease(path);CFRelease(setter);CGContextRelease(c);
            MTLTextureDescriptor *d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w height:h mipmapped:NO];d.storageMode=MTLStorageModeShared;d.usage=MTLTextureUsageShaderRead;
            id<MTLTexture> texture=[device newTextureWithDescriptor:d];if(!texture)return NULL;
            [texture replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:pixels.bytes bytesPerRow:w*4];[textures addObject:texture];
        }
        return (__bridge_retained void*)[textures copy];
    }
}
void nr_text_cache_release(void *cache) { if(cache)CFRelease(cache); }

int nr_prepare(void *handle,uint32_t w0,uint32_t h0,uint32_t w1,uint32_t h1) {
    NRRoom *r=(__bridge NRRoom*)handle;uint32_t w[2]={w0,w1},h[2]={h0,h1};
    CVPixelBufferPoolRef pools[2]={NULL,NULL};id<MTLTexture> textures[2]={nil,nil};BOOL ok=YES;
    for(int i=0;i<2&&ok;i++){
        if(w[i]<64||h[i]<64||w[i]>4096||h[i]>4096||w[i]%2||h[i]%2||(uint64_t)w[i]*h[i]>8847360){ok=NO;break;}
        if(r->_width[i]==w[i]&&r->_height[i]==h[i])continue;
        NSDictionary *a=@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange),(id)kCVPixelBufferWidthKey:@(w[i]),(id)kCVPixelBufferHeightKey:@(h[i]),(id)kCVPixelBufferIOSurfacePropertiesKey:@{},(id)kCVPixelBufferMetalCompatibilityKey:@YES};
        ok=CVPixelBufferPoolCreate(NULL,(__bridge CFDictionaryRef)@{(id)kCVPixelBufferPoolMinimumBufferCountKey:@3},(__bridge CFDictionaryRef)a,&pools[i])==kCVReturnSuccess;
        MTLTextureDescriptor *d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w[i] height:h[i] mipmapped:NO];d.storageMode=MTLStorageModePrivate;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageRenderTarget;
        textures[i]=[r->_device newTextureWithDescriptor:d];ok=ok&&textures[i]!=nil;
        CVPixelBufferRef probe=NULL;if(ok)ok=CVPixelBufferPoolCreatePixelBuffer(NULL,pools[i],&probe)==kCVReturnSuccess;if(probe)CVPixelBufferRelease(probe);
    }
    if(ok)for(int i=0;i<2;i++)if(pools[i]){if(r->_pool[i])CFRelease(r->_pool[i]);r->_pool[i]=pools[i];pools[i]=NULL;r->_rgb[i]=textures[i];r->_width[i]=w[i];r->_height[i]=h[i];}
    for(int i=0;i<2;i++)if(pools[i])CFRelease(pools[i]);return ok?1:0;
}
int nr_render(void *handle,uint32_t output,uint32_t w,uint32_t h,const NRDraw *draws,size_t count,void **sources,void *textCache,double pts,uint64_t generation) {
    NRRoom *r=(__bridge NRRoom*)handle;
    if(output>1||count>1024||w<64||h<64||w>4096||h>4096||w%2||h%2||atomic_load(&r->_closing))return 0;
    if(atomic_fetch_add(&r->_inflight,1)>=4){atomic_fetch_sub(&r->_inflight,1);return 0;}
    @autoreleasepool {
        if(r->_width[output]!=w||r->_height[output]!=h){atomic_fetch_sub(&r->_inflight,1);return 0;}
        CVPixelBufferRef result=NULL;
        if(CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(NULL,r->_pool[output],(__bridge CFDictionaryRef)@{(id)kCVPixelBufferPoolAllocationThresholdKey:@3},&result)!=kCVReturnSuccess){atomic_fetch_sub(&r->_inflight,1);return 0;}
        CVBufferSetAttachment(result,kCVImageBufferYCbCrMatrixKey,kCVImageBufferYCbCrMatrix_ITU_R_601_4,kCVAttachmentMode_ShouldPropagate);
        CVBufferSetAttachment(result,kCVImageBufferColorPrimariesKey,kCVImageBufferColorPrimaries_ITU_R_709_2,kCVAttachmentMode_ShouldPropagate);
        CVBufferSetAttachment(result,kCVImageBufferTransferFunctionKey,kCVImageBufferTransferFunction_ITU_R_709_2,kCVAttachmentMode_ShouldPropagate);
        id<MTLCommandBuffer> command=[r->_gpuQueue commandBuffer];
        MTLRenderPassDescriptor *pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=r->_rgb[output];pass.colorAttachments[0].loadAction=MTLLoadActionClear;pass.colorAttachments[0].storeAction=MTLStoreActionStore;pass.colorAttachments[0].clearColor=MTLClearColorMake(.018,.027,.038,1);
        id<MTLRenderCommandEncoder> encoder=[command renderCommandEncoderWithDescriptor:pass];[encoder setRenderPipelineState:r->_pipeline];
        CVMetalTextureRef keep[8]={0};id<MTLTexture> textures[8]={nil};
        CVPixelBufferRef held[8]={0};
        for(int i=0;i<8;i++)if(sources[i]){held[i]=CVPixelBufferRetain((CVPixelBufferRef)sources[i]);textures[i]=cvtexture(r,held[i],MTLPixelFormatBGRA8Unorm,CVPixelBufferGetWidth(held[i]),CVPixelBufferGetHeight(held[i]),0,&keep[i]);}
        NSArray *text=(__bridge NSArray*)textCache;
        [encoder setFragmentTexture:r->_white atIndex:0];
        for(size_t i=0;i<count;i++) {
            NRDraw d=draws[i];id<MTLTexture> texture=nil;
            if(d.kind==1){if(d.source>=8||!textures[d.source])continue;texture=textures[d.source];}
            if(d.kind==2){if(d.source>=text.count)continue;texture=text[d.source];}
            [encoder setVertexBytes:&d length:sizeof(d) atIndex:0];[encoder setFragmentBytes:&d length:sizeof(d) atIndex:0];
            if(texture)[encoder setFragmentTexture:texture atIndex:0];
            [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:6];
        }
        [encoder endEncoding];
        CVMetalTextureRef y=NULL,uv=NULL;id<MTLTexture> yt=cvtexture(r,result,MTLPixelFormatR8Unorm,w,h,0,&y),uvt=cvtexture(r,result,MTLPixelFormatRG8Unorm,w/2,h/2,1,&uv);
        if(!yt||!uvt){if(y)CFRelease(y);if(uv)CFRelease(uv);for(int i=0;i<8;i++){if(keep[i])CFRelease(keep[i]);if(held[i])CVPixelBufferRelease(held[i]);}CVPixelBufferRelease(result);atomic_fetch_sub(&r->_inflight,1);return 0;}
        id<MTLComputeCommandEncoder> convert=[command computeCommandEncoder];[convert setComputePipelineState:r->_convert];[convert setTexture:r->_rgb[output] atIndex:0];[convert setTexture:yt atIndex:1];[convert setTexture:uvt atIndex:2];
        [convert dispatchThreads:MTLSizeMake(w,h,1) threadsPerThreadgroup:MTLSizeMake(16,16,1)];[convert endEncoding];
        struct {CVMetalTextureRef k[8];CVPixelBufferRef b[8];} resources;
        memcpy(resources.k,keep,sizeof(keep));memcpy(resources.b,held,sizeof(held));
        [command addCompletedHandler:^(id<MTLCommandBuffer> cb){@autoreleasepool {
            if(cb.status==MTLCommandBufferStatusCompleted) {
                [r deliver:10+output buffer:result pts:pts generation:generation];
                recordVideo(r,output,result,pts);
            } else [r status:9 text:cb.error.localizedDescription?:@"GPU frame failed"];
            for(int i=0;i<8;i++){if(resources.k[i])CFRelease(resources.k[i]);if(resources.b[i])CVPixelBufferRelease(resources.b[i]);}
            CFRelease(y);CFRelease(uv);CVPixelBufferRelease(result);atomic_fetch_sub(&r->_inflight,1);
        }}];[command commit];return 1;
    }
}


void nr_stop(void *handle) {
    NRRoom *r=(__bridge_transfer NRRoom*)handle;atomic_store(&r->_closing,true);
    [r->_screen stopCaptureWithCompletionHandler:^(NSError *e){(void)e;}];
    dispatch_sync(r->_captureQueue,^{[r->_camera stopRunning];[r->_mic stopRunning];});
    while(atomic_load(&r->_inflight)>0)usleep(1000);
    dispatch_sync(r->_writerQueue,^{r->_recording=NO;atomic_store(&r->_recordEnabled,false);for(int i=0;i<5;i++)if(r->_writers[i].status==AVAssetWriterStatusWriting)[r->_writers[i] cancelWriting];});
    while(atomic_load(&r->_segmentInFlight)>0)usleep(1000);
    for(int i=0;i<2;i++)if(r->_pool[i])CFRelease(r->_pool[i]);if(r->_cache)CFRelease(r->_cache);
}

@interface NRMovie : NSObject {
@public AVURLAsset *_asset;AVAssetReader *_reader;AVAssetReaderTrackOutput *_output;
    CMSampleBufferRef _held,_next;double _position,_duration,_frameDuration;uint64_t _generation;atomic_bool _cancelled;
}
@end
@implementation NRMovie
- (void)dealloc { if(_held)CFRelease(_held);if(_next)CFRelease(_next);[_reader cancelReading]; }
@end
void *nr_movie_open(const char *path,double *duration) {
    @autoreleasepool {
        NRMovie *m=[NRMovie new];atomic_init(&m->_cancelled,false);
        m->_asset=[AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:path]] options:@{AVURLAssetPreferPreciseDurationAndTimingKey:@YES}];
        AVAssetTrack *track=[m->_asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
        if(!track)return NULL;
        m->_duration=CMTimeGetSeconds(CMTimeRangeGetEnd(track.timeRange));
        m->_frameDuration=track.nominalFrameRate>0?1.0/track.nominalFrameRate:1.0/30;
        if(!isfinite(m->_duration)||m->_duration<=0)return NULL;
        *duration=m->_duration;m->_position=-1;return (__bridge_retained void*)m;
    }
}
double nr_movie_start(void *handle) {
    NRMovie *m=(__bridge NRMovie*)handle;
    return CMTimeGetSeconds([m->_asset tracksWithMediaType:AVMediaTypeVideo].firstObject.timeRange.start);
}
void *nr_movie_frame(void *handle,double at,uint64_t generation) {
    @autoreleasepool {
        NRMovie *m=(__bridge NRMovie*)handle;if(atomic_load(&m->_cancelled)||at<0||at>=m->_duration)return NULL;
        if(!m->_reader||at<m->_position||at-m->_position>.25||m->_generation!=generation) {
            [m->_reader cancelReading];if(m->_held){CFRelease(m->_held);m->_held=NULL;}if(m->_next){CFRelease(m->_next);m->_next=NULL;}
            NSError *e=nil;m->_reader=[[AVAssetReader alloc] initWithAsset:m->_asset error:&e];
            AVAssetTrack *t=[m->_asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
            m->_output=[[AVAssetReaderTrackOutput alloc] initWithTrack:t outputSettings:@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA),(id)kCVPixelBufferMetalCompatibilityKey:@YES,(id)kCVPixelBufferIOSurfacePropertiesKey:@{}}];m->_output.alwaysCopiesSampleData=NO;
            if(![m->_reader canAddOutput:m->_output])return NULL;[m->_reader addOutput:m->_output];
            CMTime start=CMTimeMakeWithSeconds(MAX(0,at-.1),60000);m->_reader.timeRange=CMTimeRangeMake(start,CMTimeSubtract(m->_asset.duration,start));
            if(![m->_reader startReading]){NSLog(@"MOV reader: %@",m->_reader.error);return NULL;}m->_generation=generation;m->_position=-1;
        }
        // Present the last sample whose PTS is at/before the requested time.
        // Sample durations are not a coverage guarantee (VFR and rounding can
        // leave tiny gaps). Keep one lookahead instead of returning a blank
        // whenever the next decoded frame is slightly in the future.
        double deadline=nr_host_time()+1;
        for(int i=0;i<60&&!atomic_load(&m->_cancelled)&&nr_host_time()<deadline;i++) {
            if(!m->_next)m->_next=[m->_output copyNextSampleBuffer];
            if(!m->_next)break;
            double stamp=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(m->_next));
            if(!isfinite(stamp))return NULL;
            if(stamp>at+1e-7)break;
            if(m->_held)CFRelease(m->_held);
            m->_held=m->_next;m->_next=NULL;
        }
        m->_position=at;
        if(atomic_load(&m->_cancelled)||!m->_held)return NULL;
        return (void*)CVPixelBufferRetain(CMSampleBufferGetImageBuffer(m->_held));
    }
}
void nr_movie_cancel(void *handle) { NRMovie *m=(__bridge NRMovie*)handle;atomic_store(&m->_cancelled,true);[m->_reader cancelReading]; }
void nr_movie_close(void *handle) { NRMovie *m=(__bridge_transfer NRMovie*)handle;[m->_reader cancelReading]; }

// Audio uses an independent reader on the same bounded media worker. A source
// seek invalidates its generation; program time never follows the source seek.
@interface NRAudioReader : NSObject { @public AVURLAsset *_asset;AVAssetReader *_reader;AVAssetReaderTrackOutput *_output;CMSampleBufferRef _held;double _position;uint64_t _generation; }
@end
@implementation NRAudioReader
- (void)dealloc {if(_held)CFRelease(_held);[_reader cancelReading];}
@end
void *nr_audio_open(const char *path) {
    @autoreleasepool {NRAudioReader *m=[NRAudioReader new];m->_asset=[AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:[NSString stringWithUTF8String:path]] options:nil];if(![m->_asset tracksWithMediaType:AVMediaTypeAudio].count)return NULL;m->_position=-1;return (__bridge_retained void*)m;}
}
double nr_audio_start(void *handle) {
    NRAudioReader *m=(__bridge NRAudioReader*)handle;
    return CMTimeGetSeconds([m->_asset tracksWithMediaType:AVMediaTypeAudio].firstObject.timeRange.start);
}
int nr_audio_read(void *handle,double at,uint64_t generation,float *out,uint32_t frames) {
    @autoreleasepool {
        if(!handle||!out||frames>480)return 0;NRAudioReader *m=(__bridge NRAudioReader*)handle;
        memset(out,0,frames*8);
        if(!m->_reader||at<m->_position-0.00001||at-m->_position>0.05||generation!=m->_generation){
            [m->_reader cancelReading];if(m->_held){CFRelease(m->_held);m->_held=NULL;}
            NSError *e=nil;m->_reader=[[AVAssetReader alloc] initWithAsset:m->_asset error:&e];
            AVAssetTrack *t=[m->_asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
            m->_output=[[AVAssetReaderTrackOutput alloc] initWithTrack:t outputSettings:@{AVFormatIDKey:@(kAudioFormatLinearPCM),AVSampleRateKey:@48000,AVNumberOfChannelsKey:@2,AVLinearPCMBitDepthKey:@32,AVLinearPCMIsFloatKey:@YES,AVLinearPCMIsNonInterleaved:@NO}];m->_output.alwaysCopiesSampleData=NO;
            if(![m->_reader canAddOutput:m->_output])return 0;[m->_reader addOutput:m->_output];
            CMTime start=CMTimeMakeWithSeconds(MAX(0,at-.02),48000);m->_reader.timeRange=CMTimeRangeMake(start,CMTimeSubtract(m->_asset.duration,start));
            if(![m->_reader startReading])return 0;m->_generation=generation;
        }
        int mixed=0;int64_t wanted=llround(at*48000),end=wanted+frames;
        for(int reads=0;reads<16;reads++){
            if(!m->_held)m->_held=[m->_output copyNextSampleBuffer];if(!m->_held)break;
            int64_t start=llround(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(m->_held))*48000);int64_t count=CMSampleBufferGetNumSamples(m->_held);
            if(start>=end)break;CMBlockBufferRef bb=CMSampleBufferGetDataBuffer(m->_held);char *data=NULL;size_t size=0;
            AudioStreamBasicDescription const *fmt=CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(m->_held));
            if(!fmt||fmt->mSampleRate!=48000||fmt->mBytesPerFrame!=8||fmt->mChannelsPerFrame!=2)return 0;
            int64_t a=MAX(start,wanted),b=MIN(start+count,end);
            if(b>a&&bb&&CMBlockBufferGetDataPointer(bb,0,NULL,&size,&data)==0&&(size_t)count*8<=size){memcpy(out+(a-wanted)*2,data+(a-start)*8,(b-a)*8);mixed+=(int)(b-a);}
            if(start+count>=end)break;CFRelease(m->_held);m->_held=NULL;
        }
        m->_position=at+(double)frames/48000;return mixed;
    }
}
void nr_audio_close(void *handle){NRAudioReader *m=(__bridge_transfer NRAudioReader*)handle;[m->_reader cancelReading];}
