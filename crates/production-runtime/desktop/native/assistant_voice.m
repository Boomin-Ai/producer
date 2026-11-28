// Private operator audio. The studio engine never receives these playback buffers.
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>

@interface ProducerVoice : NSObject
@property NSURLSessionWebSocketTask *socket;
@property AVAudioEngine *engine;
@property AVAudioPlayerNode *player;
@property NSMutableArray<NSString *> *events;
@property BOOL stopped;
@property BOOL tapped;
@property BOOL ready;
@property int outstanding;
@end

@implementation ProducerVoice
- (void)emit:(NSDictionary *)event {
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    if (bytes) @synchronized(self.events) {
        [self.events addObject:[[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding]];
    }
}
- (void)stop {
    if (self.stopped) return;
    self.stopped = YES;
    if (self.tapped) [self.engine.inputNode removeTapOnBus:0];
    [self.engine stop];
    NSURLSessionWebSocketTask *socket = self.socket;
    if (self.ready && socket.state == NSURLSessionTaskStateRunning) {
        [socket sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:@"{\"type\":\"session.close\"}"] completionHandler:^(NSError *error) {}];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            [socket cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
        });
    } else [socket cancel];
}
- (void)fail:(NSString *)message {
    if (self.stopped) return;
    [self emit:@{@"type":@"failure", @"message":message}];
    [self stop];
}
- (void)send:(NSDictionary *)event {
    if (self.stopped) return;
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    NSString *json = [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding];
    [self.socket sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:json] completionHandler:^(NSError *error) {
        if (error) dispatch_async(dispatch_get_main_queue(), ^{[self fail:@"Voice connection interrupted"];});
    }];
}
- (void)startAudio {
    self.engine = [AVAudioEngine new];
    self.player = [AVAudioPlayerNode new];
    AVAudioFormat *pcm = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16 sampleRate:24000 channels:1 interleaved:NO];
    AVAudioFormat *playback = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:24000 channels:1];
    [self.engine attachNode:self.player];
    [self.engine connect:self.player to:self.engine.mainMixerNode format:playback];
    AVAudioInputNode *mic = self.engine.inputNode;
    AVAudioFormat *input = [mic outputFormatForBus:0];
    if (!input.channelCount || !input.sampleRate) { [self fail:@"Choose an available Mac microphone"]; return; }
    AVAudioConverter *converter = [[AVAudioConverter alloc] initFromFormat:input toFormat:pcm];
    if (!converter) { [self fail:@"Microphone format unavailable"]; return; }
    __weak ProducerVoice *weak = self;
    [mic installTapOnBus:0 bufferSize:1024 format:input block:^(AVAudioPCMBuffer *buffer, AVAudioTime *time) {
        @autoreleasepool {
            ProducerVoice *voice = weak;
            if (!voice || voice.stopped) return;
            AVAudioFrameCount capacity = ceil(buffer.frameLength * 24000.0 / input.sampleRate) + 32;
            AVAudioPCMBuffer *out = [[AVAudioPCMBuffer alloc] initWithPCMFormat:pcm frameCapacity:capacity];
            __block BOOL consumed = NO;
            [converter convertToBuffer:out error:nil withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount count, AVAudioConverterInputStatus *status) {
                *status = consumed ? AVAudioConverterInputStatus_NoDataNow : AVAudioConverterInputStatus_HaveData;
                if (consumed) return nil;
                consumed = YES;
                return buffer;
            }];
            if (!out.frameLength) return;
            NSData *bytes = [NSData dataWithBytes:out.int16ChannelData[0] length:out.frameLength * 2];
            dispatch_async(dispatch_get_main_queue(), ^{
                if (voice.stopped) return;
                if (voice.outstanding >= 32) { [voice fail:@"Voice connection too slow. Reconnect to Duce."]; return; }
                voice.outstanding++;
                NSDictionary *event = @{@"type":@"session.input_audio.append", @"audio":[bytes base64EncodedStringWithOptions:0]};
                NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
                [voice.socket sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]] completionHandler:^(NSError *error) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        voice.outstanding--;
                        if (error) [voice fail:@"Microphone connection interrupted"];
                    });
                }];
            });
        }
    }];
    self.tapped = YES;
    NSError *error = nil;
    if (![self.engine startAndReturnError:&error]) { [self fail:error.localizedDescription]; return; }
    [self.player play];
    [self emit:@{@"type":@"listening"}];
}
- (void)receive {
    [self.socket receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (self.stopped) return;
            if (error) { [self fail:error.localizedDescription]; return; }
            NSData *data = message.data ?: [message.string dataUsingEncoding:NSUTF8StringEncoding];
            NSDictionary *event = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
            NSString *type = event[@"type"];
            if ([type isEqual:@"session.started"]) {
                self.ready = YES;
                @try { [self startAudio]; } @catch(NSException *e) { [self fail:@"Could not start Mac audio"]; }
            } else if ([type isEqual:@"session.output_audio.delta"]) {
                NSData *bytes = [[NSData alloc] initWithBase64EncodedString:event[@"delta"] options:0];
                AVAudioFrameCount n = (AVAudioFrameCount)(bytes.length / 2);
                if (n && self.engine.running) {
                    AVAudioPCMBuffer *out = [[AVAudioPCMBuffer alloc] initWithPCMFormat:[self.player outputFormatForBus:0] frameCapacity:n];
                    out.frameLength = n;
                    const int16_t *samples = bytes.bytes;
                    for (unsigned i = 0; i < n; i++) out.floatChannelData[0][i] = samples[i] / 32768.f;
                    [self.player scheduleBuffer:out completionHandler:nil];
                }
            } else if ([type isEqual:@"error"] || [type isEqual:@"session.closed"]) {
                [self fail:event[@"error"][@"message"] ?: @"Voice session ended"];
            } else if ([type isEqual:@"response.event"] || [type hasSuffix:@"transcript.delta"]) {
                [self emit:event];
            }
            if (!self.stopped) [self receive];
        });
    }];
}
- (void)connect:(NSString *)key config:(NSDictionary *)config {
    if (self.stopped) return;
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"wss://api.openai.com/v1/live/sessions"]];
    [req setValue:[@"Bearer " stringByAppendingString:key] forHTTPHeaderField:@"Authorization"];
    self.socket = [NSURLSession.sharedSession webSocketTaskWithRequest:req];
    [self.socket resume];
    [self send:@{@"type":@"session.start", @"session":config}];
    [self receive];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (!self.ready) [self fail:@"Duce could not connect. Try again."];
    });
}
@end

