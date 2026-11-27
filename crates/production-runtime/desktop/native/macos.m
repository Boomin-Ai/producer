// Narrow macOS device/GPU/encoder adapter. Rust owns layout, state, time and commands.
#import "room.h"
#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <AVKit/AVKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreImage/CoreImage.h>
#import <CoreText/CoreText.h>
#import <Metal/Metal.h>
#import <VideoToolbox/VideoToolbox.h>
#import <QuartzCore/QuartzCore.h>
#import <stdatomic.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

// Called only from the guest's explicit Join action on the AppKit main thread.
bool nr_guest_join_name(char *out, size_t capacity) {
    NSAlert *alert=[NSAlert new];
    alert.messageText=@"Join room";
    alert.informativeText=@"Choose the name the operator sees in People.";
    NSTextField *field=[[NSTextField alloc] initWithFrame:NSMakeRect(0,0,270,26)];
    field.placeholderString=@"Display name";alert.accessoryView=field;
    [alert addButtonWithTitle:@"Join"];[alert addButtonWithTitle:@"Cancel"];
    alert.window.initialFirstResponder=field;
    if ([alert runModal]!=NSAlertFirstButtonReturn)return false;
    NSString *value=field.stringValue;
    if (value.length>48)value=[value substringWithRange:[value rangeOfComposedCharacterSequencesForRange:NSMakeRange(0,48)]];
    return [value getCString:out maxLength:capacity encoding:NSUTF8StringEncoding];
}
@interface NRClipPreview : NSObject<NSWindowDelegate>
@property(nonatomic,strong) NSWindow *window;
@property(nonatomic,strong) AVPlayerView *view;
@end
@implementation NRClipPreview
- (void)windowWillClose:(NSNotification*)notification {
    (void)notification;
    [self.view.player pause];
    self.view.player=nil;
}
@end

bool nr_clip_preview(const char *path) {
    if(![NSThread isMainThread] || !path)return false;
    NSString *file=[NSString stringWithUTF8String:path];
    if(!file || ![NSFileManager.defaultManager fileExistsAtPath:file])return false;
    static NRClipPreview *preview;
    if(!preview){
        preview=[NRClipPreview new];
        preview.window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,720,440)
                  styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable
                  backing:NSBackingStoreBuffered defer:NO];
        preview.window.delegate=preview;
        preview.window.releasedWhenClosed=NO;
        preview.view=[AVPlayerView new];
        preview.view.controlsStyle=AVPlayerViewControlsStyleInline;
        preview.window.contentView=preview.view;
        [preview.window center];
    }
    [preview.view.player pause];
    preview.view.player=[AVPlayer playerWithURL:[NSURL fileURLWithPath:file]];
    preview.window.title=file.lastPathComponent;
    [preview.window makeKeyAndOrderFront:nil];
    [preview.view.player play];
    return true;
}
double nr_host_time(void) { return CACurrentMediaTime(); }
static NSString *const shader = @
"#include <metal_stdlib>\nusing namespace metal;\n"
"struct D { float4 rect,uv,color,color_to,border,metrics,surface,accent,material,clip_grade; float opacity; uint kind,source,reserved; };\n"
"struct V { float4 p [[position]]; float2 uv; };\n"
"vertex V vs(uint i [[vertex_id]], constant D& d [[buffer(0)]]) { const float2 v[6]={float2(0,0),float2(1,0),float2(0,1),float2(0,1),float2(1,0),float2(1,1)}; V o; o.uv=v[i]; float2 p=d.rect.xy+o.uv*d.rect.zw; if(d.surface.z!=0.){float2 center=d.rect.xy+.5*d.rect.zw;float2 v=(p-center)*float2(d.surface.w,1);float c=cos(d.surface.z),s=sin(d.surface.z);p=center+float2(v.x*c-v.y*s,v.x*s+v.y*c)/float2(d.surface.w,1);} o.p=float4(p.x*2-1,1-p.y*2,0,1);return o;}\n"
// Offset the signed distance before calculating both coverage and stroke.
// Work in centered canvas pixels so the inset camera and bezel stay in phase.
"float camera_edge_distance(float distance, float2 centered, float seconds) {\n"
"  if(distance < -12.) return distance;\n"
"  float angle = atan2(centered.y, centered.x);\n"
"  return distance + 3.5 * (1. + sin(5. * angle - seconds * 1.57079633)); }\n"
// Each integer crossing of this moving scalar field is one gold contour.
"float contour_field(float2 uv, float phase) {\n"
"  float u=uv.x, v=uv.y;\n"
"  return 12.*u + 3.*v + 2.1*sin(6.*v+2.*u+.48*sin(phase))\n"
"         + 1.3*sin(7.*u-3.*v+.44*sin(2.*phase)) - phase/6.283185307; }\n"
"float4 contour_ink(float2 uv, constant D& d) {\n"
"  float field=contour_field(uv,d.material.w);\n"
"  float gradient=length(float2(dfdx(field),dfdy(field)));\n"
"  float pixels=abs(field-round(field))/max(gradient,.00001);\n"
"  float halfWidth=.5*d.material.y;\n"
"  float line=1.-smoothstep(halfWidth-.5,halfWidth+.5,pixels);\n"
"  return float4(d.color.rgb,d.color.a*line*(.22+.78*uv.x)); }\n"
"fragment float4 fs(V v [[stage_in]], constant D& d [[buffer(0)]], texture2d<float> t [[texture(0)]]) { constexpr sampler s(filter::linear,address::clamp_to_edge); float2 sz=max(d.metrics.yz,float2(1)); float radius=clamp(d.metrics.x,0.,min(sz.x,sz.y)*.5); float2 q=abs((v.uv-.5)*sz)-sz*.5+radius; float sd=length(max(q,0.))+min(max(q.x,q.y),0.)-radius; if(d.material.x==2.) sd=camera_edge_distance(sd,(v.uv-.5)*sz,d.material.w); float aa=max(fwidth(sd),.7); float mask=1-smoothstep(-aa*.5,aa*.5,sd); float2 dir=float2(cos(d.surface.x),sin(d.surface.x)); float ramp=clamp(dot((v.uv-.5)*sz,dir)/max(dot(abs(dir),sz),1.)+.5,0.,1.); float4 c=mix(d.color,d.color_to,ramp); if(d.material.x==1.){float phase=d.material.w*d.material.z*.08; float field=.5+.28*sin(v.uv.x*8.+v.uv.y*5.+phase)+.16*sin(v.uv.x*17.-v.uv.y*11.-phase*.7); float blend=clamp(.5+.5*sin(v.uv.x*4.+v.uv.y*3.+field*2.),0.,1.); c=mix(d.color,d.color_to,blend); c=mix(c,d.accent,smoothstep(.15,.95,v.uv.y)*.85); float2 cell=fract(v.uv*sz/max(d.material.y,2.))-.5; float dots=1.-smoothstep(.15,.27,length(cell)); c.rgb=clamp(c.rgb+float3((dots-.22)*.13),0.,1.); c.a*=clamp(.42+field*.65,0.,1.); } if(d.material.x==3.) c=contour_ink(v.uv,d); if(d.kind==1||d.kind==3){c=t.sample(s,d.uv.xy+v.uv*d.uv.zw); if(any(d.clip_grade!=0.)){float y=dot(c.rgb,float3(.2126,.7152,.0722));c.rgb=clamp(mix(float3(y),c.rgb,1.+d.clip_grade.w)*(1.+d.clip_grade.xyz),0.,1.);}} if(d.kind==2)c=float4(d.color.rgb,d.color.a*t.sample(s,v.uv).a); if(d.surface.y>0.){float2 pixel=floor(v.uv*sz); float noise=fract(sin(dot(pixel,float2(12.9898,78.233)))*43758.5453)-.5; c.rgb=clamp(c.rgb+noise*d.surface.y,0.,1.);} float stroke=d.metrics.w>0.?smoothstep(-d.metrics.w-aa*.5,-d.metrics.w+aa*.5,sd)*d.border.a:0.; float alpha=stroke+c.a*(1-stroke); float3 rgb=alpha>0.?(d.border.rgb*stroke+c.rgb*c.a*(1-stroke))/alpha:float3(0);return float4(rgb,alpha*mask*d.opacity); }\n"
// Match GPUI's full-range BT.601 surface shader. Explicit metadata follows it.
"kernel void camera_grade(texture2d<float,access::read> src [[texture(0)]], texture2d<float,access::write> dst [[texture(1)]], constant float4& g [[buffer(0)]], uint2 p [[thread_position_in_grid]]) {\n"
"  if(p.x>=src.get_width() || p.y>=src.get_height())return; float4 c=src.read(p);\n"
"  float3 rgb=c.rgb*exp2(g.x/2.2)*float3(1.+.2*g.w,1.,1.-.2*g.w);\n"
"  rgb=(rgb-.5)*(1.+g.y)+.5; float luma=dot(rgb,float3(.2126,.7152,.0722));\n"
"  dst.write(float4(clamp(mix(float3(luma),rgb,1.+g.z),0.,1.),c.a),p); }\n"
"kernel void to_yuv(texture2d<float,access::read> c [[texture(0)]], texture2d<float,access::write> y [[texture(1)]], texture2d<float,access::write> uv [[texture(2)]], uint2 q [[thread_position_in_grid]]) { if(q.x>=uv.get_width()||q.y>=uv.get_height())return; uint2 p=q*2; float3 a=c.read(p).rgb,b=c.read(p+uint2(1,0)).rgb,d=c.read(p+uint2(0,1)).rgb,e=c.read(p+uint2(1,1)).rgb; float3 l=float3(.299,.587,.114); y.write(float4(dot(a,l)),p); y.write(float4(dot(b,l)),p+uint2(1,0)); y.write(float4(dot(d,l)),p+uint2(0,1)); y.write(float4(dot(e,l)),p+uint2(1,1)); float3 mean=(a+b+d+e)*.25; uv.write(float4(dot(mean,float3(-.168736,-.331264,.5))+.5,dot(mean,float3(.5,-.418688,-.081312))+.5,0,1),q); }\n";

