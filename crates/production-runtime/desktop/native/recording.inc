// AVFoundation encoding only. Rust owns take identity, durable storage and readiness.
// All writer mutation is confined to _writerQueue. Callbacks enqueue bounded work.
// Active capture has real-time deadlines even when the room window is obscured.
// Access the activity token only on the writer queue.
static void endRecordingActivity(NRRoom *r) {
    if(r->_recordActivity) {
        [[NSProcessInfo processInfo] endActivity:r->_recordActivity];
        r->_recordActivity=nil;
    }
}

static void recordFail(NRRoom *r,NSString *message) {
    endRecordingActivity(r);atomic_store(&r->_recordEnabled,false);r->_recording=NO;
    for(int i=0;i<(int)r->_trackCount;i++)if(r->_writers[i].status==AVAssetWriterStatusWriting)[r->_writers[i] cancelWriting];
    if(r->_segment&&!atomic_load(&r->_closing)) {
        NSData *d=[message dataUsingEncoding:NSUTF8StringEncoding];
        r->_segment(r->_context,atomic_load(&r->_recordSession),0,3,d.bytes,MIN(d.length,1024),NULL,0);
    }
    [r status:8 text:message];
}
static void recordRequestFailure(NRRoom *r,NSString *message,uint64_t session) {
    if(!atomic_exchange(&r->_recordEnabled,false))return;
    dispatch_async(r->_writerQueue,^{if(session==atomic_load(&r->_recordSession))recordFail(r,message);});
}
@interface NRSegment : NSObject<AVAssetWriterDelegate>
@property(nonatomic,weak) NRRoom *room;
@property(nonatomic) uint32_t track;
@property(nonatomic) uint64_t session;
@end
@implementation NRSegment
- (void)assetWriter:(AVAssetWriter*)writer didOutputSegmentData:(NSData*)data segmentType:(AVAssetSegmentType)type segmentReport:(AVAssetSegmentReport*)report {
    NRRoom *r=self.room;if(!r)return;
    atomic_fetch_add(&r->_segmentInFlight,1);
    if(!atomic_load(&r->_closing)&&self.session==atomic_load(&r->_recordSession)) {
        NRSpan spans[2]={0};size_t count=0;BOOL valid=YES;
        if(type==AVAssetSegmentTypeSeparable)for(AVAssetSegmentTrackReport *t in report.trackReports) {
            // AVAssetWriter can include a zero-sample track report in the
            // final fragment. It is absence, not a zero-time audio sample.
            if(CMTIME_IS_NUMERIC(t.duration)&&CMTimeCompare(t.duration,kCMTimeZero)==0)continue;
            if(count>=2||!CMTIME_IS_NUMERIC(t.earliestPresentationTimeStamp)||!CMTIME_IS_NUMERIC(t.duration)){valid=NO;break;}
            uint32_t media=[t.mediaType isEqual:AVMediaTypeVideo]?0:1;
            if(media==0&&!t.firstVideoSampleInformation.isSyncSample){valid=NO;break;}
            CMTime start=t.earliestPresentationTimeStamp,duration=t.duration;
            spans[count++]=(NRSpan){start.value,duration.value,start.timescale,duration.timescale,media};
        }
        if(!valid||((type!=AVAssetSegmentTypeSeparable||count>0)&&!r->_segment(r->_context,self.session,self.track,type==AVAssetSegmentTypeInitialization?0:1,data.bytes,data.length,spans,count)))
            recordRequestFailure(r,@"Encoded segment could not be committed; recording stopped",self.session);
    }
    atomic_fetch_sub(&r->_segmentInFlight,1);
}
@end

