// Producer Live — AppKit/AVFoundation shim (M-L6).
// The only Objective-C in the host: creating and managing the NSView that
// hosts obs_display (A6), TCC status/requests, and default-device lookup.
// Every AppKit call is marshalled onto the main thread here, so the Rust
// engine thread can call these functions directly (§5.1).

#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMediaIO/CMIOHardware.h>
#import <SystemExtensions/SystemExtensions.h>
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
static NSVisualEffectView *find_vibrancy(NSView *content) {
    for (NSView *sub in content.subviews) {
        if ([sub isKindOfClass:[NSVisualEffectView class]]) return (NSVisualEffectView *)sub;
    }
    return nil;
}

// Real glass: the window's solid base coat becomes an NSVisualEffectView that
// blurs whatever sits behind the window. The webview stops drawing its own
// background so CSS decides, region by region, what is opaque and what shows
// the glass. Idempotent; returns 1 when the effect view is in place.
int producer_apply_window_vibrancy(void *ns_window) {
    __block int ok = 0;
    run_on_main(^{
        NSWindow *win = (__bridge NSWindow *)ns_window;
        if (!win) return;
        NSView *content = win.contentView;
        if (!content) return;
        win.opaque = NO;
        win.backgroundColor = [NSColor clearColor];
        if (!find_vibrancy(content)) {
            NSVisualEffectView *fx = [[NSVisualEffectView alloc] initWithFrame:content.bounds];
            fx.material = NSVisualEffectMaterialHUDWindow;
            fx.blendingMode = NSVisualEffectBlendingModeBehindWindow;
            fx.state = NSVisualEffectStateActive;
            // Obsidian: render the material in vibrant-dark so EVERY glass
            // pixel is dark at the source — no CSS tint layer can cover the
            // curve notches, and a tint that lives here never seams.
            fx.appearance = [NSAppearance appearanceNamed:NSAppearanceNameVibrantDark];
            fx.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
            [content addSubview:fx positioned:NSWindowBelow relativeTo:nil];
        }
        WKWebView *wk = (WKWebView *)find_webview(content);
        if (wk) {
            @try {
                [wk setValue:@NO forKey:@"drawsBackground"];
            } @catch (NSException *e) {
                (void)e;
            }
            if (@available(macOS 12.0, *)) {
                wk.underPageBackgroundColor = [NSColor clearColor];
            }
        }
        ok = 1;
    });
    return ok;
}