@class NRRoom;
@interface NRFeed : NSObject<AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate>
@property(nonatomic,weak) NRRoom *room;
@property(nonatomic) uint32_t source;
@property(nonatomic) uint64_t generation;
@end

typedef struct { atomic_bool ready; uint64_t session; int stage, output; double pts, wall; } P0Timing;
typedef enum {
    NRScreenAny, NRScreenWindow, NRScreenDisplay, NRScreenStop
} NRScreenTarget;
@interface NRRoom : NSObject<SCStreamOutput,SCStreamDelegate> {
@public
    void *_context; NRFrameCallback _frame; NRAudioCallback _audio; NRStatusCallback _status;
    AVCaptureSession *_camera, *_mic; NRFeed *_cameraFeed, *_micFeed;
    id<MTLTexture> _graphSurfaces[2][64], _graphDepth[2], _graphEmpty;
    id<MTLSamplerState> _graphSampler;
    BOOL _profileRehearsal; NSDictionary *_profileResult[2]; uint64_t _profileGeneration[2];
    NSString *_cameraID, *_micID; uint64_t _cameraGeneration;
    SCStream *_screen;
    id _screenPickerObserver;
    BOOL _screenPickerPending, _screenUpdating;
    NRScreenTarget _screenPickerTarget, _screenTarget;
    NSString *_screenSharingStatus;
    uint64_t _screenRequestGeneration;
    dispatch_queue_t _captureQueue, _screenQueue, _writerQueue;
    id<MTLDevice> _device; id<MTLCommandQueue> _gpuQueue;
    id<MTLRenderPipelineState> _pipeline; id<MTLComputePipelineState> _convert, _cameraGrade;
    id<MTLTexture> _graded[2][8];
    CVMetalTextureCacheRef _cache; id<MTLTexture> _white;
    BOOL _pressure; atomic_bool _pressureArmed, _pressurePinned; dispatch_queue_t _pressureLog;
    NSObject *_commitGate[2]; double _lastCommittedPTS[2];
    CVPixelBufferPoolRef _pool[2]; uint32_t _width[2],_height[2]; id<MTLTexture> _rgb[2];
    atomic_int _inflight, _outputInFlight[2], _retainedAfterCompletion; atomic_bool _closing, _screenRequested; atomic_int _writerPending,_audioWriterPending; atomic_bool _pairedHDWriter; atomic_bool _recordEnabled;
    AVAssetWriter *_writers[5]; AVAssetWriterInput *_video[5],*_sound[5];
    AVAssetWriterInputPixelBufferAdaptor *_adaptors[5]; id _delegates[5];
    uint32_t _trackWidth[5],_trackHeight[5],_trackCount;
    int _program[2],_original[2],_micTrack;
    atomic_bool _p0OldBudget, _p0HoldSurface; id _recordActivity; BOOL _recording,_finishing; double _recordOrigin; atomic_uint_fast64_t _recordSession; atomic_uint _originalMask, _programMask;
    atomic_int _p0StallLane; P0Timing *_timing; atomic_uint _timingCount; NSString *_timingHome;
    NRRoom *_clipWriter;
    NRRoom *_liveWriter;
    BOOL _streamEncoding;
    NRSegmentCallback _segment; atomic_int _segmentInFlight;
}
- (void)status:(uint32_t)source text:(NSString*)text;
- (void)deliver:(uint32_t)source buffer:(CVPixelBufferRef)buffer pts:(double)pts generation:(uint64_t)gen;
@end

// The opt-in probe uses bounded memory only on render/GPU/encoder threads.
static void endScreenShare(NRRoom *r);

static void timing(NRRoom *r,int stage,int output,double pts) {
    if(!r->_timing || !atomic_load(&r->_recordEnabled))return;
    unsigned i=atomic_fetch_add(&r->_timingCount,1);
    if(i>=65536)return;
    P0Timing *v=&r->_timing[i];
    v->session=atomic_load(&r->_recordSession); v->stage=stage; v->output=output;
    v->pts=pts; v->wall=nr_host_time(); atomic_store(&v->ready,true);
}
// A completed Metal command no longer consumes a GPU admission slot.
static void finishCommand(NRRoom *r,uint32_t output) {
    atomic_fetch_sub(&r->_outputInFlight[output],1);
    atomic_fetch_sub(&r->_inflight,1);
}
static void saveTiming(NRRoom *r,uint64_t session) {
    if(!r->_timing)return;
    NSString *file=[r->_timingHome stringByAppendingPathComponent:[NSString stringWithFormat:@"timing-%llu.csv",(unsigned long long)session]];
    FILE *f=fopen(file.fileSystemRepresentation,"w"); if(!f)return;
    fprintf(f,"stage,output,pts,wall\n");
    unsigned n=MIN(atomic_load(&r->_timingCount),65536u);
    for(unsigned i=0;i<n;i++){P0Timing *v=&r->_timing[i];if(atomic_load(&v->ready)&&v->session==session)fprintf(f,"%d,%d,%.9f,%.9f\n",v->stage,v->output,v->pts,v->wall);}
    fclose(f);
}
// Opt-in diagnostic in the isolated Native Dev room. Only one lane can claim the fault.
static void p0Stall(NRRoom *r, int lane, double pts) {
    if (atomic_load(&r->_p0StallLane) != lane || pts - r->_recordOrigin < 7.0) return;
    int expected = lane;
    if (!atomic_compare_exchange_strong(&r->_p0StallLane, &expected, 0)) return;
    double start = nr_host_time();
    [NSThread sleepForTimeInterval:0.200];
    double end = nr_host_time();
    uint64_t session = atomic_load(&r->_recordSession);
    NSString *path = [r->_timingHome stringByAppendingPathComponent:
        [NSString stringWithFormat:@"stall-%llu.json", (unsigned long long)session]];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0), ^{
        NSDictionary *receipt = @{@"lane":@(lane), @"start":@(start), @"end":@(end),
            @"origin":@(r->_recordOrigin), @"pts":@(pts), @"session":@(session)};
        [[NSJSONSerialization dataWithJSONObject:receipt options:0 error:nil] writeToFile:path atomically:YES];
    });
}
#include "p0_pressure.inc"
#include "recording.inc"

// Capture sessions can use different device clocks. The mixer and program
// writer compare against host time, so convert before crossing into Rust.
static double sampleHostTime(AVCaptureSession *session, CMSampleBufferRef sample) {
    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
    CMClockRef captureClock = session.synchronizationClock;
    CMClockRef hostClock = CMClockGetHostTimeClock();
    if (captureClock && captureClock != hostClock) {
        pts = CMSyncConvertTime(pts, captureClock, hostClock);
    }
    return CMTimeGetSeconds(pts);
}

@implementation NRFeed
- (void)captureOutput:(AVCaptureOutput*)output didOutputSampleBuffer:(CMSampleBufferRef)s fromConnection:(AVCaptureConnection*)c {
    NRRoom *room=self.room; if(!room||atomic_load(&room->_closing))return;
    if(self.source==0 && self==room->_cameraFeed) {
        CVPixelBufferRef b=CMSampleBufferGetImageBuffer(s);
        if(b){
            double pts=sampleHostTime(room->_camera,s);
            if(!isfinite(pts))pts=nr_host_time();
            [room deliver:0 buffer:b pts:pts generation:self.generation];
        }
    } else if(self.source==3 && self==room->_micFeed && room->_audio) {
        // AVCapture converts to bounded interleaved float32 48 kHz stereo.
        AudioStreamBasicDescription const *asbd=CMAudioFormatDescriptionGetStreamBasicDescription(CMSampleBufferGetFormatDescription(s));
        CMBlockBufferRef bb=CMSampleBufferGetDataBuffer(s); char *data=NULL;size_t size=0;
        if(asbd && asbd->mSampleRate==48000 && asbd->mChannelsPerFrame==2 && asbd->mBytesPerFrame==8 && (asbd->mFormatFlags&kAudioFormatFlagIsFloat)
            && bb && CMBlockBufferGetDataPointer(bb,0,NULL,&size,&data)==kCMBlockBufferNoErr && size<=8*8192) {
            double stamp=sampleHostTime(room->_mic,s);
            if(isfinite(stamp))room->_audio(room->_context,(const float*)data,(uint32_t)(size/8),stamp+(double)(size/8)/48000.);
        }
    }
}
@end

