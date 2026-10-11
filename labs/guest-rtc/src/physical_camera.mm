#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#include <array>
#include <atomic>
#include <memory>
#include <cstring>
static constexpr size_t camera_bytes=640*480*3/2;
struct CameraFrame {uint64_t host_ns=0;std::array<uint8_t,camera_bytes> pcm{};};
struct CameraState {
    std::array<CameraFrame,3> frames{};
    std::atomic<uint64_t> written{0},read{0},overflow{0},late{0},errors{0},callbacks{0};
    std::atomic<bool> stopping{false};uint64_t previous=0;
    std::atomic<uint64_t> first_fault{0},actual_format{0},actual_width{0},actual_height{0};
    void fault(uint64_t code){uint64_t expected=0;first_fault.compare_exchange_strong(expected,code);errors++;}
    bool push(CVPixelBufferRef pixel,uint64_t host_ns) {
        if(!pixel){fault(1);return false;}
        actual_format=CVPixelBufferGetPixelFormatType(pixel);actual_width=CVPixelBufferGetWidth(pixel);actual_height=CVPixelBufferGetHeight(pixel);
        if(actual_format!=kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || actual_width!=640 || actual_height!=480 || CVPixelBufferGetPlaneCount(pixel)!=2){fault(2);return false;}
        if(!host_ns || host_ns<=previous){fault(3);return false;}
        previous=host_ns;
        auto w=written.load(std::memory_order_relaxed);
        if(w-read.load(std::memory_order_acquire)>=3){overflow++;return false;}
        if(CVPixelBufferLockBaseAddress(pixel,kCVPixelBufferLock_ReadOnly)!=kCVReturnSuccess){fault(4);return false;}
        auto y=(const uint8_t*)CVPixelBufferGetBaseAddressOfPlane(pixel,0);
        auto uv=(const uint8_t*)CVPixelBufferGetBaseAddressOfPlane(pixel,1);
        auto ys=CVPixelBufferGetBytesPerRowOfPlane(pixel,0),uvs=CVPixelBufferGetBytesPerRowOfPlane(pixel,1);
        if(!y || !uv || ys<640 || uvs<640) {CVPixelBufferUnlockBaseAddress(pixel,kCVPixelBufferLock_ReadOnly);fault(5);return false;}
        auto &frame=frames[w%3];frame.host_ns=host_ns;
        for(size_t row=0;row<480;row++)memcpy(frame.pcm.data()+row*640,y+row*ys,640);
        auto u=frame.pcm.data()+640*480,v=u+320*240;
        for(size_t row=0;row<240;row++)for(size_t col=0;col<320;col++) {u[row*320+col]=uv[row*uvs+col*2];v[row*320+col]=uv[row*uvs+col*2+1];}
        CVPixelBufferUnlockBaseAddress(pixel,kCVPixelBufferLock_ReadOnly);
        written.store(w+1,std::memory_order_release);return true;
    }
    bool pop(uint8_t *y,uint8_t *u,uint8_t *v,uint64_t *host_ns) {
        auto r=read.load(std::memory_order_relaxed);
        if(r==written.load(std::memory_order_acquire))return false;
        auto &frame=frames[r%3];*host_ns=frame.host_ns;
        memcpy(y,frame.pcm.data(),640*480);memcpy(u,frame.pcm.data()+640*480,320*240);memcpy(v,frame.pcm.data()+640*480+320*240,320*240);
        read.store(r+1,std::memory_order_release);return true;
    }
};
@interface ProducerCameraDelegate:NSObject<AVCaptureVideoDataOutputSampleBufferDelegate> {
    std::shared_ptr<CameraState> _state;
    __weak AVCaptureSession *_session;
}
-(instancetype)initWithState:(std::shared_ptr<CameraState>)state session:(AVCaptureSession*)session;
@end
@implementation ProducerCameraDelegate
-(instancetype)initWithState:(std::shared_ptr<CameraState>)state session:(AVCaptureSession*)session {self=[super init];if(self){_state=state;_session=session;}return self;}
-(void)captureOutput:(AVCaptureOutput*)output didOutputSampleBuffer:(CMSampleBufferRef)sample fromConnection:(AVCaptureConnection*)connection {
    (void)output;(void)connection;_state->callbacks++;
    if(!_state->stopping) {
        auto session=_session;auto clock=session.synchronizationClock;
        if(!clock)_state->fault(6);
        else {
            CMTime converted=CMSyncConvertTime(CMSampleBufferGetPresentationTimeStamp(sample),clock,CMClockGetHostTimeClock());
            if(!CMTIME_IS_NUMERIC(converted) || converted.value<0)_state->fault(7);
            else {converted=CMTimeConvertScale(converted,1000000000,kCMTimeRoundingMethod_RoundHalfAwayFromZero);_state->push(CMSampleBufferGetImageBuffer(sample),(uint64_t)converted.value);}
        }
    }
    _state->callbacks--;
}
-(void)captureOutput:(AVCaptureOutput*)output didDropSampleBuffer:(CMSampleBufferRef)sample fromConnection:(AVCaptureConnection*)connection {(void)output;(void)sample;(void)connection;_state->late++;}
@end
struct CameraOwner {
    std::shared_ptr<CameraState> state=std::make_shared<CameraState>();
    AVCaptureSession *session=nil;AVCaptureVideoDataOutput *output=nil;ProducerCameraDelegate *delegate=nil;
    dispatch_queue_t delivery=dispatch_queue_create("producer.camera-lab.delivery",DISPATCH_QUEUE_SERIAL);id observer=nil;
    ~CameraOwner() {
        state->stopping=true;
        if(observer)[[NSNotificationCenter defaultCenter] removeObserver:observer];
        [session stopRunning];[output setSampleBufferDelegate:nil queue:nil];
        dispatch_sync(delivery,^{});delegate=nil;output=nil;session=nil;observer=nil;
    }
};
extern "C" int lab_camera_permissions() {
    @autoreleasepool {
        [NSApplication sharedApplication];
        for(AVMediaType type in @[AVMediaTypeVideo,AVMediaTypeAudio]) {
            if([AVCaptureDevice authorizationStatusForMediaType:type]==AVAuthorizationStatusNotDetermined)[AVCaptureDevice requestAccessForMediaType:type completionHandler:^(BOOL granted){(void)granted;}];
            auto deadline=[NSDate dateWithTimeIntervalSinceNow:120];
            while([AVCaptureDevice authorizationStatusForMediaType:type]==AVAuthorizationStatusNotDetermined && deadline.timeIntervalSinceNow>0)[[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
            if([AVCaptureDevice authorizationStatusForMediaType:type]!=AVAuthorizationStatusAuthorized)return 0;
        }
        return 1;
    }
}
extern "C" int lab_camera_authorized() {return [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]==AVAuthorizationStatusAuthorized;}
extern "C" void *lab_camera_create(char *error,size_t length) {
    @autoreleasepool { @try {
        auto fail=[&](NSString *message)->void* {snprintf(error,length,"%s",message.UTF8String);return nullptr;};
        if(!lab_camera_authorized())return fail(@"Camera permission must be granted before capture");
        auto owner=std::make_unique<CameraOwner>();owner->session=[[AVCaptureSession alloc]init];
        auto discovery=[AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[AVCaptureDeviceTypeBuiltInWideAngleCamera] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified];
        AVCaptureDevice *device=discovery.devices.firstObject;
        if(!device)return fail(@"No built-in camera found; no automatic external/continuity camera fallback");
        NSError *problem=nil;auto input=[AVCaptureDeviceInput deviceInputWithDevice:device error:&problem];
        if(!input || ![owner->session canAddInput:input])return fail(problem.localizedDescription?:@"Camera input unavailable");
        [owner->session addInput:input];
        if(![owner->session canSetSessionPreset:AVCaptureSessionPreset640x480])return fail(@"Camera does not support 640x480");
        owner->session.sessionPreset=AVCaptureSessionPreset640x480;
        owner->output=[[AVCaptureVideoDataOutput alloc]init];owner->output.alwaysDiscardsLateVideoFrames=YES;
        owner->output.videoSettings=@{(id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),(id)kCVPixelBufferWidthKey:@640,(id)kCVPixelBufferHeightKey:@480};
        if(![owner->session canAddOutput:owner->output])return fail(@"Camera output unavailable");
        [owner->session addOutput:owner->output];
        owner->delegate=[[ProducerCameraDelegate alloc]initWithState:owner->state session:owner->session];
        [owner->output setSampleBufferDelegate:owner->delegate queue:owner->delivery];
        auto state=owner->state;
        owner->observer=[[NSNotificationCenter defaultCenter]addObserverForName:AVCaptureSessionRuntimeErrorNotification object:owner->session queue:nil usingBlock:^(NSNotification*){state->fault(8);}];
        [owner->session startRunning];
        if(!owner->session.running)return fail(@"Camera session did not start");
        snprintf(error,length,"%s; 640x480 NV12 video range",device.localizedName.UTF8String);
        return owner.release();
    } @catch(NSException *problem){snprintf(error,length,"%s",problem.reason.UTF8String);return nullptr;} }
}
extern "C" int lab_camera_pending(void *handle) {auto state=((CameraOwner*)handle)->state;return state->written.load(std::memory_order_acquire)!=state->read.load(std::memory_order_acquire);}
extern "C" int lab_camera_pop(void *handle,uint8_t *y,uint8_t *u,uint8_t *v,uint64_t *host_ns) {return ((CameraOwner*)handle)->state->pop(y,u,v,host_ns);}
extern "C" uint64_t lab_camera_errors(void *handle) {return ((CameraOwner*)handle)->state->errors;}
extern "C" void lab_camera_close(void *handle,uint64_t *stats) {
    auto owner=(CameraOwner*)handle;auto state=owner->state;std::weak_ptr<CameraState> weak=state;delete owner;
    stats[7]=state->first_fault;stats[8]=state->actual_format;stats[9]=state->actual_width;stats[10]=state->actual_height;
    stats[0]=state->written;stats[1]=state->read;stats[2]=state->overflow;stats[3]=state->late;stats[4]=state->errors;stats[5]=state->callbacks;
    state.reset();stats[6]=weak.expired();
}
extern "C" int lab_camera_self_test() {
    @autoreleasepool {
        CVPixelBufferRef pixel=nullptr;
        if(CVPixelBufferCreate(kCFAllocatorDefault,640,480,kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,nullptr,&pixel)!=kCVReturnSuccess)return 0;
        CVPixelBufferLockBaseAddress(pixel,0);
        memset(CVPixelBufferGetBaseAddressOfPlane(pixel,0),80,CVPixelBufferGetBytesPerRowOfPlane(pixel,0)*480);
        auto uv=(uint8_t*)CVPixelBufferGetBaseAddressOfPlane(pixel,1);auto stride=CVPixelBufferGetBytesPerRowOfPlane(pixel,1);
        for(size_t row=0;row<240;row++)for(size_t col=0;col<320;col++){uv[row*stride+col*2]=90;uv[row*stride+col*2+1]=170;}
        CVPixelBufferUnlockBaseAddress(pixel,0);
        auto state=std::make_unique<CameraState>();
        for(uint64_t n=1;n<=3;n++)if(!state->push(pixel,n))return 0;
        if(state->push(pixel,4) || state->overflow!=1)return 0;
        std::array<uint8_t,camera_bytes> out{};uint64_t stamp=0;
        for(uint64_t n=1;n<=3;n++) {
            if(!state->pop(out.data(),out.data()+640*480,out.data()+640*480+320*240,&stamp) || stamp!=n)return 0;
            for(size_t k=0;k<640*480;k++)if(out[k]!=80)return 0;
            for(size_t k=640*480;k<640*480+320*240;k++)if(out[k]!=90)return 0;
            for(size_t k=640*480+320*240;k<camera_bytes;k++)if(out[k]!=170)return 0;
        }
        if(state->pop(out.data(),out.data()+640*480,out.data()+640*480+320*240,&stamp))return 0;
        if(state->push(pixel,4) || state->errors!=1)return 0;
        CVPixelBufferRelease(pixel);return 1;
    }
}