int producer_preview_prepare_window(void *ns_window) {
    __block int ok = 0;
    run_on_main(^{
        NSWindow *win = (__bridge NSWindow *)ns_window;
        if (!win) return;
        // A ROOM must behave exactly as it always has: preview BELOW the
        // webview, HTML (outlines, popovers) above it. Glass floats the
        // preview over the page, which buries every stage overlay — so
        // entering a room strips the effect view; Home re-applies it.
        NSVisualEffectView *fx = find_vibrancy(win.contentView);
        if (fx) [fx removeFromSuperview];
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

// ── Virtual camera: system-extension activation (R13) ──────────────────
//
// macOS installs a CoreMediaIO extension only from a notarized app, and only
// after the user approves it in System Settings. The request is asynchronous
// and its result arrives on a delegate, so activation state is a small
// state machine the UI polls rather than a call that returns an answer.
//
// 0 = unknown/idle, 1 = requested, 2 = needs user approval, 3 = active,
// 4 = failed.
static int g_vcam_state = 0;
static char g_vcam_error[512] = {0};

@interface ProducerExtensionDelegate : NSObject <OSSystemExtensionRequestDelegate>
@end

@implementation ProducerExtensionDelegate
- (OSSystemExtensionReplacementAction)request:(OSSystemExtensionRequest *)request
                  actionForReplacingExtension:(OSSystemExtensionProperties *)existing
                               withExtension:(OSSystemExtensionProperties *)ext {
    // Always take the copy inside this app bundle; a stale one from another
    // install would talk a different protocol.
    return OSSystemExtensionReplacementActionReplace;
}

- (void)requestNeedsUserApproval:(OSSystemExtensionRequest *)request {
    g_vcam_state = 2;
}

- (void)request:(OSSystemExtensionRequest *)request
    didFinishWithResult:(OSSystemExtensionRequestResult)result {
    g_vcam_state = 3;
}

- (void)request:(OSSystemExtensionRequest *)request didFailWithError:(NSError *)error {
    g_vcam_state = 4;
    snprintf(g_vcam_error, sizeof(g_vcam_error), "%s",
             error.localizedDescription.UTF8String ?: "activation failed");
}
@end

static ProducerExtensionDelegate *g_vcam_delegate = nil;

// The extension's bundle id — read from the bundle we actually ship so the
// two can never drift apart.
static NSString *producer_camera_extension_id(void) {
    NSURL *dir = [[NSBundle mainBundle] builtInPlugInsURL];
    NSURL *ext = [[[dir URLByDeletingLastPathComponent]
        URLByAppendingPathComponent:@"Library"]
        URLByAppendingPathComponent:@"SystemExtensions"];
    NSArray *items = [[NSFileManager defaultManager] contentsOfDirectoryAtURL:ext
                                                  includingPropertiesForKeys:nil
                                                                     options:0
                                                                       error:nil];
    for (NSURL *u in items) {
        if ([u.pathExtension isEqualToString:@"systemextension"]) {
            return [u.lastPathComponent stringByDeletingPathExtension];
        }
    }
    return nil;
}

void producer_vcam_activate(void) {
    run_on_main(^{
        NSString *ident = producer_camera_extension_id();
        if (!ident) {
            g_vcam_state = 4;
            snprintf(g_vcam_error, sizeof(g_vcam_error),
                     "no camera extension is bundled with this build");
            return;
        }
        if (!g_vcam_delegate) {
            g_vcam_delegate = [ProducerExtensionDelegate new];
        }
        g_vcam_state = 1;
        g_vcam_error[0] = 0;
        OSSystemExtensionRequest *req =
            [OSSystemExtensionRequest activationRequestForExtension:ident
                                                              queue:dispatch_get_main_queue()];
        req.delegate = g_vcam_delegate;
        [[OSSystemExtensionManager sharedManager] submitRequest:req];
    });
}

int producer_vcam_state(char *buf, int len) {
    if (buf && len > 0) {
        snprintf(buf, (size_t)len, "%s", g_vcam_error);
    }
    return g_vcam_state;
}

// Is the virtual camera already present as a capture device? That is the
// only proof that matters — the extension can be installed from a previous
// run with no request outstanding.
// 🔴 AVFoundation HIDES an app's own camera extension from it (deliberate:
// Apple preventing self-capture feedback). Checking through AVCaptureDevice
// therefore reports "not installed" forever inside Producer while every
// other app sees the camera fine. The CMIO C API does not filter — it is
// how OBS's plugin detects its own extension, and how we must.
int producer_vcam_installed(void) {
    CMIOObjectPropertyAddress addr = {
        kCMIOHardwarePropertyDevices,
        kCMIOObjectPropertyScopeGlobal,
        kCMIOObjectPropertyElementMain,
    };
    UInt32 size = 0;
    if (CMIOObjectGetPropertyDataSize(kCMIOObjectSystemObject, &addr, 0, NULL, &size) != 0 || size == 0)
        return 0;
    UInt32 count = size / sizeof(CMIOObjectID);
    CMIOObjectID *devices = malloc(size);
    if (!devices) return 0;
    UInt32 used = 0;
    int found = 0;
    if (CMIOObjectGetPropertyData(kCMIOObjectSystemObject, &addr, 0, NULL, size, &used, devices) == 0) {
        CMIOObjectPropertyAddress uidAddr = {
            kCMIODevicePropertyDeviceUID,
            kCMIOObjectPropertyScopeGlobal,
            kCMIOObjectPropertyElementMain,
        };
        for (UInt32 i = 0; i < count && !found; i++) {
            CFStringRef uid = NULL;
            UInt32 got = 0;
            if (CMIOObjectGetPropertyData(devices[i], &uidAddr, 0, NULL, sizeof(uid), &got, &uid) == 0 && uid) {
                // The extension's device UUID — the identity both halves share.
                if (CFStringCompare(uid, CFSTR("7626645E-4425-469E-9D8B-97E0FA59AC75"), 0) ==
                    kCFCompareEqualTo) {
                    found = 1;
                }
                CFRelease(uid);
            }
        }
    }
    free(devices);
    return found;
}

// Camera / microphone privacy panes. Needed because once a user denies a
// capture permission, -requestAccessForMediaType: NEVER prompts again — it
// silently completes with NO. Settings is the only way back, so the UI has
// to send them there rather than offering an Allow button that does nothing.
void producer_open_camera_settings(void) {
    run_on_main(^{
        NSURL *url = [NSURL
            URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"];
        [[NSWorkspace sharedWorkspace] openURL:url];
    });
}

void producer_open_mic_settings(void) {
    run_on_main(^{
        NSURL *url = [NSURL
            URLWithString:@"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"];
        [[NSWorkspace sharedWorkspace] openURL:url];
    });
}

// Default camera uniqueID (mac-avcapture requires an explicit device id, the
// same way SCK required an explicit display UUID). Returns 1 on success.
int producer_default_camera_id(char *buf, int buflen) {
    // Never default to our OWN virtual camera: the stage would capture its own
    // output (an infinite feedback loop) and hold the CMIO device open so the
    // virtual-camera output could no longer start. macOS will happily hand it
    // back as the "default" device once a real camera is denied or absent.
    AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    if (device && [device.localizedName containsString:@"Producer Virtual Camera"]) {
        device = nil;
        AVCaptureDeviceDiscoverySession *s = [AVCaptureDeviceDiscoverySession
            discoverySessionWithDeviceTypes:@[ AVCaptureDeviceTypeBuiltInWideAngleCamera,
                                               AVCaptureDeviceTypeExternal ]
                                  mediaType:AVMediaTypeVideo
                                   position:AVCaptureDevicePositionUnspecified];
        for (AVCaptureDevice *d in s.devices) {
            if (![d.localizedName containsString:@"Producer Virtual Camera"]) {
                device = d;
                break;
            }
        }
    }
    if (!device) return 0;
    const char *uid = device.uniqueID.UTF8String;
    if (!uid || (int)strlen(uid) >= buflen) return 0;
    strncpy(buf, uid, buflen);
    return 1;
}