@implementation NRRoom
- (void)dealloc { free(_timing); }
- (void)status:(uint32_t)source text:(NSString*)text { if(_status&&!atomic_load(&_closing))_status(_context,source,(text?:@"Unknown media error").UTF8String); }
- (void)deliver:(uint32_t)source buffer:(CVPixelBufferRef)b pts:(double)pts generation:(uint64_t)gen {
    if(!atomic_load(&_closing)&&_frame)_frame(_context,source,(void*)b,pts,gen);
    if(source<2)recordVideo(self,source+2,b,pts);
}
- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)s ofType:(SCStreamOutputType)t {
    if (t!=SCStreamOutputTypeScreen || !CMSampleBufferIsValid(s)
        || !atomic_load(&_screenRequested) || atomic_load(&_closing)) return;
    @synchronized(self) {
    if (stream != _screen) return;
    CFArrayRef attachments=CMSampleBufferGetSampleAttachmentsArray(s,false);
    if(attachments && CFArrayGetCount(attachments)>0) {
        NSDictionary *a=(__bridge NSDictionary*)CFArrayGetValueAtIndex(attachments,0);
        SCFrameStatus status=[a[SCStreamFrameInfoStatus] integerValue];
        if(status!=SCFrameStatusComplete && status!=SCFrameStatusStarted)return;
    }
    CVPixelBufferRef b=CMSampleBufferGetImageBuffer(s);if(b){double pts=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(s));if(!isfinite(pts))pts=nr_host_time();[self deliver:1 buffer:b pts:pts generation:1];}
    }
}
- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (stream != self->_screen || atomic_load(&self->_closing)) return;
        endScreenShare(self);
        [self status:1 text:error.localizedDescription ?: @"Screen sharing stopped"];
    });
}
@end

static NRRoom *createClipWriter(void *context) {
    NRRoom *writer=[NRRoom new];
    writer->_context=context;
    writer->_writerQueue=dispatch_queue_create("producer.native.clips",DISPATCH_QUEUE_SERIAL);
    atomic_init(&writer->_closing,false);
    atomic_init(&writer->_pairedHDWriter,false);
    atomic_init(&writer->_writerPending,0);
    atomic_init(&writer->_audioWriterPending,0);
    atomic_init(&writer->_recordEnabled,false);
    atomic_init(&writer->_segmentInFlight,0);
    atomic_init(&writer->_recordSession,0);
    atomic_init(&writer->_originalMask,0);
    atomic_init(&writer->_programMask,0);
    return writer;
}
int nr_clip_start(void *handle,uint64_t session,double origin,const NRRecordTrack *tracks,size_t count,NRSegmentCallback callback) {
    NRRoom *r=(__bridge NRRoom*)handle;
    return nr_record_start((__bridge void*)r->_clipWriter,session,origin,tracks,count,callback);
}
void nr_clip_stop(void *handle) {
    NRRoom *r=(__bridge NRRoom*)handle;
    nr_record_stop((__bridge void*)r->_clipWriter);
}

int nr_live_start(void *handle,uint64_t session,double origin,const NRRecordTrack *tracks,size_t count,NRSegmentCallback callback) {
    NRRoom *r=(__bridge NRRoom*)handle;
    return nr_record_start((__bridge void*)r->_liveWriter,session,origin,tracks,count,callback);
}
void nr_live_stop(void *handle) {
    NRRoom *r=(__bridge NRRoom*)handle;
    nr_record_stop((__bridge void*)r->_liveWriter);
}

static id<MTLTexture> cvtexture(NRRoom *r,CVPixelBufferRef b,MTLPixelFormat fmt,size_t width,size_t height,size_t plane,CVMetalTextureRef *keep) {
    CVReturn e=CVMetalTextureCacheCreateTextureFromImage(NULL,r->_cache,b,NULL,fmt,width,height,plane,keep);
    return e==kCVReturnSuccess?CVMetalTextureGetTexture(*keep):nil;
}

#include "rehearsal_timing.inc"
#include "render_graph.inc"

uint64_t nr_device_registry_id(void *room) {
    NRRoom *r = (__bridge NRRoom *)room;
    return r->_device.registryID;
}

void *nr_create(void *ctx,NRFrameCallback frame,NRAudioCallback audio,NRStatusCallback status) {
    @autoreleasepool {
        NRRoom *r=[NRRoom new];r->_context=ctx;r->_frame=frame;r->_audio=audio;r->_status=status;
        atomic_init(&r->_closing,false);atomic_init(&r->_screenRequested,false);atomic_init(&r->_p0OldBudget,false);atomic_init(&r->_p0HoldSurface,false);atomic_init(&r->_inflight,0);atomic_init(&r->_retainedAfterCompletion,0);for(int i=0;i<2;i++)atomic_init(&r->_outputInFlight[i],0);atomic_init(&r->_pairedHDWriter,false);atomic_init(&r->_writerPending,0);atomic_init(&r->_audioWriterPending,0);atomic_init(&r->_recordEnabled,false);atomic_init(&r->_segmentInFlight,0);atomic_init(&r->_recordSession,0);atomic_init(&r->_originalMask,0);atomic_init(&r->_programMask,0);
        NSString *home=NSProcessInfo.processInfo.environment[@"PRODUCER_NATIVE_ROOM_HOME"];
        if(home && [[NSFileManager defaultManager] fileExistsAtPath:[home stringByAppendingPathComponent:@"p0-trace"]]){
            r->_pressure=[[NSFileManager defaultManager] fileExistsAtPath:[home stringByAppendingPathComponent:@"p0-owned-pressure"]];
            if(r->_pressure){r->_pressureLog=dispatch_queue_create("producer.pressure.proof",DISPATCH_QUEUE_SERIAL);atomic_init(&r->_pressureArmed,false);atomic_init(&r->_pressurePinned,false);}
            r->_timingHome=home; r->_timing=calloc(65536,sizeof(P0Timing)); atomic_init(&r->_timingCount,0);
        }
        r->_original[0]=r->_original[1]=r->_micTrack=-1;
        r->_captureQueue=dispatch_queue_create("producer.native.capture",DISPATCH_QUEUE_SERIAL);
        r->_screenQueue=dispatch_queue_create("producer.native.screen",DISPATCH_QUEUE_SERIAL);
        r->_writerQueue=dispatch_queue_create("producer.native.writer",DISPATCH_QUEUE_SERIAL);
        r->_clipWriter=createClipWriter(ctx);
        r->_liveWriter=createClipWriter(ctx);r->_liveWriter->_streamEncoding=YES;
        for(int i=0;i<2;i++){r->_commitGate[i]=[NSObject new];r->_lastCommittedPTS[i]=-INFINITY;}
        r->_device=MTLCreateSystemDefaultDevice();r->_gpuQueue=[r->_device newCommandQueue];
        MTLTextureDescriptor *white=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:1 height:1 mipmapped:NO];white.storageMode=MTLStorageModeShared;white.usage=MTLTextureUsageShaderRead;
        r->_white=[r->_device newTextureWithDescriptor:white];uint32_t pixel=0xffffffff;[r->_white replaceRegion:MTLRegionMake2D(0,0,1,1) mipmapLevel:0 withBytes:&pixel bytesPerRow:4];
        MTLSamplerDescriptor *sd=[MTLSamplerDescriptor new];
        sd.minFilter=sd.magFilter=MTLSamplerMinMagFilterLinear;
        r->_graphSampler=[r->_device newSamplerStateWithDescriptor:sd];
        r->_graphEmpty=[r->_device newTextureWithDescriptor:white];
        uint32_t clear=0;[r->_graphEmpty replaceRegion:MTLRegionMake2D(0,0,1,1) mipmapLevel:0 withBytes:&clear bytesPerRow:4];
        NSError *e=nil;id<MTLLibrary> lib=[r->_device newLibraryWithSource:shader options:nil error:&e];
        if(!lib){[r status:9 text:e.localizedDescription];return NULL;}
        MTLRenderPipelineDescriptor *p=[MTLRenderPipelineDescriptor new];
        p.vertexFunction=[lib newFunctionWithName:@"vs"];p.fragmentFunction=[lib newFunctionWithName:@"fs"];
        p.colorAttachments[0].pixelFormat=MTLPixelFormatBGRA8Unorm;p.colorAttachments[0].blendingEnabled=YES;
        p.colorAttachments[0].sourceRGBBlendFactor=MTLBlendFactorSourceAlpha;p.colorAttachments[0].destinationRGBBlendFactor=MTLBlendFactorOneMinusSourceAlpha;
        p.colorAttachments[0].sourceAlphaBlendFactor=MTLBlendFactorOne;p.colorAttachments[0].destinationAlphaBlendFactor=MTLBlendFactorOneMinusSourceAlpha;
        r->_pipeline=[r->_device newRenderPipelineStateWithDescriptor:p error:&e];
        r->_convert=[r->_device newComputePipelineStateWithFunction:[lib newFunctionWithName:@"to_yuv"] error:&e];
        r->_cameraGrade=[r->_device newComputePipelineStateWithFunction:[lib newFunctionWithName:@"camera_grade"] error:&e];
        if(!r->_pipeline||!r->_convert||!r->_cameraGrade||CVMetalTextureCacheCreate(NULL,NULL,r->_device,NULL,&r->_cache)!=kCVReturnSuccess)return NULL;
        return (__bridge_retained void*)r;
    }
}