// Reserve 320 ms of 10 ms program PCM. Two 30 fps HD tracks can deliver
// 16 pictures in a 250 ms writer pause; four more slots cover drain jitter.
// Apply the larger surface budget only to the two bounded-size program tracks.
enum { audioWriterBlocks = 32, pairedHDWriterFrames = 20 };
static void recordVideo(NRRoom *r,uint32_t source,CVPixelBufferRef buffer,double pts) {
    if(!atomic_load(&r->_recordEnabled)||source>3)return;
    if(source<2&&!(atomic_load(&r->_programMask)&(1u<<source)))return;
    if(source>=2&&!(atomic_load(&r->_originalMask)&(1u<<(source-2))))return;
    uint64_t session=atomic_load(&r->_recordSession);
    int capacity = atomic_load(&r->_pairedHDWriter) ? pairedHDWriterFrames : 6;
    int pending = atomic_fetch_add(&r->_writerPending,1);
    timing(r,11,pending+1,pts);
    if(pending>=capacity){atomic_fetch_sub(&r->_writerPending,1);recordRequestFailure(r,@"Video recording queue full; committed footage retained",session);return;}
    CVPixelBufferRetain(buffer);
    dispatch_async(r->_writerQueue,^{@autoreleasepool {
        int track=source<2?r->_program[source]:r->_original[source-2];
        if(r->_recording&&session==atomic_load(&r->_recordSession)&&track>=0) {
            CMTime t=CMTimeMakeWithSeconds(pts-r->_recordOrigin,48000);
            if(t.value>=0) {
                if(CVPixelBufferGetWidth(buffer)!=r->_trackWidth[track]||CVPixelBufferGetHeight(buffer)!=r->_trackHeight[track])recordFail(r,@"Original source changed dimensions; start a new take for its new incarnation");
                else if(!r->_video[track].readyForMoreMediaData)recordFail(r,@"Video encoder backpressure; committed footage retained");
                else if(![r->_adaptors[track] appendPixelBuffer:buffer withPresentationTime:t])recordFail(r,r->_writers[track].error.localizedDescription?:@"Video sample rejected");
                else if(source<2){
                    timing(r,4,source,pts);
                    if(r->_pressure){
                        NSNumber *width=(__bridge NSNumber*)CVBufferGetAttachment(buffer,CFSTR("P0EncoderPin"),NULL);
                        if(width){pressureEncoder(r,buffer,width.unsignedIntegerValue);CVBufferRemoveAttachment(buffer,CFSTR("P0EncoderPin"));}
                    }
                }
            }
        }
        CVPixelBufferRelease(buffer);atomic_fetch_sub(&r->_writerPending,1);
    }});
}

