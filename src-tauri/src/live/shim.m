// Producer Live — AppKit/AVFoundation shim (M-L6).
// The only Objective-C in the host: creating and managing the NSView that
// hosts obs_display (A6), TCC status/requests, and default-device lookup.
// Every AppKit call is marshalled onto the main thread here, so the Rust
// engine thread can call these functions directly (§5.1).

#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <WebKit/WebKit.h>

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

static NSView *find_webview(NSView *v) {
    // wry wraps WKWebView in its own subclass, so match the class TREE.
    if ([v isKindOfClass:[WKWebView class]]) return v;
    for (NSView *sub in v.subviews) {
        NSView *hit = find_webview(sub);
        if (hit) return hit;
    }
    return nil;
}

// The preview lives UNDER the webview so HTML (menus, dialogs, banners) can
// float over the stage the way it does over anything else. That only works
// if the webview stops painting its own opaque background — then the window
// itself provides the app's base color and the preview shows through the
// transparent hole the room's CSS leaves for it.
int producer_preview_prepare_window(void *ns_window) {
    __block int ok = 0;
    run_on_main(^{
        NSWindow *win = (__bridge NSWindow *)ns_window;
        if (!win) return;
        win.opaque = YES;
        win.backgroundColor = [NSColor colorWithSRGBRed:1.0 / 255.0
                                                  green:6.0 / 255.0
                                                   blue:16.0 / 255.0
                                                  alpha:1.0];
        WKWebView *wk = (WKWebView *)find_webview(win.contentView);
        if (wk) {
            @try {
                [wk setValue:@NO forKey:@"drawsBackground"];
                ok = 1;
            } @catch (NSException *e) {
                (void)e; // WebKit changed: caller keeps the opaque path
            }
            if (@available(macOS 12.0, *)) {
                wk.underPageBackgroundColor = [NSColor clearColor];
            }
        }
    });
    return ok;
}