#if defined(__arm64__)
static BOOL isProducerCamera(AVCaptureDevice *device) {
    return [device.uniqueID caseInsensitiveCompare:@"7626645E-4425-469E-9D8B-97E0FA59AC75"] == NSOrderedSame ||
           [device.uniqueID caseInsensitiveCompare:@"6D782D10-8F31-4BD0-B6B5-F171B337D328"] == NSOrderedSame;
}
#endif
static void startCamera(NRRoom *r) {
    dispatch_async(r->_captureQueue,^{@autoreleasepool {
        if(atomic_load(&r->_closing)||r->_camera)return;
        AVCaptureDevice *d=r->_cameraID?[AVCaptureDevice deviceWithUniqueID:r->_cameraID]:[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];NSError *e=nil;
#if defined(__arm64__)
        if (d && isProducerCamera(d)) {
            [r status:0 text:@"Select a physical camera for this input"]; return;
        }
#endif
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
// Read from the device bound to this source. Only explicit button presses take its configuration lock.
char *nr_camera_controls(const char *uid, int control, int value) {
    @autoreleasepool {
        AVCaptureDevice *device=[AVCaptureDevice deviceWithUniqueID:[NSString stringWithUTF8String:uid]];
        NSMutableDictionary *info=[NSMutableDictionary dictionary];
        if (!device) { info[@"error"]=@"Camera disconnected"; }
        else {
            BOOL automatic=value!=0;
            NSMutableArray *rates=[NSMutableArray array];
            for (NSNumber *rate in @[@15,@24,@30]) {
                for (AVFrameRateRange *range in device.activeFormat.videoSupportedFrameRateRanges) {
                    if (range.minFrameRate<=rate.doubleValue && range.maxFrameRate>=rate.doubleValue) { [rates addObject:rate]; break; }
                }
            }
            if (control) {
                NSError *error=nil;
                if (![device lockForConfiguration:&error]) info[@"error"]=error.localizedDescription ?: @"Camera is busy";
                else {
                    @try {
                        if (control==1 && [device isFocusModeSupported:automatic ? AVCaptureFocusModeContinuousAutoFocus : AVCaptureFocusModeLocked])
                            device.focusMode=automatic ? AVCaptureFocusModeContinuousAutoFocus : AVCaptureFocusModeLocked;
                        else if (control==2 && [device isExposureModeSupported:automatic ? AVCaptureExposureModeContinuousAutoExposure : AVCaptureExposureModeLocked])
                            device.exposureMode=automatic ? AVCaptureExposureModeContinuousAutoExposure : AVCaptureExposureModeLocked;
                        else if (control==3 && [device isWhiteBalanceModeSupported:automatic ? AVCaptureWhiteBalanceModeContinuousAutoWhiteBalance : AVCaptureWhiteBalanceModeLocked])
                            device.whiteBalanceMode=automatic ? AVCaptureWhiteBalanceModeContinuousAutoWhiteBalance : AVCaptureWhiteBalanceModeLocked;
                        else if (control==4 && [rates containsObject:@(value)]) {
                            CMTime duration=CMTimeMake(1,value);
                            device.activeVideoMaxFrameDuration=kCMTimeInvalid;
                            device.activeVideoMinFrameDuration=duration;
                            device.activeVideoMaxFrameDuration=duration;
                        } else info[@"error"]=@"This mode is unavailable for this camera";
                    } @catch(NSException *e) {info[@"error"]=e.reason ?: @"Camera configuration failed";}
                    @finally {[device unlockForConfiguration];}
                }
            }
            CMVideoDimensions dimensions=CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription);
            info[@"rates"]=rates;
            double duration=CMTimeGetSeconds(device.activeVideoMinFrameDuration);
            if (isfinite(duration) && duration>0) info[@"fps"]=@(lround(1./duration));
            info[@"device"]=device.uniqueID;
            info[@"format"]=[NSString stringWithFormat:@"%d × %d",dimensions.width,dimensions.height];
            info[@"modes"]=@[
                @[@([device isFocusModeSupported:AVCaptureFocusModeLocked]),@([device isFocusModeSupported:AVCaptureFocusModeContinuousAutoFocus]),@(device.focusMode)],
                @[@([device isExposureModeSupported:AVCaptureExposureModeLocked]),@([device isExposureModeSupported:AVCaptureExposureModeContinuousAutoExposure]),@(device.exposureMode)],
                @[@([device isWhiteBalanceModeSupported:AVCaptureWhiteBalanceModeLocked]),@([device isWhiteBalanceModeSupported:AVCaptureWhiteBalanceModeContinuousAutoWhiteBalance]),@(device.whiteBalanceMode)]];
        }
        NSData *data=[NSJSONSerialization dataWithJSONObject:info options:0 error:nil];
        return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
}
void nr_camera_effects(void) {
    if (@available(macOS 12.0,*)) [AVCaptureDevice showSystemUserInterface:AVCaptureSystemUserInterfaceVideoEffects];
}
char *nr_cameras(void) {
    @autoreleasepool {NSMutableArray *result=[NSMutableArray new];
        for(AVCaptureDevice *d in [AVCaptureDevice devicesWithMediaType:AVMediaTypeVideo]) {
#if defined(__arm64__)
            if (isProducerCamera(d)) continue;
#endif
            [result addObject:@{@"id":d.uniqueID,@"name":d.localizedName,@"default":@([d.uniqueID isEqualToString:[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo].uniqueID])}];
        }
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
// Screen selection and stream replacement run on the main queue. The screen
// sample queue only consumes the selected stream.
static void endScreenShare(NRRoom *r) {
    atomic_store(&r->_screenRequested, false);
    r->_screenRequestGeneration++;
    r->_screenPickerPending=NO;
    r->_screenUpdating=NO;
    r->_screenTarget=NRScreenAny;
    r->_screenSharingStatus=nil;
    SCStream *stream;
    @synchronized(r) { stream=r->_screen; r->_screen=nil; }
    if (!atomic_load(&r->_closing) && r->_frame) r->_frame(r->_context,1,NULL,0.,0);
    if (@available(macOS 14.0, *)) {
        if (r->_screenPickerObserver) {
            SCContentSharingPicker *picker=SCContentSharingPicker.sharedPicker;
            [picker removeObserver:r->_screenPickerObserver];
            if (stream) [picker setConfiguration:nil forStream:stream];
            picker.active=NO;
            r->_screenPickerObserver=nil;
        }
    }
    [stream stopCaptureWithCompletionHandler:nil];
}

static SCStreamConfiguration *screenConfiguration(CGSize size, double pixelScale) {
    if (size.width<=0 || size.height<=0) return nil;
    double scale=fmin(fmax(1.,pixelScale),1920./fmax(size.width,size.height));
    SCStreamConfiguration *config=[SCStreamConfiguration new];
    config.width=(size_t)fmax(2.,floor(size.width*scale/2.)*2.);
    config.height=(size_t)fmax(2.,floor(size.height*scale/2.)*2.);
    config.minimumFrameInterval=CMTimeMake(1,30);
    config.queueDepth=3;
    config.pixelFormat=kCVPixelFormatType_32BGRA;
    config.showsCursor=YES;
    if (@available(macOS 14.0, *)) {
        config.preservesAspectRatio=YES;
        config.ignoreShadowsSingleWindow=YES;
        config.ignoreGlobalClipSingleWindow=YES;
    }
    if (@available(macOS 14.2, *)) config.includeChildWindows=NO;
    return config;
}

static void startScreenShare(NRRoom *r, SCContentFilter *filter, SCStreamConfiguration *config, NSString *status) {
    if (atomic_load(&r->_closing) || !atomic_load(&r->_screenRequested)) return;
    SCStream *stream=[[SCStream alloc] initWithFilter:filter configuration:config delegate:r];
    NSError *error=nil;
    if (![stream addStreamOutput:r type:SCStreamOutputTypeScreen sampleHandlerQueue:r->_screenQueue error:&error]) {
        endScreenShare(r);
        [r status:1 text:error.localizedDescription ?: @"Could not attach screen capture"];
        return;
    }
    r->_screenSharingStatus=status;
    r->_screenUpdating=YES;
    @synchronized(r) { r->_screen=stream; }
    [stream startCaptureWithCompletionHandler:^(NSError *error){
        dispatch_async(dispatch_get_main_queue(), ^{
            if (stream != r->_screen || atomic_load(&r->_closing)) return;
            r->_screenUpdating=NO;
            if (error) endScreenShare(r);
            [r status:1 text:error.localizedDescription ?: status];
        });
    }];
}

API_AVAILABLE(macos(14.0))
@interface NRScreenPicker : NSObject<SCContentSharingPickerObserver>
@property(nonatomic, weak) NRRoom *room;
- (void)finishWithMessage:(NSString *)message stream:(SCStream *)stream;
@end

@implementation NRScreenPicker
- (void)contentSharingPicker:(SCContentSharingPicker *)picker didUpdateWithFilter:(SCContentFilter *)filter forStream:(SCStream *)stream {
    dispatch_async(dispatch_get_main_queue(), ^{
        NRRoom *r=self.room;
        if (!r || r->_screenPickerObserver!=self || stream!=r->_screen
            || atomic_load(&r->_closing) || !atomic_load(&r->_screenRequested) || r->_screenUpdating) return;
        NRScreenTarget requested=r->_screenPickerPending ? r->_screenPickerTarget : r->_screenTarget;
        r->_screenPickerPending=NO;
        SCShareableContentStyle style=filter.style;
        BOOL window=style==SCShareableContentStyleWindow;
        BOOL display=style==SCShareableContentStyleDisplay;
        if ((!window && !display) || (requested==NRScreenWindow && !window)
            || (requested==NRScreenDisplay && !display)) {
            if (!stream) endScreenShare(r);
            [r status:1 text:requested==NRScreenWindow ? @"Select a single window to share"
                : requested==NRScreenDisplay ? @"Select a display to share" : @"Select a window or display to share"];
            return;
        }
        SCStreamConfiguration *config=screenConfiguration(filter.contentRect.size, filter.pointPixelScale);
        if (!config) {
            if (!stream) endScreenShare(r);
            [r status:1 text:@"The selected window or display has no visible area"];
            return;
        }
        NSString *status=window ? @"Sharing a window" : @"Sharing a display";
        NRScreenTarget selected=window ? NRScreenWindow : NRScreenDisplay;
        if (!stream) {
            r->_screenTarget=selected;
            startScreenShare(r,filter,config,status);
            return;
        }
        // Keep the existing source texture until the stream delivers the new share.
        r->_screenUpdating=YES;
        [stream updateContentFilter:filter completionHandler:^(NSError *error) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (stream!=r->_screen || atomic_load(&r->_closing)) return;
                if (error) {
                    r->_screenUpdating=NO;
                    [r status:1 text:error.localizedDescription];
                    return;
                }
                r->_screenTarget=selected;
                r->_screenSharingStatus=status;
                [stream updateConfiguration:config completionHandler:^(NSError *error) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (stream!=r->_screen || atomic_load(&r->_closing)) return;
                        r->_screenUpdating=NO;
                        [r status:1 text:error.localizedDescription ?: status];
                    });
                }];
            });
        }];
    });
}
- (void)contentSharingPicker:(SCContentSharingPicker *)picker didCancelForStream:(SCStream *)stream {
    [self finishWithMessage:@"Screen selection canceled" stream:stream];
}
- (void)contentSharingPickerStartDidFailWithError:(NSError *)error {
    [self finishWithMessage:error.localizedDescription ?: @"Could not open the screen sharing picker" stream:nil];
}
- (void)finishWithMessage:(NSString *)message stream:(SCStream *)stream {
    dispatch_async(dispatch_get_main_queue(), ^{
        NRRoom *r=self.room;
        if (!r || r->_screenPickerObserver!=self || (stream && stream!=r->_screen)
            || !r->_screenPickerPending || atomic_load(&r->_closing)) return;
        r->_screenPickerPending=NO;
        if (!r->_screen) endScreenShare(r);
        [r status:1 text:r->_screenSharingStatus ?: message];
    });
}
@end