int nr_record_start(void *handle,uint64_t session,double origin,const NRRecordTrack *tracks,size_t count,NRSegmentCallback callback) {
    NRRoom *r=(__bridge NRRoom*)handle;
    if(count<1||count>5||!callback)return 0;
    NSData *configs=[NSData dataWithBytes:tracks length:count*sizeof(NRRecordTrack)];
    dispatch_async(r->_writerQueue,^{@autoreleasepool { @try {
        if(r->_recording||r->_finishing){callback(r->_context,session,0,3,"Previous encoder is still finalizing",35,NULL,0);return;}
        if(r->_pressure && !atomic_load(&r->_pressurePinned))atomic_store(&r->_pressureArmed,false);
        r->_recordActivity=[[NSProcessInfo processInfo] beginActivityWithOptions:(NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical) reason:@"Capturing timed program audio and video"];
        if(r->_timingHome){
            NSString *fault = [NSString stringWithContentsOfFile:[r->_timingHome stringByAppendingPathComponent:@"p0-stall-lane"] encoding:NSUTF8StringEncoding error:nil];
            atomic_store(&r->_p0StallLane, [fault isEqual:@"renderer"] ? 1 : [fault isEqual:@"recorder"] ? 2 : 0);
            atomic_store(&r->_p0OldBudget,[[NSFileManager defaultManager] fileExistsAtPath:[r->_timingHome stringByAppendingPathComponent:@"p0-old-budget"]]);
            atomic_store(&r->_p0HoldSurface,[[NSFileManager defaultManager] fileExistsAtPath:[r->_timingHome stringByAppendingPathComponent:@"p0-hold-surface"]]);
        }
        atomic_store(&r->_recordSession,session);r->_segment=callback;r->_trackCount=(uint32_t)count;r->_recordOrigin=origin;
        r->_program[0]=r->_program[1]=-1;
        r->_original[0]=r->_original[1]=r->_micTrack=-1;
        const NRRecordTrack *t=configs.bytes;uint32_t mask=0;
        BOOL pairedHD = count == 2 && t[0].kind < 2 && t[1].kind < 2 && t[0].kind != t[1].kind;
        for (size_t i=0; pairedHD && i<count; ++i)
            pairedHD = (uint64_t)t[i].width * t[i].height <= 1920u * 1080u;
        atomic_store(&r->_pairedHDWriter,pairedHD);
        for(int i=0;i<(int)count;i++) {
            r->_writers[i]=[[AVAssetWriter alloc] initWithContentType:UTTypeMPEG4Movie];
            r->_writers[i].outputFileTypeProfile=AVFileTypeProfileMPEG4AppleHLS;
            r->_writers[i].preferredOutputSegmentInterval=CMTimeMake(2,1);
            r->_writers[i].initialSegmentStartTime=kCMTimeZero;
            NRSegment *delegate=[NRSegment new];delegate.room=r;delegate.track=i;delegate.session=session;
            r->_delegates[i]=delegate;r->_writers[i].delegate=delegate;
            r->_video[i]=nil;r->_sound[i]=nil;r->_adaptors[i]=nil;
            r->_trackWidth[i]=t[i].width;r->_trackHeight[i]=t[i].height;
            if(t[i].kind<2)r->_program[t[i].kind]=i;
            else if(t[i].kind<4){r->_original[t[i].kind-2]=i;mask|=1u<<(t[i].kind-2);}
            else {r->_micTrack=i;mask|=4;}
            if(t[i].width>0) {
                NSDictionary *settings=@{AVVideoCodecKey:AVVideoCodecTypeH264,AVVideoWidthKey:@(t[i].width),AVVideoHeightKey:@(t[i].height),AVVideoCompressionPropertiesKey:@{AVVideoAverageBitRateKey:@(r->_streamEncoding?MIN(6000000u,t[i].width*t[i].height*5):t[i].width*t[i].height*5),AVVideoExpectedSourceFrameRateKey:@30,AVVideoMaxKeyFrameIntervalKey:@30,AVVideoAllowFrameReorderingKey:@NO},AVVideoColorPropertiesKey:@{AVVideoColorPrimariesKey:AVVideoColorPrimaries_ITU_R_709_2,AVVideoTransferFunctionKey:AVVideoTransferFunction_ITU_R_709_2,AVVideoYCbCrMatrixKey:AVVideoYCbCrMatrix_ITU_R_601_4}};
                r->_video[i]=[AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:settings];
                r->_video[i].expectsMediaDataInRealTime=YES;
                r->_adaptors[i]=[AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:r->_video[i] sourcePixelBufferAttributes:nil];
                if(![r->_writers[i] canAddInput:r->_video[i]]){recordFail(r,@"Video encoder setup refused");return;}
                [r->_writers[i] addInput:r->_video[i]];
            }
            if(t[i].kind<2||t[i].kind==4) {
                r->_sound[i]=[AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio outputSettings:@{AVFormatIDKey:@(kAudioFormatMPEG4AAC),AVSampleRateKey:@48000,AVNumberOfChannelsKey:@2,AVEncoderBitRateKey:@128000}];
                r->_sound[i].expectsMediaDataInRealTime=YES;
                if(![r->_writers[i] canAddInput:r->_sound[i]]){recordFail(r,@"Audio encoder setup refused");return;}
                [r->_writers[i] addInput:r->_sound[i]];
            }
            if(![r->_writers[i] startWriting]){recordFail(r,r->_writers[i].error.localizedDescription?:@"Recording encoder failed to start");return;}
            [r->_writers[i] startSessionAtSourceTime:kCMTimeZero];
        }
        atomic_store(&r->_programMask,(r->_program[0]>=0?1u:0u)|(r->_program[1]>=0?2u:0u));
        atomic_store(&r->_originalMask,mask);r->_recording=YES;atomic_store(&r->_recordEnabled,true);[r status:8 text:@"Recording · durable segments"];
    } @catch(NSException *e){recordFail(r,e.reason?:@"Recording encoder exception");} }});return 1;
}
static void appendRecordingAudio(NRRoom *r,NSData *data,uint32_t frames,CMTime at,BOOL original) {
    CMBlockBufferRef bb=NULL;CMAudioFormatDescriptionRef format=NULL;CMSampleBufferRef sample=NULL;
    AudioStreamBasicDescription asbd={.mSampleRate=48000,.mFormatID=kAudioFormatLinearPCM,.mFormatFlags=kAudioFormatFlagIsFloat|kAudioFormatFlagIsPacked,.mBytesPerPacket=8,.mFramesPerPacket=1,.mBytesPerFrame=8,.mChannelsPerFrame=2,.mBitsPerChannel=32};
    OSStatus e=CMBlockBufferCreateWithMemoryBlock(NULL,NULL,data.length,NULL,NULL,0,data.length,0,&bb);
    if(e==noErr)e=CMBlockBufferReplaceDataBytes(data.bytes,bb,0,data.length);
    if(e==noErr)e=CMAudioFormatDescriptionCreate(NULL,&asbd,0,NULL,0,NULL,NULL,&format);
    CMSampleTimingInfo timing={CMTimeMake(1,48000),at,kCMTimeInvalid};size_t bytes=8;
    if(e==noErr)e=CMSampleBufferCreate(NULL,bb,YES,NULL,NULL,format,frames,1,&timing,1,&bytes,&sample);
    if(e!=noErr)recordFail(r,@"Audio sample construction failed");
    else for(int i=0;i<(int)r->_trackCount && r->_recording;i++)if((original?i==r->_micTrack:i==r->_program[0]||i==r->_program[1])) {
        if(!r->_sound[i].readyForMoreMediaData)recordFail(r,@"Audio encoder backpressure; committed footage retained");
        else if(![r->_sound[i] appendSampleBuffer:sample])recordFail(r,r->_writers[i].error.localizedDescription?:@"Audio sample rejected");
    }
    if(sample)CFRelease(sample);if(format)CFRelease(format);if(bb)CFRelease(bb);
}
void nr_record_audio(void *handle,const float *samples,const float *original,uint32_t frames,double pts) {
    NRRoom *r=(__bridge NRRoom*)handle;
    if(r->_liveWriter)nr_record_audio((__bridge void*)r->_liveWriter,samples,original,frames,pts);
    if(r->_clipWriter)nr_record_audio((__bridge void*)r->_clipWriter,samples,original,frames,pts);
    if(!atomic_load(&r->_recordEnabled)||frames==0||frames>480)return;
    uint64_t session=atomic_load(&r->_recordSession);
    // One 10 ms task owns both program and original mic, with independent video
    // admission. A four-block mixer catch-up cannot consume eight shared slots.
    int pending = atomic_fetch_add(&r->_audioWriterPending,1);
    timing(r,12,pending+1,pts);
    if(pending>=audioWriterBlocks){atomic_fetch_sub(&r->_audioWriterPending,1);recordRequestFailure(r,@"Audio recording queue full; committed footage retained",session);return;}
    NSData *mix=[NSData dataWithBytes:samples length:(size_t)frames*8];
    NSData *raw=(atomic_load(&r->_originalMask)&4)?[NSData dataWithBytes:original length:(size_t)frames*8]:nil;
    dispatch_async(r->_writerQueue,^{@autoreleasepool {
        if(r->_recording&&session==atomic_load(&r->_recordSession)) {
            p0Stall(r,2,pts);
            CMTime at=CMTimeMakeWithSeconds(pts-r->_recordOrigin,48000);
            if(at.value>=0) {
                appendRecordingAudio(r,mix,frames,at,NO);
                if(raw&&r->_recording)appendRecordingAudio(r,raw,frames,at,YES);
            }
        }
        atomic_fetch_sub(&r->_audioWriterPending,1);
    }});
}

