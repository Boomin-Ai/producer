#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreAudio/CoreAudio.h>
#include <atomic>
#include <array>
#include <memory>
#include <vector>
#include <cmath>
#include <thread>
#include <mach/mach_time.h>
#include <mach/mach.h>
#include <pthread/qos.h>

static std::atomic<int> states_alive{0}, owners_alive{0}, notifications_alive{0};
struct LabBlock { uint64_t host_ns; int16_t samples[480]; };
// AVAudioEngine may deliver 100 ms tap batches despite bufferSize:480.
// Bound each ring to 320 ms to accommodate batches/startup; drain promptly.
// One tap produces each ring; Rust's main thread is its single consumer.
static constexpr size_t ring_capacity=32;
struct Ring {
    std::array<LabBlock,ring_capacity> blocks{};
    std::atomic<uint64_t> written{0}, read{0}, dropped{0};
    void push(const LabBlock &block) {
        auto w=written.load(std::memory_order_relaxed);
        if(w-read.load(std::memory_order_acquire)>=ring_capacity) { dropped++; return; }
        blocks[w%ring_capacity]=block; written.store(w+1,std::memory_order_release);
    }
    bool pop(LabBlock *block) {
        auto r=read.load(std::memory_order_relaxed);
        if(r==written.load(std::memory_order_acquire)) return false;
        *block=blocks[r%ring_capacity]; read.store(r+1,std::memory_order_release); return true;
    }
};
struct State {
    Ring speaker,mic;
    LabBlock speaker_partial{},mic_partial{};
    size_t speaker_fill=0,mic_fill=0;
    std::vector<float> far;
    uint64_t source_frame=0;
    mach_timebase_info_data_t timebase{};
    std::atomic<bool> stopping{false};
    std::atomic<uint64_t> callbacks{0}, errors{0}, clipped{0};
    std::atomic<uint64_t> speaker_max_frames{0}, mic_max_frames{0};
    uint32_t mic_channels=1;
    uint64_t startup_until_ns=0;
    uint64_t speaker_next_ns=0,mic_next_ns=0;
    std::atomic<uint64_t> speaker_startup_frames{0},mic_startup_frames{0};
    // First fault per I/O stream: 1=timestamp/layout, 2=buffer, 3=timeline,
    // 4=nonfinite sample, 5=post-render error, 6=engine configuration change.
    std::atomic<uint64_t> speaker_fault{0},mic_fault{0};
    void fault(bool render,uint64_t code) {
        auto &first=render?speaker_fault:mic_fault;
        uint64_t empty=0;first.compare_exchange_strong(empty,code);errors++;
    }
    State() { states_alive++; mach_timebase_info(&timebase); }
    ~State() { states_alive--; }
    uint64_t ns(uint64_t ticks) const { return (uint64_t)((__uint128_t)ticks*timebase.numer/timebase.denom); }
    // Both I/O callbacks copy only bounded Float32 PCM. The final output may
    // interleave stereo; microphone buffers remain noninterleaved. No
    // allocation, file I/O, APM or SDK calls belong on these realtime threads.
    OSStatus io(const AudioTimeStamp *time,uint32_t frames,const AudioBufferList *data,bool render) {
        callbacks++;
        auto &maximum=render?speaker_max_frames:mic_max_frames;
        if(frames>maximum.load()) maximum=frames;
        if(stopping.load()) { callbacks--; return noErr; }
        auto channels=render?2:mic_channels;
        bool interleaved=render && data && data->mNumberBuffers==1;
        auto buffers=interleaved?1:channels;
        if(!time || !(time->mFlags & kAudioTimeStampHostTimeValid) || !data ||
            !frames || frames>16384 || data->mNumberBuffers!=buffers) {
            fault(render,1); callbacks--; return kAudio_ParamError;
        }
        for(uint32_t c=0;c<buffers;c++) if(data->mBuffers[c].mNumberChannels!=(interleaved?2:1) ||
            !data->mBuffers[c].mData || data->mBuffers[c].mDataByteSize<(size_t)frames*sizeof(float)*(interleaved?2:1)) {
            fault(render,2); callbacks--; return kAudio_ParamError;
        }
        auto &part=render?speaker_partial:mic_partial;
        auto &fill=render?speaker_fill:mic_fill;
        auto &ring=render?speaker:mic;
        auto start=ns(time->mHostTime);
        auto &next=render?speaker_next_ns:mic_next_ns;
        bool continuous=!next || std::llabs((int64_t)start-(int64_t)next)<=2000000;
        next=start+(uint64_t)frames*1000000000/48000;
        // The engine's first hardware callbacks may adjust both clocks. Quarantine
        // a fixed 250 ms before accepting any PCM, never splice across that period.
        // Afterward every callback must be continuous, including block boundaries.
        if(startup_until_ns && start<startup_until_ns) {
            (render?speaker_startup_frames:mic_startup_frames)+=frames;
            callbacks--;return noErr;
        }
        if(!continuous) {fault(render,3);callbacks--;return kAudio_ParamError;}
        if(fill && std::llabs((int64_t)start-(int64_t)(part.host_ns+fill*1000000000/48000))>2000000) {
            fault(render,3); callbacks--; return kAudio_ParamError;
        }
        auto *left=(const float*)data->mBuffers[0].mData;
        auto *right=render && !interleaved?(const float*)data->mBuffers[1].mData:left;
        for(uint32_t n=0;n<frames;n++) {
            if(fill==0) part.host_ns=start+(uint64_t)n*1000000000/48000;
            float sample=render?(interleaved?(left[2*n]+left[2*n+1])*0.5f:(left[n]+right[n])*0.5f):left[n];
            if(!std::isfinite(sample)) { fault(render,4); sample=0; }
            if(std::abs(sample)>=0.999f) clipped++;
            part.samples[fill++]=(int16_t)std::lrint(std::fmax(-1.0f,std::fmin(0.999969f,sample))*32768.0f);
            if(fill==480) {ring.push(part);fill=0;}
        }
        callbacks--; return noErr;
    }
    void tap(AVAudioPCMBuffer *pcm,AVAudioTime *time,bool render) {
        callbacks++;
        auto &max_frames=render?speaker_max_frames:mic_max_frames;
        if(pcm.frameLength>max_frames.load()) max_frames=pcm.frameLength;
        if(!stopping.load()) {
            if(!time.hostTimeValid || pcm.format.sampleRate!=48000 ||
                pcm.format.commonFormat!=AVAudioPCMFormatFloat32 || pcm.format.interleaved ||
                !pcm.floatChannelData || pcm.format.channelCount<1 || (render && pcm.format.channelCount!=2)) {
                errors++;
            } else {
                auto &part=render?speaker_partial:mic_partial;
                auto &fill=render?speaker_fill:mic_fill;
                auto &ring=render?speaker:mic;
                auto start=ns(time.hostTime);
                if(fill && std::llabs((int64_t)start-(int64_t)(part.host_ns+fill*1000000000/48000))>2000000) {
                    errors++; fill=0;
                }
                for(uint32_t n=0;n<pcm.frameLength;n++) {
                    if(fill==0) part.host_ns=start+(uint64_t)n*1000000000/48000;
                    // Render channels are identical by construction. Input uses channel 0.
                    float sample=pcm.floatChannelData[0][n];
                    if(render) sample=(sample+pcm.floatChannelData[1][n])*0.5f;
                    if(!std::isfinite(sample)) { errors++; sample=0; }
                    if(std::abs(sample)>=0.999f) clipped++;
                    part.samples[fill++]=(int16_t)std::lrint(std::fmax(-1.0f,std::fmin(0.999969f,sample))*32768.0f);
                    if(fill==480) { ring.push(part); fill=0; }
                }
            }
        }
        callbacks--;
    }
};
static OSStatus rendered(void *context,AudioUnitRenderActionFlags *flags,const AudioTimeStamp *time,
    UInt32 bus,UInt32 frames,AudioBufferList *data) {
    auto *state=(State*)context;
    if(*flags & kAudioUnitRenderAction_PostRenderError) { state->fault(true,5);return noErr; }
    if((*flags & kAudioUnitRenderAction_PostRender) && bus==0) return state->io(time,frames,data,true);
    return noErr;
}
struct RenderNotification {
    AudioUnit unit=nullptr;
    State *context=nullptr;
    bool attach(AudioUnit candidate,State *state) {
        if(AudioUnitAddRenderNotify(candidate,rendered,state)!=noErr)return false;
        unit=candidate;context=state;notifications_alive++;return true;
    }
    void detach() {
        if(unit) {
            if(AudioUnitRemoveRenderNotify(unit,rendered,context)!=noErr)context->errors++;
            notifications_alive--;unit=nullptr;context=nullptr;
        }
    }
    ~RenderNotification() {detach();}
};
struct Owner {
    std::shared_ptr<State> state=std::make_shared<State>();
    AVAudioEngine *engine=nil;
    AVAudioSourceNode *source=nil;
    AVAudioSinkNode *sink=nil;
    RenderNotification notification;
    id observer=nil;
    bool mic_tap=false,speaker_tap=false;
    Owner() { owners_alive++; engine=[[AVAudioEngine alloc] init]; }
    ~Owner() {
        state->stopping=true;
        if(observer) [[NSNotificationCenter defaultCenter] removeObserver:observer];
        [engine stop];
        notification.detach();
        if(mic_tap) [engine.inputNode removeTapOnBus:0];
        if(speaker_tap) [engine.mainMixerNode removeTapOnBus:0];
        if(source) [engine detachNode:source];
        if(sink) [engine detachNode:sink];
        observer=nil; source=nil; sink=nil; engine=nil;
        owners_alive--;
    }
};
static NSString *deviceName(AudioUnit unit) {
    AudioDeviceID device=0; UInt32 size=sizeof(device);
    if(AudioUnitGetProperty(unit,kAudioOutputUnitProperty_CurrentDevice,kAudioUnitScope_Global,0,&device,&size)!=noErr) return @"Unknown device";
    CFStringRef name=nullptr;
    AudioObjectPropertyAddress address={kAudioObjectPropertyName,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    size=sizeof(name);
    if(AudioObjectGetPropertyData(device,&address,0,nullptr,&size,&name)!=noErr) return @"Unknown device";
    return CFBridgingRelease(name);
}
// Read the default output's scalar volume without changing routing or controls.
// Unsupported device controls remain unknown; this is not calibrated acoustic SPL.
extern "C" double lab_output_volume_percent() {
    AudioDeviceID device=0; UInt32 size=sizeof(device);
    AudioObjectPropertyAddress address={kAudioHardwarePropertyDefaultOutputDevice,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    if(AudioObjectGetPropertyData(kAudioObjectSystemObject,&address,0,nullptr,&size,&device)!=noErr || !device)return -1;
    double sum=0; int channels=0;
    for(UInt32 element=0;element<=2;element++) {
        address={kAudioDevicePropertyVolumeScalar,kAudioDevicePropertyScopeOutput,element};
        Float32 volume=0;size=sizeof(volume);
        if(AudioObjectHasProperty(device,&address) && AudioObjectGetPropertyData(device,&address,0,nullptr,&size,&volume)==noErr && std::isfinite(volume) && volume>=0 && volume<=1) {
            if(element==0)return volume*100.0;
            sum+=volume;channels++;
        }
    }
    return channels?sum/channels*100.0:-1;
}
extern "C" void lab_output_format_snapshot(char *message,size_t length) {
    @autoreleasepool {
        auto owner=std::make_unique<Owner>();
        AudioUnit unit=owner->engine.outputNode.audioUnit;
        AudioStreamBasicDescription input{},output{};
        UInt32 size=sizeof(input);
        auto in_status=AudioUnitGetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Input,0,&input,&size);
        size=sizeof(output);
        auto out_status=AudioUnitGetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Output,0,&output,&size);
        snprintf(message,length,"input scope bus 0: status=%d, rate=%.0f, channels=%u, bits=%u, flags=0x%x, bytes/frame=%u; output scope bus 0: status=%d, rate=%.0f, channels=%u, bits=%u, flags=0x%x, bytes/frame=%u",
            (int)in_status,input.mSampleRate,(unsigned)input.mChannelsPerFrame,(unsigned)input.mBitsPerChannel,(unsigned)input.mFormatFlags,(unsigned)input.mBytesPerFrame,
            (int)out_status,output.mSampleRate,(unsigned)output.mChannelsPerFrame,(unsigned)output.mBitsPerChannel,(unsigned)output.mFormatFlags,(unsigned)output.mBytesPerFrame);
    }
}
static void *create_audio(const int16_t *samples,size_t count,int fail_stage,bool io_callbacks,char *error,size_t length) {
    @autoreleasepool { @try {
        auto fail=[&](NSString *message)->void* { snprintf(error,length,"%s",message.UTF8String); return nullptr; };
        if(!samples || count==0 || count>48000*120) return fail(@"Expected 48 kHz mono speech, at most two minutes");
        auto owner=std::make_unique<Owner>();
        if(fail_stage==1) return fail(@"Injected failure after engine creation");
        auto state=owner->state;
        state->far.reserve(count);
        for(size_t i=0;i<count;i++) state->far.push_back((float)samples[i]/32768.0f*0.20f);
        AVAudioFormat *format=[[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:2];
        owner->source=[[AVAudioSourceNode alloc] initWithFormat:format renderBlock:^OSStatus(BOOL *silence,const AudioTimeStamp*,AVAudioFrameCount frames,AudioBufferList *data) {
            state->callbacks++;
            bool stopped=state->stopping.load();
            bool silent=true;
            if(data->mNumberBuffers!=2 || !data->mBuffers[0].mData || !data->mBuffers[1].mData || data->mBuffers[0].mDataByteSize<frames*sizeof(float) || data->mBuffers[1].mDataByteSize<frames*sizeof(float)) {
                state->errors++; state->callbacks--; return kAudio_ParamError;
            }
            for(uint32_t n=0;n<frames;n++) {
                auto frame=state->source_frame++;
                auto second=frame/48000;
                float v=(!stopped && second>=5 && second<50)?state->far[(frame-48000*5)%state->far.size()]:0;
                silent= silent && v==0;
                ((float*)data->mBuffers[0].mData)[n]=v;
                ((float*)data->mBuffers[1].mData)[n]=v;
            }
            *silence=silent; state->callbacks--; return noErr;
        }];
        [owner->engine attachNode:owner->source];
        if(io_callbacks) {
            owner->sink=[[AVAudioSinkNode alloc] initWithReceiverBlock:^OSStatus(const AudioTimeStamp *time,AVAudioFrameCount frames,const AudioBufferList *data) {
                return state->io(time,frames,data,false);
            }];
            [owner->engine attachNode:owner->sink];
        }
        if(fail_stage==2) return fail(@"Injected failure after source attachment");
        AVAudioFormat *input=[owner->engine.inputNode outputFormatForBus:0];
        AVAudioFormat *output=[owner->engine.outputNode inputFormatForBus:0];
        if(input.sampleRate!=48000 || output.sampleRate!=48000 || output.channelCount!=2 || input.channelCount<1 || owner->engine.inputNode.voiceProcessingEnabled)
            return fail(@"This first lab requires 48 kHz microphone and stereo speakers, with system voice processing disabled");
        [owner->engine connect:owner->source to:owner->engine.mainMixerNode format:format];
        [owner->engine connect:owner->engine.mainMixerNode to:owner->engine.outputNode format:output];
        owner->engine.mainMixerNode.outputVolume=1;
        if(io_callbacks) {
            if(input.commonFormat!=AVAudioPCMFormatFloat32 || input.interleaved || input.channelCount>2)
                return fail(@"I/O capture requires hardware 48 kHz noninterleaved Float32 microphone");
            state->mic_channels=input.channelCount;
            [owner->engine connect:owner->engine.inputNode to:owner->sink format:input];
            AudioUnit unit=owner->engine.outputNode.audioUnit;
            AudioStreamBasicDescription description{};UInt32 size=sizeof(description);
            if(AudioUnitGetProperty(unit,kAudioUnitProperty_StreamFormat,kAudioUnitScope_Output,0,&description,&size)!=noErr ||
                description.mSampleRate!=48000 || description.mChannelsPerFrame!=2 || description.mBitsPerChannel!=32 ||
                description.mFormatID!=kAudioFormatLinearPCM || !(description.mFormatFlags&kAudioFormatFlagIsFloat) ||
                (description.mFormatFlags&kAudioFormatFlagIsBigEndian) ||
                description.mBytesPerFrame!=((description.mFormatFlags&kAudioFormatFlagIsNonInterleaved)?4:8))
                return fail(@"I/O reference requires packed native-endian 48 kHz stereo Float32 output");
            if(!owner->notification.attach(unit,state.get()))return fail(@"Could not register final output render reference");
        } else {
            [owner->engine.inputNode installTapOnBus:0 bufferSize:480 format:input block:^(AVAudioPCMBuffer *buffer,AVAudioTime *time){ state->tap(buffer,time,false); }];
            owner->mic_tap=true;
            [owner->engine.mainMixerNode installTapOnBus:0 bufferSize:480 format:output block:^(AVAudioPCMBuffer *buffer,AVAudioTime *time){ state->tap(buffer,time,true); }];
            owner->speaker_tap=true;
        }
        owner->observer=[[NSNotificationCenter defaultCenter] addObserverForName:AVAudioEngineConfigurationChangeNotification object:owner->engine queue:nil usingBlock:^(NSNotification*){state->fault(true,6);}];
        snprintf(error,length,"%s → %s",deviceName(owner->engine.inputNode.audioUnit).UTF8String,deviceName(owner->engine.outputNode.audioUnit).UTF8String);
        return owner.release();
    } @catch(NSException *exception) { snprintf(error,length,"%s",exception.reason.UTF8String); return nullptr; } }
}
extern "C" void *lab_audio_create(const int16_t *samples,size_t count,int fail_stage,char *error,size_t length) {
    return create_audio(samples,count,fail_stage,false,error,length);
}
extern "C" void *lab_audio_create_io(const int16_t *samples,size_t count,int fail_stage,char *error,size_t length) {
    return create_audio(samples,count,fail_stage,true,error,length);
}
extern "C" uint64_t lab_audio_now_ns() {
    mach_timebase_info_data_t timebase{};mach_timebase_info(&timebase);
    return (uint64_t)((__uint128_t)mach_absolute_time()*timebase.numer/timebase.denom);
}
// These helpers are used only by the dedicated, disposable physical publisher
// thread. They never change the UI/network threads or hardware callback policy.
extern "C" int lab_publisher_thread_qos(int *previous,int *effective) {
    qos_class_t prior{},current{};
    int result=pthread_get_qos_class_np(pthread_self(),&prior,nullptr);
    if(result)return result;
    *previous=(int)prior;
    result=pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE,0);
    if(result)return result;
    result=pthread_get_qos_class_np(pthread_self(),&current,nullptr);
    *effective=(int)current;
    return result;
}
extern "C" int lab_publisher_wait_until_ns(uint64_t host_ns) {
    mach_timebase_info_data_t timebase{};mach_timebase_info(&timebase);
    auto ticks=(uint64_t)((__uint128_t)host_ns*timebase.denom/timebase.numer);
    return (int)mach_wait_until(ticks);
}
extern "C" int lab_audio_notifications_alive() { return notifications_alive.load(); }
extern "C" int lab_audio_start(void *handle,char *error,size_t length) {
    @autoreleasepool { @try {
        NSError *problem=nil;
        auto *owner=(Owner*)handle;
        if(owner->sink)owner->state->startup_until_ns=lab_audio_now_ns()+250000000;
        if(![((Owner*)handle)->engine startAndReturnError:&problem]) { snprintf(error,length,"%s",problem.localizedDescription.UTF8String); return 0; }
        return 1;
    } @catch(NSException *exception) { snprintf(error,length,"%s",exception.reason.UTF8String); return 0; } }
}
extern "C" int lab_audio_pop(void *handle,int render,LabBlock *block) {
    auto s=((Owner*)handle)->state;
    return (render?s->speaker:s->mic).pop(block);
}
extern "C" uint64_t lab_audio_faults(void *handle) {
    auto s=((Owner*)handle)->state;
    return s->errors+s->speaker.dropped+s->mic.dropped;
}
extern "C" void lab_audio_fault_detail(void *handle,char *message,size_t length) {
    auto s=((Owner*)handle)->state;
    snprintf(message,length,"native errors=%llu, speaker overflow=%llu, microphone overflow=%llu (capacity=%zu blocks), first speaker/mic fault=%llu/%llu",
        (unsigned long long)s->errors.load(),(unsigned long long)s->speaker.dropped.load(),
        (unsigned long long)s->mic.dropped.load(),ring_capacity,
        (unsigned long long)s->speaker_fault.load(),(unsigned long long)s->mic_fault.load());
}
extern "C" int lab_audio_close(void *handle,uint64_t *stats) {
    auto *owner=(Owner*)handle;
    auto s=owner->state;
    std::weak_ptr<State> weak=s;
    @autoreleasepool { delete owner; }
    for(int i=0;i<500 && s->callbacks.load()!=0;i++) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    stats[0]=s->speaker.written;stats[1]=s->speaker.read;stats[2]=s->speaker.dropped;
    stats[3]=s->mic.written;stats[4]=s->mic.read;stats[5]=s->mic.dropped;
    stats[6]=s->callbacks;stats[7]=s->errors;stats[8]=s->clipped;
    stats[9]=s->speaker_max_frames;stats[10]=s->mic_max_frames;
    stats[11]=s->speaker_fault;stats[12]=s->mic_fault;
    stats[13]=s->speaker_startup_frames;stats[14]=s->mic_startup_frames;
    s.reset();
    return weak.expired() && owners_alive==0 && notifications_alive==0;
}
extern "C" int lab_audio_self_test() {
    for(int round=0;round<20;round++) {
        { Ring ring; LabBlock in{}; in.samples[0]=321;
          for(size_t n=0;n<ring_capacity+1;n++) {in.host_ns=n;ring.push(in);}
          LabBlock out{}; for(size_t n=0;n<ring_capacity;n++) if(!ring.pop(&out)||out.host_ns!=(uint64_t)n||out.samples[0]!=321)return 0;
          if(ring.pop(&out)||ring.dropped!=1)return 0;
        }
        { // A single 4,800-frame tap burst must fit without dropping blocks.
            Ring ring; LabBlock block{};
            for(int n=0;n<10;n++) {block.host_ns=n;ring.push(block);}
            for(int n=0;n<10;n++) if(!ring.pop(&block)||block.host_ns!=(uint64_t)n)return 0;
            if(ring.dropped || ring.written!=ring.read)return 0;
        }
        {
            Ring ring; std::atomic<bool> done{false}; bool ordered=true; uint64_t previous=0; bool first=true;
            std::thread producer([&]{ for(uint64_t n=0;n<1000;n++){LabBlock block{};block.host_ns=n;ring.push(block);} done=true; });
            LabBlock block{};
            do {
                while(ring.pop(&block)) { if(!first && block.host_ns<=previous)ordered=false;previous=block.host_ns;first=false; }
                std::this_thread::yield();
            } while(!done.load() || ring.written.load()!=ring.read.load());
            producer.join();
            if(!ordered || ring.written+ring.dropped!=1000 || ring.written!=ring.read)return 0;
        }
        for(int stage=1;stage<=2;stage++) {
            int16_t pcm[480]={}; char error[256]={};
            if(lab_audio_create(pcm,480,stage,error,sizeof(error)) || states_alive || owners_alive) return 0;
            if(lab_audio_create_io(pcm,480,stage,error,sizeof(error)) || states_alive || owners_alive || notifications_alive)return 0;
        }
        { // Startup clock adjustments never become accepted PCM; later gaps fail
          // even when the previous callback ended at a full 480-frame boundary.
            State state;
            std::array<float,480> pcm{};
            AudioBufferList mono={1,{{1,sizeof(pcm),pcm.data()}}};
            auto first=mach_absolute_time();state.startup_until_ns=state.ns(first)+250000000;
            for(uint64_t ms:{0,100,240,250,260,280}) {
                AudioTimeStamp time{};time.mFlags=kAudioTimeStampHostTimeValid;
                time.mHostTime=first+(uint64_t)((__uint128_t)ms*1000000*state.timebase.denom/state.timebase.numer);
                auto result=state.io(&time,480,&mono,false);
                if((ms==280 && result!=kAudio_ParamError) || (ms!=280 && result!=noErr))return 0;
            }
            if(state.mic_startup_frames!=1440 || state.mic.written!=2 ||
                state.mic_fault!=3 || state.errors!=1 || state.callbacks)return 0;
        }
        { // Exercise actual AudioUnit notification registration without hardware
          // capture, then copy 512-frame callbacks into contiguous 10 ms PCM.
            auto state=std::make_shared<State>();std::weak_ptr<State> weak=state;
            AudioComponentDescription description={kAudioUnitType_Mixer,kAudioUnitSubType_MultiChannelMixer,kAudioUnitManufacturer_Apple,0,0};
            AudioUnit unit=nullptr;
            if(AudioComponentInstanceNew(AudioComponentFindNext(nullptr,&description),&unit)!=noErr)return 0;
            bool good=true;
            {
                RenderNotification registration;
                if(!registration.attach(unit,state.get()))good=false;
                std::array<float,512> left{},right{};left.fill(.25f);right.fill(.75f);
                std::array<float,1024> packed{};
                for(size_t n=0;n<512;n++){packed[2*n]=.25f;packed[2*n+1]=.75f;}
                AudioBufferList interleaved={1,{{2,sizeof(packed),packed.data()}}};
                struct {UInt32 count;AudioBuffer buffers[2];} stereo={2,{{1,sizeof(left),left.data()},{1,sizeof(right),right.data()}}};
                AudioBufferList mono={1,{{1,sizeof(left),left.data()}}};
                auto first=mach_absolute_time();
                for(uint64_t n=0;n<4;n++) {
                    AudioTimeStamp time{};time.mFlags=kAudioTimeStampHostTimeValid;
                    time.mHostTime=first+(uint64_t)((__uint128_t)n*512*1000000000*state->timebase.denom/(48000*state->timebase.numer));
                    AudioUnitRenderActionFlags flags=kAudioUnitRenderAction_PostRender;
                    if(rendered(state.get(),&flags,&time,0,512,(n%2?&interleaved:(AudioBufferList*)&stereo))!=noErr || state->io(&time,512,&mono,false)!=noErr)good=false;
                }
                for(bool render:{false,true}) {
                    auto &ring=render?state->speaker:state->mic;LabBlock block{};uint64_t previous=0;
                    for(int n=0;n<4;n++) {
                        if(!ring.pop(&block)) {good=false;break;}
                        if(n && std::llabs((int64_t)(block.host_ns-previous)-10000000)>3)good=false;
                        for(auto sample:block.samples)if(sample!=(render?16384:8192))good=false;
                        previous=block.host_ns;
                    }
                    if(ring.written!=4 || ring.read!=4 || ring.dropped)good=false;
                }
                if(state->callbacks || state->errors || state->speaker_max_frames!=512 || state->mic_max_frames!=512)good=false;
                // Partial/error exit still removes the registration.
                AudioUnitRenderActionFlags flags=kAudioUnitRenderAction_PostRenderError;
                if(rendered(state.get(),&flags,nullptr,0,0,nullptr)!=noErr || state->errors!=1 || state->speaker_fault!=5)good=false;
            }
            if(notifications_alive || AudioComponentInstanceDispose(unit)!=noErr)good=false;
            state.reset();
            if(!good || !weak.expired() || states_alive || owners_alive)return 0;
        }
    }
    return 1;
}

