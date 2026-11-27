// Created only for an explicitly profiled private renderer. Read counters only after completion.
@interface NRRehearsalTiming : NSObject {
    id<MTLCounterSampleBuffer> _samples;
    NSMutableArray<NSDictionary*> *_passes;
    MTLTimestamp _cpuStart, _gpuStart;
}
- (instancetype)initWithDevice:(id<MTLDevice>)device;
- (void)attach:(MTLRenderPassDescriptor*)descriptor kind:(NSString*)kind slot:(int)slot;
- (NSDictionary*)finish:(id<MTLCommandBuffer>)command;
@end

@implementation NRRehearsalTiming
- (instancetype)initWithDevice:(id<MTLDevice>)device {
    self=[super init];
    if (!self) return nil;
    _passes=[NSMutableArray new];
    if (![device supportsCounterSampling:MTLCounterSamplingPointAtStageBoundary]) return self;
    for (id<MTLCounterSet> set in device.counterSets) {
        if (![set.name isEqual:MTLCommonCounterSetTimestamp]) continue;
        MTLCounterSampleBufferDescriptor *desc=[MTLCounterSampleBufferDescriptor new];
        desc.counterSet=set;
        desc.storageMode=MTLStorageModeShared;
        desc.sampleCount=65*4; // At most 64 prepared graph slots and the fallback compositor.
        _samples=[device newCounterSampleBufferWithDescriptor:desc error:NULL];
        if (_samples) [device sampleTimestamps:&_cpuStart gpuTimestamp:&_gpuStart];
        break;
    }
    return self;
}
- (void)attach:(MTLRenderPassDescriptor*)descriptor kind:(NSString*)kind slot:(int)slot {
    NSUInteger index=_passes.count;
    if (index>=65) return;
    [_passes addObject:@{@"kind":kind, @"preparedSlot":@(slot)}];
    if (!_samples) return;
    MTLRenderPassSampleBufferAttachmentDescriptor *a=descriptor.sampleBufferAttachments[0];
    a.sampleBuffer=_samples;
    a.startOfVertexSampleIndex=index*4;
    a.endOfVertexSampleIndex=index*4+1;
    a.startOfFragmentSampleIndex=index*4+2;
    a.endOfFragmentSampleIndex=index*4+3;
}
- (NSDictionary*)finish:(id<MTLCommandBuffer>)command {
    NSMutableDictionary *result=[@{@"device":command.device.name, @"scope":@"private rehearsal",
        @"measurement":@"commandBuffer"} mutableCopy];
    CFTimeInterval start=command.GPUStartTime, end=command.GPUEndTime;
    if (start>0 && end>=start) result[@"commandBufferMs"]=@(1000*(end-start));
    else result[@"measurement"]=@"unavailable";
    if (!_samples || !_passes.count) return result;
    MTLTimestamp cpu=0,gpu=0;
    [command.device sampleTimestamps:&cpu gpuTimestamp:&gpu];
    if (cpu<=_cpuStart || gpu<=_gpuStart) return result;
    // Metal sampleTimestamps reports the paired CPU timestamps in nanoseconds.
    double msPerTick=(double)(cpu-_cpuStart)/(gpu-_gpuStart)/1e6;
    NSData *resolved=[_samples resolveCounterRange:NSMakeRange(0,_passes.count*4)];
    if (resolved.length!=_passes.count*4*sizeof(MTLCounterResultTimestamp)) return result;
    const MTLCounterResultTimestamp *sample=resolved.bytes;
    NSMutableArray *readings=[NSMutableArray new];
    for (NSUInteger i=0;i<_passes.count;i++) {
        uint64_t vs=sample[4*i].timestamp, ve=sample[4*i+1].timestamp;
        uint64_t fs=sample[4*i+2].timestamp, fe=sample[4*i+3].timestamp;
        if (!vs || !fs || ve==MTLCounterErrorValue || fe==MTLCounterErrorValue || ve<vs || fe<fs) continue;
        NSMutableDictionary *pass=[_passes[i] mutableCopy];
        pass[@"vertexMs"]=@((ve-vs)*msPerTick);
        pass[@"fragmentMs"]=@((fe-fs)*msPerTick);
        pass[@"stageEnvelopeMs"]=@((MAX(ve,fe)-MIN(vs,fs))*msPerTick);
        [readings addObject:pass];
    }
    if (readings.count) {
        result[@"measurement"]=@"metalStageTimestamps";
        result[@"renderEncoders"]=readings;
        result[@"missingEncoderSamples"]=@(_passes.count-readings.count);
    }
    return result;
}
@end

void nr_set_rehearsal_timing(void *handle, bool active) {
    NRRoom *r=(__bridge NRRoom*)handle;
    r->_profileRehearsal=active;
}

char *nr_rehearsal_timing(void *handle, uint32_t output, uint64_t generation) {
    NRRoom *r=(__bridge NRRoom*)handle;
    if (output>1) return NULL;
    @synchronized(r->_commitGate[output]) {
        if (r->_profileGeneration[output]!=generation || !r->_profileResult[output]) return NULL;
        NSData *data=[NSJSONSerialization dataWithJSONObject:r->_profileResult[output] options:0 error:NULL];
        return data ? strndup(data.bytes,data.length) : NULL;
    }
}