static void chooseScreen(NRRoom *r, NRScreenTarget target, BOOL replace) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (atomic_load(&r->_closing)) return;
        if (target==NRScreenStop) {
            endScreenShare(r);
            [r status:1 text:@"Screen sharing stopped"];
            return;
        }
        if (r->_screenPickerPending || r->_screenUpdating
            || (!replace && atomic_load(&r->_screenRequested))) return;
        atomic_store(&r->_screenRequested,true);
        if (@available(macOS 14.0, *)) {
            SCContentSharingPicker *picker=SCContentSharingPicker.sharedPicker;
            if (!r->_screenPickerObserver) {
                NRScreenPicker *observer=[NRScreenPicker new];
                observer.room=r;
                r->_screenPickerObserver=observer;
                [picker addObserver:observer];
            }
            SCContentSharingPickerConfiguration *configuration=[SCContentSharingPickerConfiguration new];
            SCContentSharingPickerMode window=SCContentSharingPickerModeSingleWindow;
            SCContentSharingPickerMode display=SCContentSharingPickerModeSingleDisplay;
            configuration.allowedPickerModes=target==NRScreenWindow ? window : target==NRScreenDisplay ? display : window|display;
            configuration.allowsChangingSelectedContent=YES;
            NSString *bundleID=NSBundle.mainBundle.bundleIdentifier;
            if (bundleID) configuration.excludedBundleIDs=@[bundleID];
            picker.maximumStreamCount=@1;
            picker.active=YES;
            r->_screenPickerPending=YES;
            r->_screenPickerTarget=target;
            [r status:1 text:target==NRScreenWindow ? @"Choose a window to share"
                : target==NRScreenDisplay ? @"Choose a display to share" : @"Choose a window or display to share"];
            SCShareableContentStyle style=target==NRScreenWindow ? SCShareableContentStyleWindow : SCShareableContentStyleDisplay;
            if (r->_screen) {
                [picker setConfiguration:configuration forStream:r->_screen];
                if (target==NRScreenAny) [picker presentPickerForStream:r->_screen];
                else [picker presentPickerForStream:r->_screen usingContentStyle:style];
            } else {
                picker.defaultConfiguration=configuration;
                if (target==NRScreenAny) [picker present];
                else [picker presentPickerUsingContentStyle:style];
            }
            return;
        }
        if (target==NRScreenWindow) {
            if (!r->_screen) endScreenShare(r);
            [r status:1 text:@"The window sharing picker requires macOS 14 or later"];
            return;
        }
        if (r->_screen) return;
        r->_screenPickerPending=YES;
        uint64_t request=r->_screenRequestGeneration;
        [r status:1 text:@"Requesting screen capture"];
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content,NSError *error){
            dispatch_async(dispatch_get_main_queue(), ^{
                if (atomic_load(&r->_closing) || request!=r->_screenRequestGeneration) return;
                r->_screenPickerPending=NO;
                SCDisplay *display=content.displays.firstObject;
                if (error || !display) {
                    endScreenShare(r);
                    [r status:1 text:error.code==SCStreamErrorUserDeclined
                        ? @"Allow Screen Recording for Producer in macOS Privacy settings"
                        : error.localizedDescription ?: @"No display available"];
                    return;
                }
                NSMutableArray *exclude=[NSMutableArray new];
                for (SCRunningApplication *app in content.applications) if (app.processID==getpid()) [exclude addObject:app];
                SCContentFilter *filter=[[SCContentFilter alloc] initWithDisplay:display excludingApplications:exclude exceptingWindows:@[]];
                startScreenShare(r,filter,screenConfiguration(CGSizeMake(display.width,display.height),1.),@"Sharing a display");
            });
        }];
    });
}

static void requestMicrophone(NRRoom *r) {
    if (atomic_load(&r->_closing)) return;
    AVAuthorizationStatus access=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (access==AVAuthorizationStatusNotDetermined) {
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL allowed) {
            if (allowed) startMic(r);
            else [r status:3 text:@"Allow Microphone in macOS Privacy settings"];
        }];
    } else if (access==AVAuthorizationStatusAuthorized) startMic(r);
    else [r status:3 text:@"Allow Microphone in macOS Privacy settings"];
}

void nr_capture(void *handle,int camera,int screen,int mic) {
    NRRoom *r=(__bridge NRRoom*)handle;
    if (camera) {
        AVAuthorizationStatus access=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
        if (access==AVAuthorizationStatusNotDetermined) {
            BOOL promptMicAfterCamera=mic &&
                [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]==AVAuthorizationStatusNotDetermined;
            [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL allowed) {
                if (allowed) startCamera(r);
                else [r status:0 text:@"Allow Camera in macOS Privacy settings"];
                if (promptMicAfterCamera) requestMicrophone(r);
            }];
            if (promptMicAfterCamera) mic=0;
        } else if (access==AVAuthorizationStatusAuthorized) startCamera(r);
        else [r status:0 text:@"Allow Camera in macOS Privacy settings"];
    }
    if (mic) requestMicrophone(r);
    if (screen) chooseScreen(r,NRScreenAny,NO);
}

void nr_screen_capture(void *handle,int target) {
    NRRoom *r=(__bridge NRRoom*)handle;
    chooseScreen(r,(NRScreenTarget)target,YES);
}

