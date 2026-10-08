#import <AVFoundation/AVFoundation.h>
#import <objc/runtime.h>

// Adapter for the bundled OBS 32.1.2 plugin. Its preset path releases the
// device lock before startRunning, which can select a format on macOS 27.
// Install after module loading, before any sources exist. Keep the exception
// boundary on OBS's session queue; a Rust catch cannot protect this callback.
@interface NSObject (ProducerCaptureContract)
- (AVCaptureSession *)session;
- (AVCaptureDeviceInput *)deviceInput;
- (BOOL)isDeviceLocked;
@end

static IMP original_start;
static void guarded_start(id capture, SEL selector) {
    AVCaptureSession *session = [capture session];
    AVCaptureDevice *device = [[capture deviceInput] device];
    if (!session || !device || session.running) return;
    BOOL acquired = NO;
    @try {
        if (![capture isDeviceLocked]) {
            NSError *error = nil;
            acquired = [device lockForConfiguration:&error];
            if (!acquired) {
                NSLog(@"[Producer camera] Startup deferred: %@", error);
                return;
            }
        }
        ((void (*)(id, SEL))original_start)(capture, selector);
    } @catch (NSException *exception) {
        // Leave this camera unavailable, instead of terminating the room.
        // A subsequent device selection recreates the capture session.
        NSLog(@"[Producer camera] Capture startup failed: %@: %@",
              exception.name, exception.reason);
    } @finally {
        // Preserve a lock owned by OBS's manual-format configuration path.
        if (acquired) [device unlockForConfiguration];
    }
}

int producer_capture_guard_install(void) {
    Class cls = NSClassFromString(@"OBSAVCapture");
    SEL start = NSSelectorFromString(@"startCaptureSession");
    Method method = class_getInstanceMethod(cls, start);
    if (!method || !class_getInstanceMethod(cls, @selector(session)) ||
        !class_getInstanceMethod(cls, @selector(deviceInput)) ||
        !class_getInstanceMethod(cls, @selector(isDeviceLocked))) return 0;
    if (!original_start) original_start = method_setImplementation(method, (IMP)guarded_start);
    return 1;
}