void *producer_voice_open(const char *configJSON) {
    ProducerVoice *voice = [ProducerVoice new];
    voice.events = [NSMutableArray new];
    NSDictionary *config = [NSJSONSerialization JSONObjectWithData:[@(configJSON) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
        NSDictionary *query = @{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService:@"ai.boomin.producer.voice", (__bridge id)kSecAttrAccount:@"openai",
            (__bridge id)kSecReturnData:@YES};
        CFTypeRef result = NULL;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query,&result);
        NSData *bytes = CFBridgingRelease(result);
        NSString *key = bytes ? [[NSString alloc] initWithData:bytes encoding:NSUTF8StringEncoding] : nil;
        if (status != errSecSuccess || !key.length) {
            dispatch_async(dispatch_get_main_queue(), ^{[voice fail:@"OpenAI voice key unavailable in Keychain"];});
            return;
        }
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (granted) [voice connect:key config:config];
                else [voice fail:@"Allow microphone access for Producer in System Settings"];
            });
        }];
    });
    return (__bridge_retained void *)voice;
}
void producer_voice_close(void *handle) { ProducerVoice *voice = CFBridgingRelease(handle); [voice stop]; }
char *producer_voice_next(void *handle) {
    ProducerVoice *voice = (__bridge ProducerVoice *)handle;
    @synchronized(voice.events) {
        NSString *next = voice.events.firstObject;
        if (!next) return NULL;
        [voice.events removeObjectAtIndex:0];
        return strdup(next.UTF8String);
    }
}
void producer_voice_send(void *handle, const char *event) {
    ProducerVoice *voice = (__bridge ProducerVoice *)handle;
    [voice send:[NSJSONSerialization JSONObjectWithData:[@(event) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil]];
}