// Releasing a room source must release its capture without blocking the render lane.
void nr_capture_stop(void *handle,int source) {
    NRRoom *r=(__bridge NRRoom*)handle;
    if(source==1) {
        chooseScreen(r,NRScreenStop,YES);
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

static NSFont *systemTextFont(CGFloat size, uint32_t weight) {
    const CGFloat weights[] = {NSFontWeightUltraLight, NSFontWeightThin, NSFontWeightLight,
        NSFontWeightRegular, NSFontWeightMedium, NSFontWeightSemibold, NSFontWeightBold,
        NSFontWeightHeavy, NSFontWeightBlack};
    return [NSFont systemFontOfSize:size weight:weights[(weight-100)/100]];
}

double nr_headline_width(const char *value, double size) {
    @autoreleasepool {
        NSString *text = [NSString stringWithUTF8String:value];
        if (!text) return NAN;
        return [text sizeWithAttributes:@{NSFontAttributeName:systemTextFont(size, 700)}].width;
    }
}

// Control-lane preparation; immutable textures are never rasterized per frame.
void *nr_text_cache(const NRText *specs,size_t count,const NRGraphSpec *graphs,size_t graphCount,char *error,size_t capacity) {
    if(count>128 || graphCount>64)return NULL;
    @autoreleasepool {
        id<MTLDevice> device=MTLCreateSystemDefaultDevice();
        if(!device){snprintf(error,capacity,"Metal device unavailable to this process");return NULL;}
        NSMutableArray *textures=[NSMutableArray arrayWithCapacity:count];uint64_t pixelsTotal=0;
        for(size_t i=0;i<count;i++) {
            NRText t=specs[i];size_t w=t.width,h=t.height;
            if(t.rgba) {
                if(!w || !h || w>4096 || h>4096 || (pixelsTotal+=w*h)>8388608)return NULL;
                MTLTextureDescriptor *desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm width:w height:h mipmapped:NO];
                desc.storageMode=MTLStorageModeShared;desc.usage=MTLTextureUsageShaderRead;
                id<MTLTexture> texture=[device newTextureWithDescriptor:desc];if(!texture)return NULL;
                [texture replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:t.rgba bytesPerRow:w*4];
                [textures addObject:texture];continue;
            }
            if(!t.value||w<1||h<1||w>4096||h>4096||!isfinite(t.font_size)||t.font_size<6||t.font_size>512||t.weight<100||t.weight>900||t.align>2)return NULL;
            pixelsTotal+=(uint64_t)w*h;if(pixelsTotal>8388608)return NULL;
            NSString *text=[NSString stringWithUTF8String:t.value];if(!text)return NULL;
            NSMutableData *pixels=[NSMutableData dataWithLength:w*h*4];CGColorSpaceRef cs=CGColorSpaceCreateDeviceRGB();
            CGContextRef c=CGBitmapContextCreate(pixels.mutableBytes,w,h,8,w*4,cs,kCGImageAlphaPremultipliedFirst|kCGBitmapByteOrder32Little);CGColorSpaceRelease(cs);if(!c)return NULL;
            NSFont *font=systemTextFont(t.font_size,t.weight);
            NSMutableParagraphStyle *paragraph=[NSMutableParagraphStyle new];paragraph.alignment=t.align==1?NSTextAlignmentCenter:(t.align==2?NSTextAlignmentRight:NSTextAlignmentLeft);
            if(t.single_line){
                CGFloat width=[text sizeWithAttributes:@{NSFontAttributeName:font}].width;
                if(width>w) font=systemTextFont(MAX(t.font_size*.60,t.font_size*(w-1)/width),t.weight);
                paragraph.lineBreakMode=NSLineBreakByTruncatingTail;
            }
            NSAttributedString *string=[[NSAttributedString alloc] initWithString:text attributes:@{NSFontAttributeName:font,NSForegroundColorAttributeName:NSColor.whiteColor,NSParagraphStyleAttributeName:paragraph}];
            CTFramesetterRef setter=CTFramesetterCreateWithAttributedString((__bridge CFAttributedStringRef)string);CGPathRef path=CGPathCreateWithRect(CGRectMake(0,0,w,h),NULL);
            CTFrameRef frame=CTFramesetterCreateFrame(setter,CFRangeMake(0,0),path,NULL);CTFrameDraw(frame,c);CFRelease(frame);CGPathRelease(path);CFRelease(setter);CGContextRelease(c);
            MTLTextureDescriptor *d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:w height:h mipmapped:NO];d.storageMode=MTLStorageModeShared;d.usage=MTLTextureUsageShaderRead;
            id<MTLTexture> texture=[device newTextureWithDescriptor:d];if(!texture)return NULL;
            [texture replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:pixels.bytes bytesPerRow:w*4];[textures addObject:texture];
        }
        NSMutableArray *passes=[NSMutableArray arrayWithCapacity:graphCount];
        for(size_t i=0;i<graphCount;i++){
            const NRGraphSpec *g=&graphs[i];
            NRFragmentPass *p=[NRFragmentPass new];NSError *failure=nil;
            p->groups=g->groups;
            if(g->geometry) {
                p->geometry=prepareGeometry(device,g,&failure);
                if(p->geometry)p->pipeline=p->geometry->pipeline;
            } else if(!p->groups)p->pipeline=fragmentPipeline(device,[NSString stringWithUTF8String:g->source],[NSString stringWithUTF8String:g->entry],&failure);
            if(!p->pipeline && !p->groups){snprintf(error,capacity,"pass %zu: %s",i,failure.localizedDescription.UTF8String?:"missing shader entry");return NULL;}
            p->width=g->width;p->height=g->height;
            memcpy(p->inputs,g->inputs,sizeof(p->inputs));memcpy(p->params,g->params,sizeof(p->params));
            [passes addObject:p];
        }
        NRVisualResources *resources=[NRVisualResources new];resources.images=textures;resources.passes=passes;
        return (__bridge_retained void*)resources;
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
int nr_render(void *handle,uint32_t output,uint32_t w,uint32_t h,const NRDraw *draws,size_t count,void **sources,const float (*grades)[4],void *textCache,void *djCache,double pts,uint64_t generation) {
    NRRoom *r=(__bridge NRRoom*)handle;
    if(output>1||count>1024||w<64||h<64||w>4096||h>4096||w%2||h%2||atomic_load(&r->_closing))return 0;
    if(output==0 && atomic_load(&r->_recordEnabled))p0Stall(r,1,pts);
    @synchronized(r->_commitGate[output]) { if(pts<=r->_lastCommittedPTS[output])return 0; }
    timing(r,1,output,pts);
    // Five 30 Hz submissions cover the observed transient completion tail.
    // Keep larger surfaces and preview on the original aggregate budget.
    BOOL pairedHD=!atomic_load(&r->_p0OldBudget) && atomic_load(&r->_recordEnabled) && (uint64_t)w*h<=1920u*1080u;
    int total=atomic_fetch_add(&r->_inflight,1);
    int own=atomic_fetch_add(&r->_outputInFlight[output],1);
    if(pairedHD ? (own>=5 || total>=10) : total>=4){timing(r,-1,output,pts);atomic_fetch_sub(&r->_outputInFlight[output],1);atomic_fetch_sub(&r->_inflight,1);return 0;}
    @autoreleasepool {
        if(r->_width[output]!=w||r->_height[output]!=h){atomic_fetch_sub(&r->_outputInFlight[output],1);atomic_fetch_sub(&r->_inflight,1);return 0;}
        CVPixelBufferRef result=NULL;
        // Five active HD renders, three 30 Hz frames retained for 95 ms,
        // and two buffers for the encoder and callback handoff. CoreVideo
        // enforces the bound across all consumers of this orientation.
        if(CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(NULL,r->_pool[output],(__bridge CFDictionaryRef)@{(id)kCVPixelBufferPoolAllocationThresholdKey:@(pairedHD && atomic_load(&r->_pairedHDWriter) ? 14 : pairedHD ? 10 : 3)},&result)!=kCVReturnSuccess){timing(r,-2,output,pts);atomic_fetch_sub(&r->_outputInFlight[output],1);atomic_fetch_sub(&r->_inflight,1);return 0;}
        CVBufferSetAttachment(result,kCVImageBufferYCbCrMatrixKey,kCVImageBufferYCbCrMatrix_ITU_R_601_4,kCVAttachmentMode_ShouldPropagate);
        CVBufferSetAttachment(result,kCVImageBufferColorPrimariesKey,kCVImageBufferColorPrimaries_ITU_R_709_2,kCVAttachmentMode_ShouldPropagate);
        CVBufferSetAttachment(result,kCVImageBufferTransferFunctionKey,kCVImageBufferTransferFunction_ITU_R_709_2,kCVAttachmentMode_ShouldPropagate);
        id<MTLCommandBuffer> command=[r->_gpuQueue commandBuffer];
        CVMetalTextureRef keep[8]={0};id<MTLTexture> textures[8]={nil};
        CVPixelBufferRef held[8]={0};
        for(int i=0;i<8;i++)if(sources[i]){held[i]=CVPixelBufferRetain((CVPixelBufferRef)sources[i]);textures[i]=cvtexture(r,held[i],MTLPixelFormatBGRA8Unorm,CVPixelBufferGetWidth(held[i]),CVPixelBufferGetHeight(held[i]),0,&keep[i]);}
        for(int i=0;i<8;i++){
            id<MTLTexture> src=textures[i];
            if(!src || !(grades[i][0] || grades[i][1] || grades[i][2] || grades[i][3])) continue;
            id<MTLTexture> dst;
            @synchronized(r->_commitGate[output]){
                dst=r->_graded[output][i];
                if(!dst || dst.width!=src.width || dst.height!=src.height){
                    MTLTextureDescriptor *desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:src.width height:src.height mipmapped:NO];
                    desc.storageMode=MTLStorageModePrivate;
                    desc.usage=MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite;
                    dst=r->_graded[output][i]=[r->_device newTextureWithDescriptor:desc];
                }
            }
            if(!dst) continue;
            id<MTLComputeCommandEncoder> pass=[command computeCommandEncoder];
            [pass setComputePipelineState:r->_cameraGrade];
            [pass setTexture:src atIndex:0]; [pass setTexture:dst atIndex:1];
            [pass setBytes:grades[i] length:sizeof(grades[i]) atIndex:0];
            [pass dispatchThreads:MTLSizeMake(src.width,src.height,1) threadsPerThreadgroup:MTLSizeMake(16,16,1)];
            [pass endEncoding]; textures[i]=dst;
        }
        NRVisualResources *resourcesForFrame=(__bridge NRVisualResources*)textCache;
        NRVisualResources *djResources=(__bridge NRVisualResources*)djCache;
        NRRehearsalTiming *profile=r->_profileRehearsal ? [[NRRehearsalTiming alloc] initWithDevice:r->_device] : nil;
        id<MTLTexture> graphOutputs[64]={nil};
        if(!encodeGraphs(r,command,output,draws,count,resourcesForFrame,textures,graphOutputs,djResources.images.firstObject,profile)){
            for(int i=0;i<8;i++){if(keep[i])CFRelease(keep[i]);if(held[i])CVPixelBufferRelease(held[i]);}
            CVPixelBufferRelease(result);finishCommand(r,output);return 0;
        }
        CVMetalTextureRef y=NULL,uv=NULL;id<MTLTexture> yt=cvtexture(r,result,MTLPixelFormatR8Unorm,w,h,0,&y),uvt=cvtexture(r,result,MTLPixelFormatRG8Unorm,w/2,h/2,1,&uv);
        if(!yt||!uvt){if(y)CFRelease(y);if(uv)CFRelease(uv);for(int i=0;i<8;i++){if(keep[i])CFRelease(keep[i]);if(held[i])CVPixelBufferRelease(held[i]);}CVPixelBufferRelease(result);atomic_fetch_sub(&r->_outputInFlight[output],1);atomic_fetch_sub(&r->_inflight,1);return 0;}
        id<MTLComputeCommandEncoder> convert=[command computeCommandEncoder];[convert setComputePipelineState:r->_convert];[convert setTexture:r->_rgb[output] atIndex:0];[convert setTexture:yt atIndex:1];[convert setTexture:uvt atIndex:2];
        [convert dispatchThreads:MTLSizeMake(w/2,h/2,1) threadsPerThreadgroup:MTLSizeMake(16,16,1)];[convert endEncoding];
        struct {CVMetalTextureRef k[8];CVPixelBufferRef b[8];} resources;
        memcpy(resources.k,keep,sizeof(keep));memcpy(resources.b,held,sizeof(held));
        // Only commit in presentation order. A late encoding attempt may have
        // been covered by the other worker; release its unsubmitted resources.
        @synchronized(r->_commitGate[output]) {
        if(pts<=r->_lastCommittedPTS[output]) {
            for(int i=0;i<8;i++){if(keep[i])CFRelease(keep[i]);if(held[i])CVPixelBufferRelease(held[i]);}
            CFRelease(y);CFRelease(uv);CVPixelBufferRelease(result);finishCommand(r,output);
            timing(r,14,output,pts);
            return 0;
        }
        r->_lastCommittedPTS[output]=pts;
        [command addCompletedHandler:^(id<MTLCommandBuffer> cb){@autoreleasepool {
            if(cb.status==MTLCommandBufferStatusCompleted) {
                if(profile){
                    NSDictionary *timings=[profile finish:cb];
                    @synchronized(r->_commitGate[output]){
                        r->_profileResult[output]=timings;
                        r->_profileGeneration[output]=generation;
                    }
                }
                BOOL preview=YES;
                if(r->_pressure && output==0 && atomic_load(&r->_recordEnabled)){
                    size_t width=0;double age=0;
                    for(int i=0;i<8;i++)if(resources.b[i]){
                        NSNumber *at=(__bridge NSNumber*)CVBufferGetAttachment(resources.b[i],CFSTR("P0DecodedAt"),NULL);
                        if(at){width=CVPixelBufferGetWidth(resources.b[i]);age=1000*(nr_host_time()-at.doubleValue);break;}
                    }
                    if(width){
                        pressureEvent(r,@"program",result,width,age);
                        if(pts-r->_recordOrigin>=2.0 && !atomic_exchange(&r->_pressureArmed,true)){
                            atomic_store(&r->_pressurePinned,true);
                            CVBufferSetAttachment(result,CFSTR("P0EncoderPin"),(__bridge CFTypeRef)@(width),kCVAttachmentMode_ShouldNotPropagate);
                            pressureLease(r,result,@"preview",width);
                        }else if(atomic_load(&r->_pressurePinned)){preview=NO;pressureEvent(r,@"preview skipped",result,width,age);}
                    }
                }
                if(preview)[r deliver:10+output buffer:result pts:pts generation:generation];
                timing(r,3,output,pts);
                recordVideo(r,output,result,pts);
                if(r->_liveWriter)recordVideo(r->_liveWriter,output,result,pts);
                if(r->_clipWriter)recordVideo(r->_clipWriter,output,result,pts);
            } else [r status:9 text:cb.error.localizedDescription?:@"GPU frame failed"];
            for(int i=0;i<8;i++){if(resources.k[i])CFRelease(resources.k[i]);if(resources.b[i])CVPixelBufferRelease(resources.b[i]);}
            CFRelease(y);CFRelease(uv);
            if(atomic_load(&r->_p0HoldSurface) && atomic_load(&r->_recordEnabled)){
                atomic_fetch_add(&r->_retainedAfterCompletion,1);
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW,95000000),dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE,0),^{
                    timing(r,5,output,pts);
                    CVPixelBufferRelease(result);
                    atomic_fetch_sub(&r->_retainedAfterCompletion,1);
                });
            }else{
                timing(r,5,output,pts);
                CVPixelBufferRelease(result);
            }
            finishCommand(r,output);
        }}];[command commit];timing(r,2,output,pts);
        }
        return 1;
    }
}