static std::atomic<int> event{0};
@interface LabControls : NSObject <NSWindowDelegate>
@property NSWindow *window;
@property NSTextField *status;
@end
@implementation LabControls
- (void)start:(id)sender { event=1; }
- (void)stop:(id)sender { event=2; }
- (BOOL)windowShouldClose:(NSWindow*)sender { event=3; return YES; }
@end
static LabControls *controls;
extern "C" void lab_ui_open() {
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular]; [NSApp finishLaunching];
    controls=[LabControls new];
    controls.window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,740,300) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
    controls.window.title=@"Producer Speakerphone Lab";controls.window.delegate=controls;
    NSTextField *instructions=[NSTextField wrappingLabelWithString:@"Exit other Producer rooms and stop other audio. Use built-in speakers and microphone; disconnect headphones. Start at 50% system volume.\n0–5 s: stay quiet. 5–30 s: hear the clip, stay quiet. 30–50 s: talk over it. 50–60 s: talk while the clip is silent.\nThis records locally. Microphone audio is never played back or published."];
    instructions.frame=NSMakeRect(24,155,692,115);[controls.window.contentView addSubview:instructions];
    controls.status=[NSTextField wrappingLabelWithString:@"Ready. Voice refinement active. Click Start when prepared."];controls.status.font=[NSFont systemFontOfSize:17 weight:NSFontWeightSemibold];controls.status.frame=NSMakeRect(24,75,692,70);[controls.window.contentView addSubview:controls.status];
    for(int n=0;n<2;n++) {
        NSButton *button=[NSButton buttonWithTitle:n?@"Stop":@"Start 60-second test" target:controls action:n?@selector(stop:):@selector(start:)];
        button.frame=NSMakeRect(24+n*220,24,200,36);[controls.window.contentView addSubview:button];
    }
    [controls.window center];[controls.window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];
}
extern "C" int lab_ui_poll() {
    @autoreleasepool {
        NSEvent *next;
        for(int count=0;count<16 && (next=[NSApp nextEventMatchingMask:NSEventMaskAny untilDate:[NSDate dateWithTimeIntervalSinceNow:0.001] inMode:NSDefaultRunLoopMode dequeue:YES]);count++) [NSApp sendEvent:next];
        [NSApp updateWindows];return event.exchange(0);
    }
}
extern "C" void lab_ui_status(const char *text) { controls.status.stringValue=[NSString stringWithUTF8String:text]; }
extern "C" int lab_permission(int request) {
    auto status=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if(status==AVAuthorizationStatusAuthorized)return 1;
    if(status==AVAuthorizationStatusNotDetermined && request) [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL){}];
    return status==AVAuthorizationStatusNotDetermined?0:-1;
}
