// Producer Live — AppKit/AVFoundation shim (M-L6).
// The only Objective-C in the host: creating and managing the NSView that
// hosts obs_display (A6), TCC status/requests, and default-device lookup.
// Every AppKit call is marshalled onto the main thread here, so the Rust
// engine thread can call these functions directly (§5.1).

#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>

static void run_on_main(void (^block)(void)) {
    if ([NSThread isMainThread]) {
        block();
    } else {
        dispatch_sync(dispatch_get_main_queue(), block);
    }
}

// Convert a top-left-origin CSS-point rect (webview coordinates) into an
// AppKit bottom-left frame within the window's content view.
static NSRect frame_from_css(NSView *content, double x, double y, double w, double h) {
    double ch = content.bounds.size.height;
    return NSMakeRect(x, ch - y - h, w, h);
}

// Returns a retained NSView* (as void*) added above the webview; writes the
// backing pixel size (for obs_display) into out_px_w/out_px_h.
void *producer_preview_attach(void *ns_window, double x, double y, double w, double h,
                              double *out_px_w, double *out_px_h) {
    __block NSView *view = nil;
    run_on_main(^{
        NSWindow *win = (__bridge NSWindow *)ns_window;
        NSView *content = win.contentView;
        if (!content) return;
        view = [[NSView alloc] initWithFrame:frame_from_css(content, x, y, w, h)];
        view.wantsLayer = YES;
        view.layer.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
        [content addSubview:view positioned:NSWindowAbove relativeTo:nil];
        double scale = win.backingScaleFactor > 0 ? win.backingScaleFactor : 1.0;
        *out_px_w = w * scale;
        *out_px_h = h * scale;
    });
    return view ? (void *)CFBridgingRetain(view) : NULL;
}

void producer_preview_set_frame(void *view_ptr, double x, double y, double w, double h,
                                double *out_px_w, double *out_px_h) {
    run_on_main(^{
        NSView *view = (__bridge NSView *)view_ptr;
        NSView *content = view.superview;
        if (!content) return;
        view.frame = frame_from_css(content, x, y, w, h);
        double scale = view.window.backingScaleFactor > 0 ? view.window.backingScaleFactor : 1.0;
        *out_px_w = w * scale;
        *out_px_h = h * scale;
    });
}

void producer_preview_detach(void *view_ptr) {
    run_on_main(^{
        NSView *view = (__bridge NSView *)view_ptr;
        [view removeFromSuperview];
    });
    CFBridgingRelease(view_ptr);
}

// media_type: 0 = camera (video), 1 = microphone (audio).
// Returns AVAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied,
// 3 authorized. Thread-safe, no main-thread hop needed.
int producer_av_authorization_status(int media_type) {
    AVMediaType t = media_type == 0 ? AVMediaTypeVideo : AVMediaTypeAudio;
    return (int)[AVCaptureDevice authorizationStatusForMediaType:t];
}

// Fires the system permission prompt (async; result lands in TCC).
void producer_av_request_access(int media_type) {
    AVMediaType t = media_type == 0 ? AVMediaTypeVideo : AVMediaTypeAudio;
    [AVCaptureDevice requestAccessForMediaType:t completionHandler:^(BOOL granted){ (void)granted; }];
}

int producer_screen_capture_preflight(void) {
    return CGPreflightScreenCaptureAccess() ? 1 : 0;
}

void producer_screen_capture_request(void) {
    CGRequestScreenCaptureAccess();
}

// On-screen window list for the window-capture overlay (M-L7 escape hatch,
// LIVE-REVIEW.md D1). JSON array of {id, owner, title} written into buf.
// Window titles are only populated when Screen Recording is granted.
int producer_list_windows(char *buf, int buflen) {
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!list) return 0;
    NSMutableArray *out = [NSMutableArray array];
    for (NSDictionary *info in (__bridge NSArray *)list) {
        NSNumber *layer = info[(id)kCGWindowLayer];
        NSNumber *wid = info[(id)kCGWindowNumber];
        NSString *owner = info[(id)kCGWindowOwnerName] ?: @"";
        NSString *title = info[(id)kCGWindowName] ?: @"";
        if (layer.intValue != 0 || !wid) continue;
        if (owner.length == 0 && title.length == 0) continue;
        [out addObject:@{@"id": wid, @"owner": owner, @"title": title}];
    }
    CFRelease(list);
    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    if (!json || (int)json.length >= buflen) return 0;
    memcpy(buf, json.bytes, json.length);
    buf[json.length] = 0;
    return 1;
}

// Default camera uniqueID (mac-avcapture requires an explicit device id, the
// same way SCK required an explicit display UUID). Returns 1 on success.
int producer_default_camera_id(char *buf, int buflen) {
    AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    if (!device) return 0;
    const char *uid = device.uniqueID.UTF8String;
    if (!uid || (int)strlen(uid) >= buflen) return 0;
    strncpy(buf, uid, buflen);
    return 1;
}