void nr_stop(void *handle) {
    NRRoom *r=(__bridge_transfer NRRoom*)handle;
    // Fence the current screen sample before Rust releases the frame callback context.
    @synchronized(r) { atomic_store(&r->_closing,true); }
    atomic_store(&r->_screenRequested,false);
    dispatch_async(dispatch_get_main_queue(), ^{ endScreenShare(r); });
    dispatch_sync(r->_captureQueue,^{[r->_camera stopRunning];[r->_mic stopRunning];});
    while(atomic_load(&r->_inflight)>0 || atomic_load(&r->_retainedAfterCompletion)>0)usleep(1000);
    for(NRRoom *clip in @[r->_clipWriter,r->_liveWriter]) {
        atomic_store(&clip->_closing,true);
        atomic_store(&clip->_recordEnabled,false);
        dispatch_sync(clip->_writerQueue,^{
            endRecordingActivity(clip);
            clip->_recording=NO;
            for(int i=0;i<(int)clip->_trackCount;i++){
                if(clip->_writers[i].status==AVAssetWriterStatusWriting)[clip->_writers[i] cancelWriting];
            }
        });
        while(atomic_load(&clip->_segmentInFlight)>0)usleep(1000);
    }
    dispatch_sync(r->_writerQueue,^{endRecordingActivity(r);r->_recording=NO;atomic_store(&r->_recordEnabled,false);for(int i=0;i<5;i++)if(r->_writers[i].status==AVAssetWriterStatusWriting)[r->_writers[i] cancelWriting];});
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

// Copy a completed monitor into Rune-owned storage. Its upload queue cannot retain
// buffers from the small, latency-bounded production/encoder pool.
int nr_monitor_planes(CVPixelBufferRef pixel, size_t w, size_t h, uint8_t *y, uint8_t *uv) {
    if (CVPixelBufferGetWidth(pixel) != w || CVPixelBufferGetHeight(pixel) != h ||
        !w || !h || (w | h) % 2 || CVPixelBufferGetPlaneCount(pixel) != 2) return -1;
    OSType fmt = CVPixelBufferGetPixelFormatType(pixel);
    if (fmt != kCVPixelFormatType_420YpCbCr8BiPlanarFullRange &&
        fmt != kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) return -1;
    if (CVPixelBufferLockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) return -1;
    int result = fmt == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange;
    for (size_t p = 0; p < 2; p++) {
        const uint8_t *src = CVPixelBufferGetBaseAddressOfPlane(pixel, p);
        const size_t stride = CVPixelBufferGetBytesPerRowOfPlane(pixel, p);
        const size_t rows = p ? h/2 : h;
        if (!src || stride < w || CVPixelBufferGetHeightOfPlane(pixel, p) < rows) { result = -1; break; }
        uint8_t *dst = p ? uv : y;
        if (stride == w) memcpy(dst, src, rows * w);
        else for (size_t row = 0; row < rows; row++) memcpy(dst + row*w, src + row*stride, w);
    }
    CVPixelBufferUnlockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
    return result;
}

// Immutable, Metal-readable surface for the fixed-size Native Dev guest fixture.
// Pack the chosen program canvas for the guest return on its dedicated worker.
bool nr_stage_copy(CVPixelBufferRef frame, uint8_t *out, size_t width, size_t height) {
    OSType fmt=CVPixelBufferGetPixelFormatType(frame);
    if ((fmt!=kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange && fmt!=kCVPixelFormatType_420YpCbCr8BiPlanarFullRange) ||
        CVPixelBufferGetPlaneCount(frame)!=2 || CVPixelBufferLockBaseAddress(frame,kCVPixelBufferLock_ReadOnly)!=kCVReturnSuccess) return false;
    size_t w=CVPixelBufferGetWidth(frame),h=CVPixelBufferGetHeight(frame);
    bool ok=w>=2 && h>=2;
    if(ok) {
        double scale=fmin((double)width/w,(double)height/h);
        size_t dw=MAX(2,MIN(width,lround(w*scale))) & ~1u, dh=MAX(2,MIN(height,lround(h*scale))) & ~1u;
        size_t left=((width-dw)/2)&~1u,top=((height-dh)/2)&~1u;
        for(size_t plane=0;plane<2;plane++) {
            const uint8_t *src=CVPixelBufferGetBaseAddressOfPlane(frame,plane);
            if(!src){ok=false;break;}
            size_t step=plane?2:1, rows=dh/step, stride=CVPixelBufferGetBytesPerRowOfPlane(frame,plane);
            uint8_t *dest=out+(plane?width*height:0);
            if(dw!=width || dh!=height) memset(dest,plane?128:16,width*(height/step));
            size_t sh=CVPixelBufferGetHeightOfPlane(frame,plane),sw=CVPixelBufferGetWidthOfPlane(frame,plane);
            for(size_t y=0;y<rows;y++) {
                const uint8_t *row=src+(y*sh/rows)*stride;
                uint8_t *line=dest+(y+top/step)*width+left;
                for(size_t x=0;x<dw/step;x++){
                    size_t sx=x*sw/(dw/step)*step;
                    line[x*step]=row[sx];
                    if(plane) line[x*step+1]=row[sx+1];
                }
            }
        }
    }
    CVPixelBufferUnlockBaseAddress(frame,kCVPixelBufferLock_ReadOnly);
    return ok;
}

CVPixelBufferRef nr_stage_surface(const uint8_t *nv12,size_t w,size_t h) {
    @autoreleasepool {
        NSDictionary *opts=@{(id)kCVPixelBufferMetalCompatibilityKey:@YES,(id)kCVPixelBufferIOSurfacePropertiesKey:@{}};
        CVPixelBufferRef buffer=NULL;
        if(CVPixelBufferCreate(NULL,w,h,kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,(__bridge CFDictionaryRef)opts,&buffer)!=kCVReturnSuccess)return NULL;
        if(CVPixelBufferLockBaseAddress(buffer,0)!=kCVReturnSuccess){CVPixelBufferRelease(buffer);return NULL;}
        for(size_t plane=0;plane<2;plane++){
            uint8_t *dest=CVPixelBufferGetBaseAddressOfPlane(buffer,plane);
            size_t stride=CVPixelBufferGetBytesPerRowOfPlane(buffer,plane);
            const uint8_t *src=nv12+(plane?w*h:0);
            for(size_t y=0;y<(plane?h/2:h);y++)memcpy(dest+y*stride,src+y*w,w);
        }
        CVPixelBufferUnlockBaseAddress(buffer,0);return buffer;
    }
}

CVPixelBufferRef nr_p0_guest_surface(const uint8_t *bgra,size_t width,size_t height) {
    @autoreleasepool {
        NSDictionary *options = @{(id)kCVPixelBufferMetalCompatibilityKey:@YES,
                                  (id)kCVPixelBufferIOSurfacePropertiesKey:@{}};
        CVPixelBufferRef pixel = NULL;
        if (CVPixelBufferCreate(NULL,width,height,kCVPixelFormatType_32BGRA,
                                (__bridge CFDictionaryRef)options,&pixel) != kCVReturnSuccess) return NULL;
        if (CVPixelBufferLockBaseAddress(pixel,0) != kCVReturnSuccess) {
            CVPixelBufferRelease(pixel);
            return NULL;
        }
        uint8_t *base = CVPixelBufferGetBaseAddress(pixel);
        for (size_t y=0; y<height; y++) memcpy(base+y*CVPixelBufferGetBytesPerRow(pixel),bgra+y*width*4,width*4);
        CVBufferSetAttachment(pixel,CFSTR("P0DecodedAt"),(__bridge CFTypeRef)@(nr_host_time()),kCVAttachmentMode_ShouldNotPropagate);
        CVPixelBufferUnlockBaseAddress(pixel,0);
        return pixel;
    }
}

#if defined(__APPLE__)
// The interactive test bundle owns the system prompt. Helpers only check the grant.
void nr_request_witness_microphone(const char *receiptPath) {
    NSString *path = [NSString stringWithUTF8String:receiptPath];
    void (^save)(NSString *) = ^(NSString *status) {
        [status writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    };
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
        case AVAuthorizationStatusAuthorized: save(@"authorized"); break;
        case AVAuthorizationStatusDenied: save(@"denied"); break;
        case AVAuthorizationStatusRestricted: save(@"restricted"); break;
        case AVAuthorizationStatusNotDetermined: {
            save(@"requested");
            [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL allowed) {
                save(allowed ? @"authorized" : @"denied");
            }];
            break;
        }
        default: save(@"unknown"); break;
    }
}
#endif

