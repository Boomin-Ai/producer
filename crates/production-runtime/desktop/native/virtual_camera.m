#import <CoreMediaIO/CMIOHardware.h>
#import <VideoToolbox/VideoToolbox.h>
#import <Foundation/Foundation.h>

// Owned by one writer thread. The extension consumes the retained samples.
typedef struct {
    CMIOObjectID device, stream;
    CMSimpleQueueRef queue;
    CVPixelBufferPoolRef pool;
    VTPixelTransferSessionRef transfer;
    CMVideoFormatDescriptionRef sampleFormat;
    BOOL started;
} NRVirtualCamera;

static CMIOObjectPropertyAddress property(UInt32 selector) {
    return (CMIOObjectPropertyAddress){selector,kCMIOObjectPropertyScopeGlobal,kCMIOObjectPropertyElementMain};
}
static NSData *ids(CMIOObjectID object, CMIOObjectPropertyAddress address) {
    UInt32 size=0, used=0;
    if (CMIOObjectGetPropertyDataSize(object,&address,0,NULL,&size) || !size) return nil;
    NSMutableData *data=[NSMutableData dataWithLength:size];
    if (CMIOObjectGetPropertyData(object,&address,0,NULL,size,&used,data.mutableBytes)) return nil;
    data.length=used;
    return data;
}
static CMIOObjectID deviceID(void) {
    NSData *devices=ids(kCMIOObjectSystemObject,property(kCMIOHardwarePropertyDevices));
    const CMIOObjectID *items=devices.bytes;
    for (NSUInteger i=0;i<devices.length/sizeof(*items);i++) {
        CFStringRef uid=NULL; UInt32 size=0;
        CMIOObjectPropertyAddress address=property(kCMIODevicePropertyDeviceUID);
        if (!CMIOObjectGetPropertyData(items[i],&address,0,NULL,sizeof(uid),&size,&uid) && uid) {
            BOOL match=CFEqual(uid,CFSTR("7626645E-4425-469E-9D8B-97E0FA59AC75"));
            CFRelease(uid);
            if (match) return items[i];
        }
    }
    return 0;
}
void nr_vcam_close(NRVirtualCamera *v) {
    if (!v) return;
    if (v->started) CMIODeviceStopStream(v->device,v->stream);
    if (v->queue) CFRelease(v->queue);
    if (v->transfer) CFRelease(v->transfer);
    if (v->pool) CFRelease(v->pool);
    if (v->sampleFormat) CFRelease(v->sampleFormat);
    free(v);
}
static void queueChanged(__unused CMIOStreamID stream, __unused void *token, __unused void *refcon) { }
NRVirtualCamera *nr_vcam_open(bool portrait, char *error, size_t cap) {
    @autoreleasepool {
        const char *reason="Producer Virtual Camera is unavailable. Install or approve it in setup.";
        NRVirtualCamera *v=calloc(1,sizeof(*v));
        if (!v) return NULL;
        v->device=deviceID();
        CMIOObjectPropertyAddress a=property(kCMIODevicePropertyStreams);
        a.mScope=kCMIODevicePropertyScopeOutput;
        NSData *streams=v->device ? ids(v->device,a) : nil;
        if (streams.length>=sizeof(v->stream)) memcpy(&v->stream,streams.bytes,sizeof(v->stream));
        int w=portrait?1080:1920,h=portrait?1920:1080;
        if (v->stream) {
            reason="The camera rejected this format. Close the receiving camera and retry.";
            a=property(kCMIOStreamPropertyFormatDescription);
            CMVideoFormatDescriptionRef requested=NULL, actual=NULL; UInt32 used=0;
            BOOL ok=!CMVideoFormatDescriptionCreate(NULL,kCVPixelFormatType_32BGRA,w,h,NULL,&requested)
                && !CMIOObjectSetPropertyData(v->stream,&a,0,NULL,sizeof(requested),&requested)
                && !CMIOObjectGetPropertyData(v->stream,&a,0,NULL,sizeof(actual),&used,&actual) && actual;
            if (requested) CFRelease(requested);
            if (actual) {
                CMVideoDimensions dimensions=CMVideoFormatDescriptionGetDimensions(actual);
                ok=ok && dimensions.width==w && dimensions.height==h && CMFormatDescriptionGetMediaSubType(actual)==kCVPixelFormatType_32BGRA;
                CFRelease(actual);
            }
            NSDictionary *attrs=@{(id)kCVPixelBufferWidthKey:@(w),(id)kCVPixelBufferHeightKey:@(h),
                (id)kCVPixelBufferPixelFormatTypeKey:@(kCVPixelFormatType_32BGRA),(id)kCVPixelBufferIOSurfacePropertiesKey:@{}};
            if (ok) {
                reason="Could not start the camera sink. Check that another Producer is not using it.";
                OSStatus status=CVPixelBufferPoolCreate(NULL,NULL,(__bridge CFDictionaryRef)attrs,&v->pool);
                if (!status) status=VTPixelTransferSessionCreate(NULL,&v->transfer);
                if (!status) status=CMIOStreamCopyBufferQueue(v->stream,queueChanged,NULL,&v->queue);
                if (!status && v->queue) {
                    status=CMIODeviceStartStream(v->device,v->stream);
                    if (!status) { v->started=YES; return v; }
                }
                snprintf(error,cap,"%s (OSStatus %d)",reason,(int)status);
                nr_vcam_close(v); return NULL;
            }
        }
        snprintf(error,cap,"%s",reason);
        nr_vcam_close(v); return NULL;
    }
}
int nr_vcam_frame(NRVirtualCamera *v,CVPixelBufferRef source,double pts,char *error,size_t cap) {
    @autoreleasepool {
        if (CMSimpleQueueGetCount(v->queue)>=CMSimpleQueueGetCapacity(v->queue)) return 0;
        CVPixelBufferRef dest=NULL;
        CVReturn alloc=CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(NULL,v->pool,
            (__bridge CFDictionaryRef)@{(id)kCVPixelBufferPoolAllocationThresholdKey:@8},&dest);
        if (alloc==kCVReturnWouldExceedAllocationThreshold) return 0;
        if (alloc) {
            snprintf(error,cap,"Virtual camera buffer allocation failed (OSStatus %d)",(int)alloc);
            return -1;
        }
        CMSampleTimingInfo timing={CMTimeMake(1,30),CMTimeMakeWithSeconds(pts,1000000000),kCMTimeInvalid};
        CMSampleBufferRef sample=NULL;
        OSStatus status=VTPixelTransferSessionTransferImage(v->transfer,source,dest);
        const char *stage="pixel conversion";
        if (!status) {
            // VideoToolbox can propagate color and aperture attachments while
            // converting. Core Media requires the description to match those
            // attachments as well as the pixel type and dimensions.
            stage="format description";
            if (!v->sampleFormat || !CMVideoFormatDescriptionMatchesImageBuffer(v->sampleFormat,dest)) {
                CMVideoFormatDescriptionRef format=NULL;
                status=CMVideoFormatDescriptionCreateForImageBuffer(NULL,dest,&format);
                if (!status) {
                    if (v->sampleFormat) CFRelease(v->sampleFormat);
                    v->sampleFormat=format;
                }
            }
        }
        if (!status) {
            stage="sample creation";
            status=CMSampleBufferCreateReadyWithImageBuffer(NULL,dest,v->sampleFormat,&timing,&sample);
        }
        CVPixelBufferRelease(dest);
        if (!status) {
            status=CMSimpleQueueEnqueue(v->queue,sample);
            if (!status) return 1;
            CFRelease(sample);
            if (status==kCMSimpleQueueError_QueueIsFull) return 0;
            stage="queue submission";
        }
        snprintf(error,cap,"Virtual camera %s failed (OSStatus %d)",stage,(int)status);
        return -1;
    }
}
