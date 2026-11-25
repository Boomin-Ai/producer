// Local fault probe. Two independent leases can refer to the same IOSurface.
static void pressureEvent(NRRoom *r, NSString *kind, CVPixelBufferRef surface, size_t width, double age) {
    if(!r->_pressure)return;
    double at=nr_host_time();
    size_t bytes=surface?CVPixelBufferGetDataSize(surface):0;
    uintptr_t address=(uintptr_t)surface;
    dispatch_async(r->_pressureLog,^{
        NSDictionary *e=@{@"event":kind,@"at":@(at),@"bytes":@(bytes),@"surface":@(address),@"sourceWidth":@(width),@"sourceAgeMs":@(age)};
        NSData *data=[NSJSONSerialization dataWithJSONObject:e options:0 error:nil];
        FILE *f=fopen([r->_timingHome stringByAppendingPathComponent:@"pressure.jsonl"].fileSystemRepresentation,"a");
        if(f){fwrite(data.bytes,1,data.length,f);fputc('\n',f);fclose(f);}
    });
}
static void pressureLease(NRRoom *r,CVPixelBufferRef b,NSString *owner,size_t width){
    CVPixelBufferRetain(b);
    pressureEvent(r,[owner stringByAppendingString:@" acquired"],b,width,0);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,1000000000),r->_pressureLog,^{
        pressureEvent(r,[owner stringByAppendingString:@" released"],b,width,0);
        CVPixelBufferRelease(b);
        if([owner isEqualToString:@"preview"])atomic_store(&r->_pressurePinned,false);
    });
}

// A separate hardware session receives the exact surface accepted by the writer.
// Delay its output callback on the codec queue, outside the live writer and GPU queues.
static void pressureEncoder(NRRoom *room, CVPixelBufferRef surface, size_t sourceWidth) {
    CVPixelBufferRetain(surface);
    pressureEvent(room, @"encoder acquired", surface, sourceWidth, 0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        VTCompressionSessionRef encoder = NULL;
        NSDictionary *spec = @{(__bridge NSString *)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES};
        OSStatus status = VTCompressionSessionCreate(NULL, (int32_t)CVPixelBufferGetWidth(surface),
            (int32_t)CVPixelBufferGetHeight(surface), kCMVideoCodecType_H264,
            (__bridge CFDictionaryRef)spec, NULL, NULL, NULL, NULL, &encoder);
        if (status == noErr) {
            status = VTSessionSetProperty(encoder, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
        }
        if (status == noErr) {
            status = VTCompressionSessionEncodeFrameWithOutputHandler(encoder, surface,
                kCMTimeZero, CMTimeMake(1, 30), NULL, NULL,
                ^(OSStatus outputStatus, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
                    if (outputStatus || (flags & kVTEncodeInfo_FrameDropped) || !sample || !CMSampleBufferGetTotalSampleSize(sample)) {
                        pressureEvent(room, @"hardware frame failed", surface, sourceWidth, 0);
                        return;
                    }
                    pressureEvent(room, @"hardware callback held", surface, sourceWidth, 0);
                    [NSThread sleepForTimeInterval:1.0];
                    pressureEvent(room, @"hardware callback resumed", surface, sourceWidth, 0);
                });
        }
        if (status == noErr) status = VTCompressionSessionCompleteFrames(encoder, kCMTimeInvalid);
        if (encoder) {
            VTCompressionSessionInvalidate(encoder);
            CFRelease(encoder);
        }
        if (status) pressureEvent(room, [NSString stringWithFormat:@"hardware error %d", (int)status], surface, sourceWidth, 0);
        pressureEvent(room, @"encoder released", surface, sourceWidth, 0);
        CVPixelBufferRelease(surface);
    });
}