// Export the compositor result for authoring proofs, after GPU completion.
bool nr_write_poster(CVPixelBufferRef pixel, const char *path, unsigned maxDimension) {
    @autoreleasepool {
        CIImage *image=[CIImage imageWithCVPixelBuffer:pixel];
        static CIContext *context;
        static dispatch_once_t once;
        dispatch_once(&once, ^{ context=[CIContext contextWithOptions:@{kCIContextCacheIntermediates:@NO}]; });
        CGFloat longest = MAX(image.extent.size.width, image.extent.size.height);
        if (maxDimension && longest > maxDimension) {
            CGFloat ratio = maxDimension / longest;
            image = [image imageByApplyingTransform:CGAffineTransformMakeScale(ratio,ratio)
                                highQualityDownsample:YES];
        }
        CGImageRef cg=[context createCGImage:image fromRect:image.extent];
        if(!cg)return false;
        NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithCGImage:cg];
        CGImageRelease(cg);
        NSData *png=[rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        return [png writeToFile:[NSString stringWithUTF8String:path] atomically:YES];
    }
}

// Use the shipping shell's HUD material with the NSWindow that owns GPUI's Metal view.
// The host service acknowledges ownership before accepting audience configuration.
bool nr_audience_access(const char *address, const char *publication, bool enabled) {
    @autoreleasepool {
        NSURLSession *session=[NSURLSession sessionWithConfiguration:NSURLSessionConfiguration.ephemeralSessionConfiguration];
        NSURLSessionWebSocketTask *socket=[session webSocketTaskWithURL:[NSURL URLWithString:@(address)]];
        [socket resume];
        NSString *frame=@(publication);
        bool confirmed=false, configuring=false;
        for(int i=0;i<16;i++) {
            dispatch_semaphore_t done=dispatch_semaphore_create(0);
            if(frame) {
                [socket sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:frame] completionHandler:^(NSError *err){ if(err) [socket cancel]; }];
                frame=nil;
            }
            __block NSDictionary *reply=nil;
            [socket receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message,NSError *err) {
                NSData *bytes=[message.string dataUsingEncoding:NSUTF8StringEncoding];
                if(!err && bytes){id value=[NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil]; if([value isKindOfClass:NSDictionary.class]) reply=value;}
                dispatch_semaphore_signal(done);
            }];
            if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC)) || !reply) break;
            NSString *type=reply[@"type"];
            if([type isEqual:@"error"] || [type isEqual:@"audience.error"]) break;
            if([type isEqual:@"scene.published"] && !configuring) {
                configuring=true;
                frame=enabled ? @"{\"type\":\"audience.configure\",\"enabled\":true,\"direct_limit\":4}" : @"{\"type\":\"audience.configure\",\"enabled\":false,\"direct_limit\":4}";
            } else if(configuring && [type isEqual:@"audience.snapshot"] && reply[@"enabled"] && [reply[@"enabled"] boolValue]==enabled){confirmed=true;break;}
        }
        [socket cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
        [session invalidateAndCancel];
        return confirmed;
    }
}

#if defined(__arm64__)
int nr_setup_access(int kind) {
    if (kind == 2) return CGPreflightScreenCaptureAccess() ? 1 : 0;
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:
        kind == 0 ? AVMediaTypeVideo : AVMediaTypeAudio];
    if (status == AVAuthorizationStatusAuthorized) return 1;
    return status == AVAuthorizationStatusNotDetermined ? 0 : -1;
}
void nr_setup_request(int kind) {
    if (kind == 2) { CGRequestScreenCaptureAccess(); return; }
    [AVCaptureDevice requestAccessForMediaType:kind == 0 ? AVMediaTypeVideo : AVMediaTypeAudio
        completionHandler:^(BOOL allowed) { (void)allowed; }];
}
#endif