// Returns a retained NSView* (as void*) added BELOW the webview; writes the
// backing pixel size (for obs_display) into out_px_w/out_px_h.
void *producer_preview_attach(void *ns_window, double x, double y, double w, double h,
                              int below_webview, double *out_px_w, double *out_px_h) {
    __block NSView *view = nil;
    run_on_main(^{
        NSWindow *win = (__bridge NSWindow *)ns_window;
        NSView *content = win.contentView;
        if (!content) return;
        view = [[NSView alloc] initWithFrame:frame_from_css(content, x, y, w, h)];
        view.wantsLayer = YES;
        view.layer.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
        view.layer.cornerRadius = 8; // the stage canvas is a rounded card
        view.layer.masksToBounds = YES;
        [content addSubview:view
                 positioned:(below_webview ? NSWindowBelow : NSWindowAbove)
                 relativeTo:nil];
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

// Popovers and menus are HTML, and the preview NSView sits ABOVE the
// webview — so anything the UI floats over the stage would be hidden by it.
// The room hides the preview for as long as a menu is open.
void producer_preview_set_hidden(void *view_ptr, int hidden) {
    run_on_main(^{
        NSView *view = (__bridge NSView *)view_ptr;
        view.hidden = hidden ? YES : NO;
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

// ── First Light onboarding: Screen Recording drag chip ──────────────────────
// macOS never lets an app add ITSELF to Screen & System Audio Recording; the
// user must add it. The smoothest gesture is dragging the app into the list,
// so we float a small always-on-top chip carrying the app bundle's file URL —
// dropping it on the Privacy list registers the app, same as a Finder drag.

@interface ProducerDragChipView : NSView <NSDraggingSource>
@end

@implementation ProducerDragChipView

- (void)mouseDown:(NSEvent *)event {
    (void)event; // drag starts on movement; a bare click does nothing
}

- (void)mouseDragged:(NSEvent *)event {
    NSURL *bundle = [[NSBundle mainBundle] bundleURL];
    NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:bundle];
    NSImage *icon = [[NSWorkspace sharedWorkspace] iconForFile:bundle.path];
    NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
    NSRect frame = NSMakeRect(p.x - 32, p.y - 32, 64, 64);
    [item setDraggingFrame:frame contents:icon];
    [self beginDraggingSessionWithItems:@[ item ] event:event source:self];
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    (void)session;
    (void)context;
    return NSDragOperationCopy | NSDragOperationGeneric | NSDragOperationLink;
}

@end

static NSPanel *g_drag_chip = nil;

void producer_drag_chip_show(void) {
    run_on_main(^{
        if (g_drag_chip) {
            [g_drag_chip orderFrontRegardless];
            return;
        }
        const CGFloat W = 380, H = 96;
        NSScreen *screen = [NSScreen mainScreen];
        NSRect sf = screen ? screen.visibleFrame : NSMakeRect(0, 0, 1200, 800);
        NSRect frame = NSMakeRect(NSMidX(sf) - W / 2, sf.origin.y + 96, W, H);
        NSPanel *panel = [[NSPanel alloc]
            initWithContentRect:frame
                      styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                        backing:NSBackingStoreBuffered
                          defer:NO];
        panel.level = NSStatusWindowLevel; // above System Settings
        panel.opaque = NO;
        panel.backgroundColor = [NSColor clearColor];
        panel.hasShadow = YES;
        panel.movableByWindowBackground = NO;
        panel.collectionBehavior =
            NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;

        NSView *root = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, W, H)];
        root.wantsLayer = YES;
        root.layer.backgroundColor =
            [[NSColor colorWithCalibratedWhite:0.09 alpha:0.97] CGColor];
        root.layer.cornerRadius = 18;
        panel.contentView = root;

        NSTextField *title = [NSTextField labelWithString:@"Drag Producer into the list to allow Screen Recording"];
        title.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
        title.textColor = [NSColor colorWithCalibratedWhite:0.72 alpha:1.0];
        title.frame = NSMakeRect(16, H - 28, W - 32, 16);
        [root addSubview:title];

        ProducerDragChipView *row =
            [[ProducerDragChipView alloc] initWithFrame:NSMakeRect(12, 12, W - 24, H - 44)];
        row.wantsLayer = YES;
        row.layer.backgroundColor = [[NSColor colorWithCalibratedWhite:0.16 alpha:1.0] CGColor];
        row.layer.cornerRadius = 12;
        [root addSubview:row];

        NSImage *icon = [[NSWorkspace sharedWorkspace] iconForFile:[[NSBundle mainBundle] bundlePath]];
        NSImageView *iv = [NSImageView imageViewWithImage:icon];
        iv.frame = NSMakeRect(10, (row.frame.size.height - 32) / 2, 32, 32);
        [row addSubview:iv];

        NSTextField *name = [NSTextField labelWithString:@"Producer"];
        name.font = [NSFont systemFontOfSize:15 weight:NSFontWeightSemibold];
        name.textColor = [NSColor whiteColor];
        name.frame = NSMakeRect(52, (row.frame.size.height - 20) / 2, 160, 20);
        [row addSubview:name];

        NSTextField *hint = [NSTextField labelWithString:@"drag me"];
        hint.font = [NSFont systemFontOfSize:12 weight:NSFontWeightRegular];
        hint.textColor = [NSColor colorWithCalibratedRed:0.24 green:0.86 blue:0.65 alpha:1.0];
        hint.alignment = NSTextAlignmentRight;
        hint.frame = NSMakeRect(row.frame.size.width - 110, (row.frame.size.height - 16) / 2, 96, 16);
        [row addSubview:hint];

        g_drag_chip = panel;
        [panel orderFrontRegardless];
    });
}

void producer_drag_chip_hide(void) {
    run_on_main(^{
        if (!g_drag_chip) return;
        [g_drag_chip orderOut:nil];
        g_drag_chip = nil;
    });
}

// Opens System Settings directly on the Screen & System Audio Recording pane.
void producer_open_screen_settings(void) {
    run_on_main(^{
        NSURL *url = [NSURL
            URLWithString:
                @"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"];
        [[NSWorkspace sharedWorkspace] openURL:url];
    });
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
