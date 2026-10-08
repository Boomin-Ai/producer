#import <AVFoundation/AVFoundation.h>
#include <assert.h>
extern int producer_capture_guard_install(void);

@interface GuardDevice : NSObject
@property BOOL deny;
@property int locks;
@property int unlocks;
@end
@implementation GuardDevice
- (BOOL)lockForConfiguration:(NSError **)error { self.locks++; return !self.deny; }
- (void)unlockForConfiguration { self.unlocks++; }
@end
@interface GuardInput : NSObject
@property GuardDevice *device;
@end
@implementation GuardInput
@end
@interface GuardSession : NSObject
@property (getter=isRunning) BOOL running;
@property BOOL throws;
@property int starts;
- (void)startRunning;
@end
@implementation GuardSession
- (void)startRunning {
    self.starts++;
    if (self.throws) [NSException raise:NSGenericException format:@"format lock failed"];
    self.running = YES;
}
@end
@interface OBSAVCapture : NSObject
@property GuardSession *session;
@property GuardInput *deviceInput;
@property BOOL isDeviceLocked;
- (void)startCaptureSession;
@end
@implementation OBSAVCapture
- (void)startCaptureSession { [self.session startRunning]; }
@end

int main(void) {
    @autoreleasepool {
        assert(producer_capture_guard_install());
        assert(producer_capture_guard_install());
        OBSAVCapture *capture = [OBSAVCapture new];
        capture.session = [GuardSession new];
        capture.deviceInput = [GuardInput new];
        capture.deviceInput.device = [GuardDevice new];
        GuardDevice *device = capture.deviceInput.device;
        device.deny = YES;
        [capture startCaptureSession];
        assert(capture.session.starts == 0 && device.unlocks == 0);
        device.deny = NO;
        capture.session.throws = YES;
        [capture startCaptureSession];
        assert(capture.session.starts == 1 && device.unlocks == 1);
        capture.session.throws = NO;
        [capture startCaptureSession];
        assert(capture.session.running && device.unlocks == 2);
        [capture startCaptureSession];
        assert(capture.session.starts == 2);
        capture.session.running = NO;
        capture.isDeviceLocked = YES;
        [capture startCaptureSession];
        assert(device.locks == 3 && device.unlocks == 2);
        puts("PASS lock failure, exception containment, successful retry, idempotent install/start, preserved OBS lock");
    }
}