void nr_record_stop(void *handle) {
    NRRoom *r=(__bridge NRRoom*)handle;atomic_store(&r->_recordEnabled,false);
    uint64_t sessionAtStop=atomic_load(&r->_recordSession);
    if(r->_timing)dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY,0),^{saveTiming(r,sessionAtStop);});
    dispatch_async(r->_writerQueue,^{@autoreleasepool {
        if(!r->_recording)return;r->_recording=NO;r->_finishing=YES;
        dispatch_group_t group=dispatch_group_create();uint64_t session=atomic_load(&r->_recordSession);
        for(int i=0;i<(int)r->_trackCount;i++)if(r->_writers[i].status==AVAssetWriterStatusWriting) {
            if(r->_video[i])[r->_video[i] markAsFinished];if(r->_sound[i])[r->_sound[i] markAsFinished];
            AVAssetWriter *writer=r->_writers[i];dispatch_group_enter(group);
            [writer finishWritingWithCompletionHandler:^{
                dispatch_async(r->_writerQueue,^{
                    if(!atomic_load(&r->_closing)) {
                        if(writer.status==AVAssetWriterStatusCompleted)r->_segment(r->_context,session,i,2,NULL,0,NULL,0);
                        else recordFail(r,writer.error.localizedDescription?:@"Recording finalization failed");
                    }
                    dispatch_group_leave(group);
                });
            }];
        }
        dispatch_group_notify(group,r->_writerQueue,^{r->_finishing=NO;endRecordingActivity(r);[r status:8 text:@"Encoder finalized; committing take"];});
    }});
}
